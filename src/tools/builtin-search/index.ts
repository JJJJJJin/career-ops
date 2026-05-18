// builtin-search — keyword search across Built In (builtin.com), ingests
// thin job stubs into the DB.
//
// Built In exposes a public search at:
//   https://builtin.com/jobs?search=<keyword>&daysSinceUpdated=<days>&page=<n>
// Result cards link to /job/<role-slug>/<numeric-id>. We canonicalise to the
// path with tracking params stripped so downstream tools never see Built In's
// query permutations.
//
// Notes vs SEEK/LinkedIn/Indeed:
//  - Built In is US / remote-centric. Its location facet uses internal
//    location ids, not free text, so a generic SEARCH_LOCATION like
//    "All Australia" can't be applied as a server filter. We therefore IGNORE
//    location for Built In (except mapping a "remote" hint to ?remote=true)
//    and let the pipeline's fetched_at window + eligibility scan do the rest.
//  - `daysSinceUpdated` is Built In's "Date posted" facet; passed best-effort.
//  - The listing is client-rendered, so we wait for job links to hydrate.
import type { Page } from 'playwright';
import { withBrowser } from '../../shared/browser/session.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import {
  extractBuiltinJobIdFromUrl,
  canonicalBuiltinUrl,
} from '../builtin-extract/index.js';

const log = createLogger('builtin-search');

const BASE_URL = 'https://builtin.com';

const SENIORITY_BLOCKLIST =
  /\b(senior|sr\.?|lead|principal|staff|head\s+of|director|architect|vp|chief|\d{2,}\+?\s*years?)\b/i;

function isEntryLevel(title: string): boolean {
  return !SENIORITY_BLOCKLIST.test(title);
}

/** Built In treats location as an internal facet, so we only honour a
 * remote hint; everything else is advisory and dropped from the query. */
function isRemoteHint(location: string | undefined): boolean {
  return !!location && /\bremote\b/i.test(location);
}

function buildSearchUrl(keyword: string, location: string | undefined, days: number, page: number): string {
  const params = new URLSearchParams({ search: keyword });
  if (days > 0) params.set('daysSinceUpdated', String(Math.max(1, days)));
  if (isRemoteHint(location)) params.set('remote', 'true');
  if (page > 1) params.set('page', String(page));
  return `${BASE_URL}/jobs?${params.toString()}`;
}

export type SearchResult = {
  jobId: string;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  matchedKeyword: string;
  isNew: boolean;
};

export type SearchOptions = {
  keywords?: string[];
  location?: string;
  days?: number;
  maxJobsPerKeyword?: number;
  includeSenior?: boolean;
  noStore?: boolean;
};

type CardData = { title: string; href: string; company: string | null; location: string | null };

async function readCards(page: Page): Promise<CardData[]> {
  return page.$$eval('a[href*="/job/"]', (anchors) => {
    const out: { title: string; href: string; company: string | null; location: string | null }[] = [];
    const seenHref = new Set<string>();
    for (const aRaw of anchors) {
      const a = aRaw as HTMLAnchorElement;
      const href = a.getAttribute('href') ?? '';
      // Only real job-detail links: …/job/…/<id>. Skip /jobs, /job/apply, etc.
      if (!/\/job\/[^?#]*\d{4,}/.test(href)) continue;
      const key = href.split(/[?#]/)[0] ?? href;
      if (seenHref.has(key)) continue;
      seenHref.add(key);

      // Walk up to the enclosing card so we can read company + location.
      const card =
        a.closest('[data-id="job-card"]') ??
        a.closest('article') ??
        a.closest('[class*="job-card"]') ??
        a.closest('li') ??
        a.parentElement;

      const titleEl =
        (a.querySelector('h2, h3') as HTMLElement | null) ??
        ((card?.querySelector('h2 a, h3 a, [data-id="job-card-title"]') as HTMLElement | null)) ??
        (a as HTMLElement);
      const title = (titleEl.textContent ?? a.textContent ?? '').trim();
      if (!title) continue;

      const companyEl =
        (card?.querySelector('[data-id="company-title"]') as HTMLElement | null) ??
        (card?.querySelector('a[href*="/company/"]') as HTMLElement | null) ??
        (card?.querySelector('[class*="company"]') as HTMLElement | null);
      const locationEl =
        (card?.querySelector('[data-id="job-card-location"]') as HTMLElement | null) ??
        (card?.querySelector('[class*="location"]') as HTMLElement | null);

      out.push({
        title,
        href,
        company: companyEl?.textContent?.trim() || null,
        location: locationEl?.textContent?.trim() || null,
      });
    }
    return out;
  });
}

function absoluteUrl(href: string): string {
  if (href.startsWith('http')) return href;
  return `${BASE_URL}${href.startsWith('/') ? href : '/' + href}`;
}

async function searchOneKeyword(
  page: Page,
  keyword: string,
  location: string | undefined,
  days: number,
  maxJobs: number,
  includeSenior: boolean,
  noStore: boolean,
): Promise<SearchResult[]> {
  const found: SearchResult[] = [];
  const seenJobIds = new Set<string>();
  let pageNum = 1;

  while (found.length < maxJobs) {
    const url = buildSearchUrl(keyword, location, days, pageNum);
    log.info({ keyword, page: pageNum, url }, 'builtin-search: fetching results page');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      log.warn({ keyword, page: pageNum, err: (err as Error).message }, 'builtin-search: nav failed');
      break;
    }

    // Built In hydrates cards client-side; wait for job links to appear.
    await page.waitForSelector('a[href*="/job/"]', { timeout: 12_000 }).catch(() => null);

    const cards = await readCards(page).catch(() => [] as CardData[]);
    if (cards.length === 0) {
      log.info({ keyword, page: pageNum }, 'builtin-search: no cards on page (end of results or bot-blocked)');
      break;
    }

    let addedThisPage = 0;
    for (const c of cards) {
      if (found.length >= maxJobs) break;
      if (!c.title) continue;

      const cleanUrl = canonicalBuiltinUrl(absoluteUrl(c.href));
      const jobId = extractBuiltinJobIdFromUrl(cleanUrl);
      if (seenJobIds.has(jobId)) continue;
      seenJobIds.add(jobId);

      if (!includeSenior && !isEntryLevel(c.title)) {
        log.debug({ title: c.title }, 'builtin-search: filtered (seniority)');
        continue;
      }

      let isNew = false;
      if (!noStore) {
        isNew = db.upsertJobStub({
          jobId,
          source: 'builtin',
          url: cleanUrl,
          title: c.title,
          company: c.company,
        });
      }
      found.push({
        jobId,
        url: cleanUrl,
        title: c.title,
        company: c.company,
        location: c.location,
        matchedKeyword: keyword,
        isNew,
      });
      addedThisPage += 1;
    }

    if (addedThisPage === 0) break;
    pageNum += 1;
    // Polite jitter between pages.
    await page.waitForTimeout(1200 + Math.random() * 1200);
  }

  return found;
}

export async function builtinSearch(opts: SearchOptions = {}): Promise<SearchResult[]> {
  const keywords = opts.keywords ?? config.search.keywords;
  // Location is advisory for Built In (see file header) — pass through only so
  // a "remote" hint can flip the remote facet; never used as a hard filter.
  const location = opts.location ?? config.search.location;
  const days = opts.days ?? config.search.days;
  const maxJobs = opts.maxJobsPerKeyword ?? config.search.maxJobsPerKeyword;
  const includeSenior = opts.includeSenior ?? false;
  const noStore = opts.noStore ?? false;

  log.info({ keywords, days, maxJobs, remoteHint: isRemoteHint(location) }, 'builtin-search: starting');

  const all: SearchResult[] = [];
  const seenJobIds = new Set<string>();

  await withBrowser(async (session) => {
    for (const kw of keywords) {
      const ranAt = new Date().toISOString();
      const results = await searchOneKeyword(session.page, kw, location, days, maxJobs, includeSenior, noStore);
      let newCount = 0;
      for (const r of results) {
        if (seenJobIds.has(r.jobId)) continue;
        seenJobIds.add(r.jobId);
        if (r.isNew) newCount += 1;
        all.push(r);
      }
      if (!noStore) {
        db.recordScanRun({
          ranAt,
          source: 'builtin',
          keyword: kw,
          location,
          days,
          jobsFound: results.length,
          jobsNew: newCount,
        });
      }
      log.info({ keyword: kw, found: results.length, isNew: newCount }, 'builtin-search: keyword done');
    }
  });

  log.info({ totalFound: all.length, totalNew: all.filter((r) => r.isNew).length }, 'builtin-search: complete');
  return all;
}
