// indeed-extract — fetch a single Indeed job posting and persist it.
//
// Indeed exposes job postings at:
//   https://au.indeed.com/viewjob?jk=<key>
//   https://www.indeed.com/viewjob?jk=<key>
//   https://au.indeed.com/job/<slug>-<key>            (sometimes seen)
// and links from search land on /viewjob with extra tracking params.
//
// Strategy mirrors seek/linkedin extract: try JSON-LD first (Indeed pages
// embed a JobPosting block), then __NEXT_DATA__ / window.mosaic blobs, then
// fall back to visible text. LLM rescue only when description still empty.
//
// jobIds are namespaced `indeed:<jk>` so they don't collide with SEEK's
// numeric IDs or LinkedIn's `linkedin:<numeric>`.
import type { Page } from 'playwright';
import { callJson } from '../../shared/llm/client.js';
import { createLogger } from '../../shared/logger.js';
import { withBrowser } from '../../shared/browser/session.js';
import { db } from '../../shared/db/store.js';
import type { Job } from '../../shared/db/types.js';

const log = createLogger('indeed-extract');

export type ExtractOptions = {
  noLlm?: boolean;
  noStore?: boolean;
  reextract?: boolean;
  /** Reuse an already-open live page instead of a throwaway browser (anti-bot). */
  page?: Page;
};

export const INDEED_JOB_ID_PREFIX = 'indeed:';

/** Pull the `jk` parameter (Indeed's stable job key) out of any Indeed URL. */
export function extractIndeedJobIdFromUrl(url: string): string {
  const jk = url.match(/[?&]jk=([A-Za-z0-9]+)/);
  if (jk && jk[1]) return `${INDEED_JOB_ID_PREFIX}${jk[1]}`;
  // Some Indeed permalinks use /job/<slug>-<jk> or /rc/clk?jk=…
  const tail = url.match(/-([A-Za-z0-9]{16})(?:[?#].*)?$/);
  if (tail && tail[1]) return `${INDEED_JOB_ID_PREFIX}${tail[1]}`;
  return `${INDEED_JOB_ID_PREFIX}${url}`;
}

/** Strip Indeed's tracking params, keep the canonical `viewjob?jk=<id>` form. */
export function canonicalIndeedUrl(input: string): string {
  const jk = input.match(/[?&]jk=([A-Za-z0-9]+)/);
  if (jk && jk[1]) {
    // Preserve regional host (au.indeed.com vs www.indeed.com) so subsequent
    // navigations don't get region-bounced.
    const host = (input.match(/https?:\/\/([^/]+)/)?.[1]) ?? 'au.indeed.com';
    return `https://${host}/viewjob?jk=${jk[1]}`;
  }
  return input.split('?')[0] ?? input;
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
      document.querySelector('h1.jobsearch-JobInfoHeader-title') ??
      document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"]') ??
      document.querySelector('h1');
    const title = titleEl?.textContent?.trim() ?? document.title ?? '';

    const desc =
      document.querySelector('#jobDescriptionText') ??
      document.querySelector('[data-testid="jobsearch-JobComponent-description"]') ??
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
      step: 'indeed-extract:fallback',
      systemPrompt: 'You extract structured data from job listings. Output strict JSON.',
      userPrompt: `Extract Indeed job posting fields from the page text below. Return a JSON object with keys: title, company, location, workType, classification, description (plain text). Use null for unknowns.\n\nPAGE TITLE: ${title}\n\nPAGE TEXT:\n${visibleText}`,
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
    log.warn({ err: (err as Error).message }, 'indeed-extract: LLM fallback failed');
    return null;
  }
}

async function extractOnPage(page: Page, url: string, opts: ExtractOptions): Promise<Job> {
  const canonicalUrl = canonicalIndeedUrl(url);
  const jobId = extractIndeedJobIdFromUrl(canonicalUrl);
  log.info({ jobId, url: canonicalUrl }, 'indeed-extract: navigating');

  const navStart = Date.now();
  await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  log.debug({ jobId, ms: Date.now() - navStart }, 'indeed-extract: DOM ready');

  // Indeed renders the description block client-side after the initial HTML —
  // wait for either JSON-LD or the description container before scraping.
  await page
    .waitForSelector('script[type="application/ld+json"], #jobDescriptionText, [data-testid="jobsearch-JobComponent-description"]', {
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
      'indeed-extract: using visible text as description',
    );
    description = data.visibleText;
  }

  if ((!description || description.length < 50) && !opts.noLlm) {
    log.info({ jobId }, 'indeed-extract: invoking LLM fallback');
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
    source: 'indeed',
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
    'indeed-extract: complete',
  );

  return job;
}

export async function indeedExtract(url: string, opts: ExtractOptions = {}): Promise<Job> {
  const jobId = extractIndeedJobIdFromUrl(url);

  if (!opts.reextract) {
    const cached = db.getJob(jobId);
    if (cached && cached.description.length > 0) {
      log.info({ jobId }, 'indeed-extract: returning cached job (use --reextract to refresh)');
      return cached;
    }
  }

  const job = opts.page
    ? await extractOnPage(opts.page, url, opts)
    : await withBrowser((session) => extractOnPage(session.page, url, opts));

  if (!opts.noStore) {
    db.upsertJob(job);
    log.debug({ jobId }, 'indeed-extract: persisted to DB');
  }

  return job;
}
