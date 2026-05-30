// builtin-extract — fetch a single Built In (builtin.com) job posting and
// persist it.
//
// Built In exposes job postings at:
//   https://builtin.com/job/<role-slug>/<numeric-id>
//   https://builtin.com/job/<numeric-id>
//   https://builtin.com/company/<company-slug>/job/<numeric-id>
// and search links carry extra tracking params. The trailing numeric id is
// the stable key; we canonicalise to the path with query/hash stripped.
//
// Strategy mirrors seek/linkedin/indeed extract: try JSON-LD first (Built In
// is SEO-heavy and embeds a JobPosting block on detail pages), then fall back
// to visible text, then LLM rescue only when the description is still empty.
//
// jobIds are namespaced `builtin:<id>` so they don't collide with SEEK's bare
// numeric IDs, LinkedIn's `linkedin:<id>`, or Indeed's `indeed:<jk>`.
import type { Page } from 'playwright';
import { callJson } from '../../shared/llm/client.js';
import { createLogger } from '../../shared/logger.js';
import { withBrowser } from '../../shared/browser/session.js';
import { db } from '../../shared/db/store.js';
import type { Job } from '../../shared/db/types.js';

const log = createLogger('builtin-extract');

export type ExtractOptions = {
  noLlm?: boolean;
  noStore?: boolean;
  reextract?: boolean;
  /** Reuse an already-open live page instead of a throwaway browser (anti-bot). */
  page?: Page;
};

export const BUILTIN_JOB_ID_PREFIX = 'builtin:';

/** Pull Built In's stable numeric job id out of any builtin.com URL. */
export function extractBuiltinJobIdFromUrl(url: string): string {
  // Strip query/hash so trailing-id matching isn't fooled by ?utm_=… params.
  const path = url.split(/[?#]/)[0] ?? url;
  // Built In ids are the last numeric path segment (typically 6–8 digits).
  const seg = path.match(/\/(\d{4,})\/?$/);
  if (seg && seg[1]) return `${BUILTIN_JOB_ID_PREFIX}${seg[1]}`;
  // Some links embed the id mid-path (…/job/<id>/apply); take the last run.
  const runs = path.match(/\d{4,}/g);
  if (runs && runs.length) return `${BUILTIN_JOB_ID_PREFIX}${runs[runs.length - 1]}`;
  return `${BUILTIN_JOB_ID_PREFIX}${path}`;
}

/** Strip tracking params/fragments, keep the canonical builtin.com path. */
export function canonicalBuiltinUrl(input: string): string {
  const noFrag = input.split('#')[0] ?? input;
  const base = noFrag.split('?')[0] ?? noFrag;
  // Normalise host to builtin.com (regional hosts like builtinnyc.com 301 here).
  return base.replace(/https?:\/\/[^/]*builtin[^/]*/i, 'https://builtin.com');
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
  occupationalCategory?: string | string[];
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
  jobLocationType?: string;
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
      document.querySelector('h1[data-id="job-title"]') ??
      document.querySelector('[class*="JobInfoHeader"] h1') ??
      document.querySelector('h1');
    const title = titleEl?.textContent?.trim() ?? document.title ?? '';

    const desc =
      document.querySelector('[data-id="job-description"]') ??
      document.querySelector('[class*="job-description"]') ??
      document.querySelector('article') ??
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
  if (jp.jobLocationType === 'TELECOMMUTE' && !jp.jobLocation) return 'Remote';
  const loc = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation;
  if (!loc?.address) return jp.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null;
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
  if (!et) return jp.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null;
  return Array.isArray(et) ? et.join(', ') : et;
}

function classificationFromJsonLd(jp: JsonLdJobPosting): string | null {
  const cat = jp.occupationalCategory ?? jp.industry;
  if (!cat) return null;
  return Array.isArray(cat) ? cat.join(', ') : cat;
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
      step: 'builtin-extract:fallback',
      systemPrompt: 'You extract structured data from job listings. Output strict JSON.',
      userPrompt: `Extract Built In job posting fields from the page text below. Return a JSON object with keys: title, company, location, workType, classification, description (plain text). Use null for unknowns.\n\nPAGE TITLE: ${title}\n\nPAGE TEXT:\n${visibleText}`,
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
    log.warn({ err: (err as Error).message }, 'builtin-extract: LLM fallback failed');
    return null;
  }
}

async function extractOnPage(page: Page, url: string, opts: ExtractOptions): Promise<Job> {
  const canonicalUrl = canonicalBuiltinUrl(url);
  const jobId = extractBuiltinJobIdFromUrl(canonicalUrl);
  log.info({ jobId, url: canonicalUrl }, 'builtin-extract: navigating');

  const navStart = Date.now();
  await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  log.debug({ jobId, ms: Date.now() - navStart }, 'builtin-extract: DOM ready');

  // Built In hydrates the description client-side after the initial HTML —
  // wait for either JSON-LD or a description container before scraping.
  await page
    .waitForSelector('script[type="application/ld+json"], [data-id="job-description"], [class*="job-description"]', {
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
      'builtin-extract: using visible text as description',
    );
    description = data.visibleText;
  }

  if ((!description || description.length < 50) && !opts.noLlm) {
    log.info({ jobId }, 'builtin-extract: invoking LLM fallback');
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
    source: 'builtin',
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
    'builtin-extract: complete',
  );

  return job;
}

export async function builtinExtract(url: string, opts: ExtractOptions = {}): Promise<Job> {
  const jobId = extractBuiltinJobIdFromUrl(url);

  if (!opts.reextract) {
    const cached = db.getJob(jobId);
    if (cached && cached.description.length > 0) {
      log.info({ jobId }, 'builtin-extract: returning cached job (use --reextract to refresh)');
      return cached;
    }
  }

  const job = opts.page
    ? await extractOnPage(opts.page, url, opts)
    : await withBrowser((session) => extractOnPage(session.page, url, opts));

  if (!opts.noStore) {
    db.upsertJob(job);
    log.debug({ jobId }, 'builtin-extract: persisted to DB');
  }

  return job;
}
