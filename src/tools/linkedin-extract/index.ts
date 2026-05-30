// linkedin-extract — fetch a single LinkedIn job posting and persist it.
//
// LinkedIn exposes a public, login-free view at
//   https://www.linkedin.com/jobs/view/<id>
// which carries a JSON-LD JobPosting block with title, description, company,
// location, salary, datePosted, etc. We also try the lighter guest endpoint
//   https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<id>
// which returns an HTML fragment when the main URL hits a wall.
//
// jobIds are namespaced `linkedin:<numeric>` to avoid collision with SEEK
// (which uses bare numeric IDs).
import type { Page } from 'playwright';
import { callJson } from '../../shared/llm/client.js';
import { createLogger } from '../../shared/logger.js';
import { withBrowser } from '../../shared/browser/session.js';
import { db } from '../../shared/db/store.js';
import type { Job } from '../../shared/db/types.js';

const log = createLogger('linkedin-extract');

export type ExtractOptions = {
  noLlm?: boolean;
  noStore?: boolean;
  reextract?: boolean;
  /** Reuse an already-open live page instead of a throwaway browser (anti-bot). */
  page?: Page;
};

export const LINKEDIN_JOB_ID_PREFIX = 'linkedin:';

export function extractLinkedInJobIdFromUrl(url: string): string {
  // Forms seen in the wild:
  //   /jobs/view/3927464923
  //   /jobs/view/some-role-at-acme-3927464923
  //   ?currentJobId=3927464923
  const direct = url.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})/);
  if (direct && direct[1]) return `${LINKEDIN_JOB_ID_PREFIX}${direct[1]}`;
  const param = url.match(/[?&]currentJobId=(\d{6,})/);
  if (param && param[1]) return `${LINKEDIN_JOB_ID_PREFIX}${param[1]}`;
  const tail = url.match(/(\d{8,})/);
  if (tail && tail[1]) return `${LINKEDIN_JOB_ID_PREFIX}${tail[1]}`;
  return `${LINKEDIN_JOB_ID_PREFIX}${url}`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type JsonLdJobPosting = {
  '@type'?: string | string[];
  '@graph'?: Array<Record<string, unknown>>;
  title?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string | string[];
  industry?: string | string[];
  baseSalary?: {
    currency?: string;
    value?: { minValue?: number; maxValue?: number; unitText?: string; value?: number };
  };
  hiringOrganization?: { name?: string } | string;
  jobLocation?:
    | { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string | { name?: string } } }
    | Array<{
        address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string | { name?: string } };
      }>;
};

type PageData = {
  jsonLdRaw: string[];
  visibleText: string;
  title: string;
};

async function readPageData(page: Page): Promise<PageData> {
  return page.evaluate(() => {
    const jsonLdNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const jsonLdRaw = jsonLdNodes.map((n) => n.textContent ?? '').filter(Boolean);

    const titleEl =
      document.querySelector('.top-card-layout__title') ??
      document.querySelector('h1');
    const title = titleEl?.textContent?.trim() ?? document.title ?? '';

    const desc =
      document.querySelector('.show-more-less-html__markup') ??
      document.querySelector('.description__text') ??
      document.querySelector('main') ??
      document.body;
    const visibleText = (desc as HTMLElement).innerText?.slice(0, 14000) ?? '';

    return { jsonLdRaw, visibleText, title };
  });
}

function findJobPosting(jsonLdRaw: string[]): JsonLdJobPosting | null {
  for (const raw of jsonLdRaw) {
    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        const t = (c as JsonLdJobPosting)['@type'];
        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
          return c as JsonLdJobPosting;
        }
        const graph = (c as JsonLdJobPosting)['@graph'];
        if (Array.isArray(graph)) {
          for (const g of graph) {
            const gt = (g as Record<string, unknown>)['@type'];
            if (gt === 'JobPosting' || (Array.isArray(gt) && gt.includes('JobPosting'))) {
              return g as JsonLdJobPosting;
            }
          }
        }
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

function locationFromJsonLd(jp: JsonLdJobPosting): string | null {
  const loc = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation;
  if (!loc?.address) return null;
  const a = loc.address;
  const country = typeof a.addressCountry === 'string' ? a.addressCountry : a.addressCountry?.name;
  return [a.addressLocality, a.addressRegion, country].filter(Boolean).join(', ') || null;
}

function companyFromJsonLd(jp: JsonLdJobPosting): string | null {
  const h = jp.hiringOrganization;
  if (!h) return null;
  if (typeof h === 'string') return h;
  return h.name ?? null;
}

function workTypeFromJsonLd(jp: JsonLdJobPosting): string | null {
  const et = jp.employmentType;
  if (!et) return null;
  return Array.isArray(et) ? et.join(', ') : et;
}

function classificationFromJsonLd(jp: JsonLdJobPosting): string | null {
  const ind = jp.industry;
  if (!ind) return null;
  return Array.isArray(ind) ? ind.join(', ') : ind;
}

function salaryFromJsonLd(jp: JsonLdJobPosting): string | null {
  const bs = jp.baseSalary;
  if (!bs) return null;
  const v = bs.value ?? {};
  const min = v.minValue ?? v.value;
  const max = v.maxValue ?? v.value;
  const unit = v.unitText ? ` per ${v.unitText.toLowerCase()}` : '';
  const cur = bs.currency ?? '';
  if (min != null && max != null && min !== max) return `${cur} ${min}–${max}${unit}`.trim();
  if (min != null) return `${cur} ${min}${unit}`.trim();
  if (max != null) return `${cur} ${max}${unit}`.trim();
  return null;
}

type LlmExtraction = {
  title: string | null;
  company: string | null;
  location: string | null;
  workType: string | null;
  classification: string | null;
  description: string | null;
};

async function llmExtract(visibleText: string, title: string): Promise<LlmExtraction | null> {
  try {
    const out = await callJson<Partial<LlmExtraction>>({
      step: 'linkedin-extract:fallback',
      systemPrompt: 'You extract structured data from job listings. Output strict JSON.',
      userPrompt: `Extract LinkedIn job posting fields from the page text below. Return a JSON object with keys: title, company, location, workType, classification, description (plain text). Use null for unknowns.\n\nPAGE TITLE: ${title}\n\nPAGE TEXT:\n${visibleText}`,
    });
    return {
      title: out.title ?? null,
      company: out.company ?? null,
      location: out.location ?? null,
      workType: out.workType ?? null,
      classification: out.classification ?? null,
      description: out.description ?? null,
    };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'linkedin-extract: LLM fallback failed');
    return null;
  }
}

/** Strip click-tracking query params, keep the canonical `/jobs/view/<id>`. */
function canonicalLinkedInUrl(input: string): string {
  const m = input.match(/(\d{6,})/);
  if (m && m[1]) return `https://www.linkedin.com/jobs/view/${m[1]}`;
  return input.split('?')[0] ?? input;
}

async function extractOnPage(page: Page, url: string, opts: ExtractOptions): Promise<Job> {
  const canonicalUrl = canonicalLinkedInUrl(url);
  const jobId = extractLinkedInJobIdFromUrl(canonicalUrl);
  log.info({ jobId, url: canonicalUrl }, 'linkedin-extract: navigating');

  const navStart = Date.now();
  await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  log.debug({ jobId, ms: Date.now() - navStart }, 'linkedin-extract: DOM ready');

  await page
    .waitForSelector('script[type="application/ld+json"], .top-card-layout__title, .description__text', {
      timeout: 15_000,
    })
    .catch(() => null);

  const data = await readPageData(page);
  const jsonLd = findJobPosting(data.jsonLdRaw);

  let title = jsonLd?.title ?? data.title;
  const descriptionHtml = jsonLd?.description ?? null;
  let description = descriptionHtml ? htmlToText(descriptionHtml) : '';
  let company = companyFromJsonLd(jsonLd ?? {});
  let location = locationFromJsonLd(jsonLd ?? {});
  let workType = workTypeFromJsonLd(jsonLd ?? {});
  let classification = classificationFromJsonLd(jsonLd ?? {});
  const salary = salaryFromJsonLd(jsonLd ?? {});

  if (description.length < 200 && data.visibleText.length > description.length) {
    log.debug(
      { jobId, jsonLdDesc: description.length, visibleText: data.visibleText.length },
      'linkedin-extract: using visible text as description',
    );
    description = data.visibleText;
  }

  if ((!description || description.length < 50) && !opts.noLlm) {
    log.info({ jobId }, 'linkedin-extract: invoking LLM fallback');
    const llm = await llmExtract(data.visibleText, title);
    if (llm) {
      title = title || llm.title || title;
      company = company ?? llm.company;
      location = location ?? llm.location;
      workType = workType ?? llm.workType;
      classification = classification ?? llm.classification;
      if (!description && llm.description) description = llm.description;
    }
  }

  const job: Job = {
    jobId,
    source: 'linkedin',
    url: canonicalUrl,
    title: title.trim(),
    company,
    location,
    workType,
    classification,
    description,
    salaryText: salary,
    postedDate: jsonLd?.datePosted ?? null,
    fetchedAt: new Date().toISOString(),
    eligibilityFlags: [],
  };

  log.info(
    {
      jobId,
      title: job.title,
      company: job.company,
      location: job.location,
      descChars: job.description.length,
    },
    'linkedin-extract: complete',
  );

  return job;
}

export async function linkedinExtract(url: string, opts: ExtractOptions = {}): Promise<Job> {
  const jobId = extractLinkedInJobIdFromUrl(url);

  if (!opts.reextract) {
    const cached = db.getJob(jobId);
    if (cached && cached.description.length > 0) {
      log.info({ jobId }, 'linkedin-extract: returning cached job (use --reextract to refresh)');
      return cached;
    }
  }

  const job = opts.page
    ? await extractOnPage(opts.page, url, opts)
    : await withBrowser((session) => extractOnPage(session.page, url, opts));

  if (!opts.noStore) {
    db.upsertJob(job);
    log.debug({ jobId }, 'linkedin-extract: persisted to DB');
  }

  return job;
}
