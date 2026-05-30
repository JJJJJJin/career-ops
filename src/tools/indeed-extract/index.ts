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

/** Pull the bare jk out of any Indeed URL or `indeed:<jk>` id. */
function jkOf(input: string): string | null {
  const m = input.match(/[?&](?:jk|vjk)=([A-Za-z0-9]+)/) ?? input.match(/^indeed:([A-Za-z0-9]+)$/);
  if (m && m[1]) return m[1];
  const tail = input.match(/-([A-Za-z0-9]{16})(?:[?#].*)?$/);
  return tail && tail[1] ? tail[1] : null;
}

/**
 * The search-results URL that renders a job's FULL JD in the right-hand detail
 * panel via `&vjk=<jk>`. We navigate HERE instead of `/viewjob?jk=` because the
 * standalone /viewjob page is Indeed's most heavily Cloudflare-protected
 * endpoint (reliably walls), whereas the /jobs SERP is not and carries the same
 * JD in-panel. If the original input was already a /jobs search URL, its
 * q=/l= context is preserved; otherwise a bare vjk SERP is used.
 */
export function searchPanelUrl(input: string): string {
  const jk = jkOf(input) ?? '';
  const host = input.match(/https?:\/\/([^/]+)/)?.[1] ?? 'au.indeed.com';
  // Preserve an existing SERP query string (minus any old vjk), then set vjk.
  if (/\/jobs\?/.test(input)) {
    const qs = (input.split('?')[1] ?? '')
      .split('&')
      .filter((p) => p && !/^vjk=/.test(p))
      .join('&');
    return `https://${host}/jobs?${qs}${qs ? '&' : ''}vjk=${jk}`;
  }
  return `https://${host}/jobs?vjk=${jk}`;
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
  /** innerText of the SERP right-hand detail panel, when present. */
  panelText: string;
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

    // The SERP detail panel (loaded via &vjk=) carries the full JD in-page.
    const panel = document.querySelector('#jobsearch-ViewjobPaneWrapper');
    const panelText = (panel as HTMLElement | null)?.innerText?.slice(0, 16000) ?? '';

    return { jsonLdRaw, visibleText, title, panelText };
  });
}

/**
 * Parse the SERP detail-panel innerText into fields. The panel reads roughly:
 *   Return to Search Result / Job Post Details / <title> / - job post /
 *   <company> / <location> / Apply with Indeed / Location / <location> / ...
 *   Full job description / <body...> / Report job / Return to Search Result
 */
function parsePanel(panelText: string): { title: string; company: string | null; location: string | null; description: string } | null {
  if (!panelText) return null;
  const lines = panelText.split('\n').map((l) => l.trim()).filter(Boolean);
  const hdr = lines.findIndex((l) => /^Job Post Details$/i.test(l));
  const title = hdr >= 0 ? lines[hdr + 1] ?? '' : lines[0] ?? '';

  let company: string | null = null;
  let location: string | null = null;
  if (hdr >= 0) {
    // After title: optional "- job post", then company, then location.
    let i = hdr + 2;
    if (lines[i] && /^-\s*job post$/i.test(lines[i]!)) i += 1;
    company = lines[i] ?? null;
    location = lines[i + 1] ?? null;
    if (location && /^Apply with Indeed$/i.test(location)) location = null;
  }

  // Description = everything from "Full job description" up to the trailing boilerplate.
  const start = lines.findIndex((l) => /^Full job description$/i.test(l));
  let description = '';
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^(Report job|Return to Search Result)$/i.test(l));
    description = (end >= 0 ? rest.slice(0, end) : rest).join('\n').trim();
  }
  if (!title && !description) return null;
  return { title: title || '', company, location, description };
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
  // Navigate to the SERP detail-panel URL (&vjk=), NOT /viewjob — the latter is
  // the Cloudflare-walled endpoint. The panel carries the same full JD in-page.
  const navUrl = searchPanelUrl(url);
  log.info({ jobId, url: navUrl }, 'indeed-extract: navigating (search panel)');

  const navStart = Date.now();
  await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  log.debug({ jobId, ms: Date.now() - navStart }, 'indeed-extract: DOM ready');

  // Wait for the detail panel (preferred) OR the legacy viewjob containers OR
  // JSON-LD — whichever the page renders client-side.
  await page
    .waitForSelector('#jobsearch-ViewjobPaneWrapper, script[type="application/ld+json"], #jobDescriptionText, [data-testid="jobsearch-JobComponent-description"]', {
      timeout: 15_000,
    })
    .catch(() => null);

  const data = await readPageData(page);
  const jsonLd = findJobPosting(data.jsonLdRaw);
  const panel = parsePanel(data.panelText);

  // Prefer the panel (most reliable on the SERP), then JSON-LD, then headings.
  let title = panel?.title || jsonLd?.title || data.title;
  const descriptionHtml = jsonLd?.description ?? null;
  let description = (panel?.description && panel.description.length > 80)
    ? panel.description
    : descriptionHtml
      ? htmlToText(descriptionHtml)
      : '';
  let company = panel?.company ?? companyFromJsonLd(jsonLd ?? {});
  let location = panel?.location ?? locationFromJsonLd(jsonLd ?? {});
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
