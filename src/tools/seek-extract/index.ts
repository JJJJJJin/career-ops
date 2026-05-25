// seek-extract — fetch a single SEEK job posting and persist it.
//
// Strategy:
// 1. Navigate the URL, wait for JSON-LD or jobAdDetails block
// 2. Read JSON-LD JobPosting + __NEXT_DATA__ (richer fields like classification)
// 3. Fall back to the visible jobAdDetails text if JSON-LD description is thin
// 4. Final LLM fallback only if everything above failed
import type { Page } from 'playwright';
import { callJson } from '../../shared/llm/client.js';
import { createLogger } from '../../shared/logger.js';
import { withBrowser } from '../../shared/browser/session.js';
import { db } from '../../shared/db/store.js';
import type { ApplyType, Job } from '../../shared/db/types.js';

const log = createLogger('seek-extract');

export type ExtractOptions = {
  /** Skip the LLM fallback even if the description is thin. */
  noLlm?: boolean;
  /** Skip writing to SQLite. */
  noStore?: boolean;
  /** Force-refetch even if already cached. */
  reextract?: boolean;
};

export function extractJobIdFromUrl(url: string): string {
  const m = url.match(/\/job\/(\d+)/);
  return m && m[1] ? m[1] : url;
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
  validThrough?: string;
  employmentType?: string | string[];
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
  nextData: string | null;
  visibleText: string;
  fullText: string;
  title: string;
};

async function readPageData(page: Page): Promise<PageData> {
  return page.evaluate(() => {
    const jsonLdNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const jsonLdRaw = jsonLdNodes.map((n) => n.textContent ?? '').filter(Boolean);

    const nextEl = document.getElementById('__NEXT_DATA__');
    const nextData = nextEl?.textContent ?? null;

    const titleEl = document.querySelector('h1');
    const title = titleEl?.textContent?.trim() ?? document.title ?? '';

    const main =
      document.querySelector('[data-automation="jobAdDetails"]') ??
      document.querySelector('main') ??
      document.body;
    const visibleText = (main as HTMLElement).innerText?.slice(0, 12000) ?? '';
    const fullText = document.body.innerText?.slice(0, 12000) ?? '';

    return { jsonLdRaw, nextData, visibleText, fullText, title };
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
      // Skip malformed JSON-LD.
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

/** Extract company name from visible page text, right after the job title. */
function companyFromVisibleText(visibleText: string, title: string): string | null {
  const lines = visibleText.split('\n').map((l) => l.trim()).filter(Boolean);
  const titleIndex = lines.findIndex((l) => l === title);
  if (titleIndex >= 0 && titleIndex + 1 < lines.length) {
    const candidate = lines[titleIndex + 1];
    // Skip lines that are obviously not company names (short, starts with digit, known nav items)
    if (
      candidate &&
      candidate.length > 2 &&
      !/^\d/.test(candidate) &&
      !/^(skip|sign|back|view|apply|save|share)/i.test(candidate)
    ) {
      return candidate;
    }
  }
  return null;
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

type NextJobFields = {
  classification: string | null;
  workType: string | null;
  location: string | null;
  company: string | null;
};

function findNextJobFields(nextData: string | null): NextJobFields {
  const empty: NextJobFields = { classification: null, workType: null, location: null, company: null };
  if (!nextData) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(nextData);
  } catch {
    return empty;
  }

  let found: Record<string, unknown> | null = null;
  const visit = (node: unknown, depth: number): void => {
    if (found || depth > 8 || !node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const looksJobby =
      ('classification' in obj || 'subClassification' in obj || 'workType' in obj) &&
      ('title' in obj || 'advertiser' in obj || 'companyName' in obj);
    if (looksJobby) {
      found = obj;
      return;
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  visit(parsed, 0);

  if (!found) return empty;
  const f = found as Record<string, unknown>;
  const pickName = (v: unknown): string | null => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const name = o.description ?? o.name ?? o.label;
      if (typeof name === 'string') return name;
    }
    return null;
  };

  const adv = f.advertiser as Record<string, unknown> | undefined;
  return {
    classification: pickName(f.classification),
    workType: typeof f.workType === 'string' ? f.workType : pickName(f.workType),
    location: pickName(f.location),
    company: pickName(adv) ?? (typeof f.companyName === 'string' ? f.companyName : null),
  };
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
      step: 'seek-extract:fallback',
      systemPrompt: 'You extract structured data from job listings. Output strict JSON.',
      userPrompt: `Extract the SEEK job posting fields from the page text below. Return a JSON object with keys: title, company, location, workType, classification, description (plain text). Use null for unknowns.\n\nPAGE TITLE: ${title}\n\nPAGE TEXT:\n${visibleText}`,
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
    log.warn({ err: (err as Error).message }, 'seek-extract: LLM fallback failed');
    return null;
  }
}

/**
 * Detect how the posting is applied to, from the apply button:
 *   text "Quick apply" + on-site href  → 'quick'   (drive the quick-apply flow)
 *   text "Apply" / off-site href        → 'external' (record for manual apply)
 * Falls back to 'unknown' when no apply button is found.
 */
async function detectApplyType(page: Page): Promise<{ applyType: ApplyType; externalApplyUrl: string | null }> {
  try {
    return await page.evaluate(() => {
      const btn = document.querySelector('[data-automation="job-detail-apply"]') as HTMLAnchorElement | null;
      if (!btn) return { applyType: 'unknown' as const, externalApplyUrl: null };
      const text = (btn.textContent || '').trim().toLowerCase();
      const rawHref = btn.getAttribute('href') || '';
      let abs = rawHref;
      try {
        abs = new URL(rawHref, location.href).href;
      } catch {
        /* keep raw */
      }
      let sameHost = true;
      try {
        const h = new URL(abs).host;
        sameHost = h.endsWith('seek.com') || h.endsWith('seek.com.au');
      } catch {
        sameHost = true;
      }
      if (text.includes('quick apply')) return { applyType: 'quick' as const, externalApplyUrl: null };
      if (!sameHost) return { applyType: 'external' as const, externalApplyUrl: abs };
      if (text.includes('apply')) return { applyType: 'external' as const, externalApplyUrl: null };
      return { applyType: 'unknown' as const, externalApplyUrl: null };
    });
  } catch {
    return { applyType: 'unknown', externalApplyUrl: null };
  }
}

async function extractOnPage(page: Page, url: string, opts: ExtractOptions): Promise<Job> {
  const jobId = extractJobIdFromUrl(url);
  log.info({ jobId, url }, 'seek-extract: navigating');
  const navStart = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  log.debug({ jobId, ms: Date.now() - navStart }, 'seek-extract: DOM ready');

  await page
    .waitForSelector('script[type="application/ld+json"], [data-automation="jobAdDetails"]', { timeout: 15_000 })
    .catch(() => null);
  // Apply button is what we classify quick vs external from — give it a moment.
  await page.waitForSelector('[data-automation="job-detail-apply"]', { timeout: 5_000 }).catch(() => null);

  const data = await readPageData(page);
  const apply = await detectApplyType(page);
  const jsonLd = findJobPosting(data.jsonLdRaw);
  const nextFields = findNextJobFields(data.nextData);

  let title = jsonLd?.title ?? data.title;
  const descriptionHtml = jsonLd?.description ?? null;
  let description = descriptionHtml ? htmlToText(descriptionHtml) : '';
  let company = companyFromJsonLd(jsonLd ?? {}) ?? nextFields.company ?? companyFromVisibleText(data.fullText, title);
  let location = locationFromJsonLd(jsonLd ?? {}) ?? nextFields.location;
  let workType = workTypeFromJsonLd(jsonLd ?? {}) ?? nextFields.workType;
  let classification = nextFields.classification;
  const salary = salaryFromJsonLd(jsonLd ?? {});

  // Fall back to visible page text if JSON-LD description is missing/thin.
  if (description.length < 200 && data.visibleText.length > description.length) {
    log.debug(
      { jobId, jsonLdDesc: description.length, visibleText: data.visibleText.length },
      'seek-extract: using visible text as description',
    );
    description = data.visibleText;
  }

  // LLM fallback for company if still missing.
  if (!company && description.length > 50 && !opts.noLlm) {
    log.info({ jobId }, 'seek-extract: LLM fallback for company');
    const llm = await llmExtract(description.substring(0, 3000), title);
    if (llm?.company) company = llm.company;
  }

  // LLM fallback only if everything above failed.
  if ((!description || description.length < 50) && !opts.noLlm) {
    log.info({ jobId }, 'seek-extract: invoking LLM fallback');
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
    source: 'seek',
    url,
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
    applyType: apply.applyType,
    externalApplyUrl: apply.externalApplyUrl,
  };

  log.info(
    {
      jobId,
      title: job.title,
      company: job.company,
      location: job.location,
      classification: job.classification,
      descChars: job.description.length,
      applyType: job.applyType,
    },
    'seek-extract: complete',
  );

  return job;
}

export async function seekExtract(url: string, opts: ExtractOptions = {}): Promise<Job> {
  const jobId = extractJobIdFromUrl(url);

  if (!opts.reextract) {
    const cached = db.getJob(jobId);
    if (cached && cached.description.length > 0) {
      log.info({ jobId }, 'seek-extract: returning cached job (use --reextract to refresh)');
      return cached;
    }
  }

  const job = await withBrowser((session) => extractOnPage(session.page, url, opts));

  if (!opts.noStore) {
    db.upsertJob(job);
    log.debug({ jobId }, 'seek-extract: persisted to DB');
  }

  return job;
}
