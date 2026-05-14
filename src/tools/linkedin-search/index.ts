// linkedin-search — keyword search via LinkedIn's public guest endpoint.
//
// LinkedIn exposes
//   https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
// which returns an HTML fragment of job cards without requiring login. Each
// card has a canonical /jobs/view/<id> URL we can feed to linkedin-extract.
//
// f_TPR (time posted range) maps days → seconds: 1d=86400, 7d=604800, etc.
// f_E (experience level) — we don't filter, since LinkedIn's level codes are
// fuzzy. Title-based seniority filtering happens client-side (same regex as
// SEEK).
import type { Page } from 'playwright';
import { withBrowser } from '../../shared/browser/session.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import { extractLinkedInJobIdFromUrl } from '../linkedin-extract/index.js';

const log = createLogger('linkedin-search');

const BASE_GUEST_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

const SENIORITY_BLOCKLIST =
  /\b(senior|sr\.?|lead|principal|staff|head\s+of|director|architect|vp|chief|\d{2,}\+?\s*years?)\b/i;

function isEntryLevel(title: string): boolean {
  return !SENIORITY_BLOCKLIST.test(title);
}

function daysToTprSeconds(days: number): string {
  return `r${Math.max(1, Math.round(days * 86400))}`;
}

function buildSearchUrl(keyword: string, location: string, days: number, start: number): string {
  const params = new URLSearchParams({
    keywords: keyword,
    location,
    f_TPR: daysToTprSeconds(days),
    start: String(start),
  });
  return `${BASE_GUEST_URL}?${params.toString()}`;
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
  return page.$$eval('li, div.base-card', (nodes) => {
    const out: { title: string; href: string; company: string | null; location: string | null }[] = [];
    for (const node of nodes) {
      const titleEl = node.querySelector('h3.base-search-card__title') as HTMLElement | null;
      const linkEl =
        (node.querySelector('a.base-card__full-link') as HTMLAnchorElement | null) ??
        (node.querySelector('a.base-search-card__media-link') as HTMLAnchorElement | null) ??
        (node.querySelector('a[href*="/jobs/view/"]') as HTMLAnchorElement | null);
      if (!titleEl || !linkEl) continue;
      const companyEl =
        (node.querySelector('h4.base-search-card__subtitle') as HTMLElement | null) ??
        (node.querySelector('.base-search-card__subtitle a') as HTMLElement | null);
      const locationEl = node.querySelector('.job-search-card__location') as HTMLElement | null;
      out.push({
        title: titleEl.textContent?.trim() ?? '',
        href: linkEl.getAttribute('href') ?? '',
        company: companyEl?.textContent?.trim() ?? null,
        location: locationEl?.textContent?.trim() ?? null,
      });
    }
    return out;
  });
}

function canonicalUrl(href: string): string {
  const m = href.match(/(\d{6,})/);
  if (m && m[1]) return `https://www.linkedin.com/jobs/view/${m[1]}`;
  return href.split('?')[0] ?? href;
}

async function searchOneKeyword(
  page: Page,
  keyword: string,
  location: string,
  days: number,
  maxJobs: number,
  includeSenior: boolean,
  noStore: boolean,
): Promise<SearchResult[]> {
  const found: SearchResult[] = [];
  const seenUrls = new Set<string>();
  let start = 0;
  // The guest endpoint pages ~25 results at a time.
  const STEP = 25;

  while (found.length < maxJobs) {
    const url = buildSearchUrl(keyword, location, days, start);
    log.info({ keyword, start, url }, 'linkedin-search: fetching page');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      log.warn({ keyword, start, err: (err as Error).message }, 'linkedin-search: nav failed');
      break;
    }

    const cards = await readCards(page).catch(() => [] as CardData[]);
    if (cards.length === 0) {
      log.info({ keyword, start }, 'linkedin-search: no cards on page');
      break;
    }

    for (const c of cards) {
      if (found.length >= maxJobs) break;
      if (!c.href || !c.title) continue;

      const cleanUrl = canonicalUrl(c.href);
      if (seenUrls.has(cleanUrl)) continue;
      seenUrls.add(cleanUrl);

      if (!includeSenior && !isEntryLevel(c.title)) {
        log.debug({ title: c.title }, 'linkedin-search: filtered (seniority)');
        continue;
      }

      const jobId = extractLinkedInJobIdFromUrl(cleanUrl);
      let isNew = false;
      if (!noStore) {
        isNew = db.upsertJobStub({
          jobId,
          source: 'linkedin',
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
    }

    if (cards.length < STEP) break; // last page
    start += STEP;
    await page.waitForTimeout(1200 + Math.random() * 1200);
  }

  return found;
}

export async function linkedinSearch(opts: SearchOptions = {}): Promise<SearchResult[]> {
  const keywords = opts.keywords ?? config.search.keywords;
  const location = opts.location ?? config.search.location;
  const days = opts.days ?? config.search.days;
  const maxJobs = opts.maxJobsPerKeyword ?? config.search.maxJobsPerKeyword;
  const includeSenior = opts.includeSenior ?? false;
  const noStore = opts.noStore ?? false;

  log.info({ keywords, location, days, maxJobs }, 'linkedin-search: starting');

  const all: SearchResult[] = [];
  const seenUrls = new Set<string>();

  await withBrowser(async (session) => {
    for (const kw of keywords) {
      const ranAt = new Date().toISOString();
      const results = await searchOneKeyword(session.page, kw, location, days, maxJobs, includeSenior, noStore);
      let newCount = 0;
      for (const r of results) {
        if (seenUrls.has(r.url)) continue;
        seenUrls.add(r.url);
        if (r.isNew) newCount += 1;
        all.push(r);
      }
      if (!noStore) {
        db.recordScanRun({
          ranAt,
          source: 'linkedin',
          keyword: kw,
          location,
          days,
          jobsFound: results.length,
          jobsNew: newCount,
        });
      }
      log.info({ keyword: kw, found: results.length, isNew: newCount }, 'linkedin-search: keyword done');
    }
  });

  log.info({ totalFound: all.length, totalNew: all.filter((r) => r.isNew).length }, 'linkedin-search: complete');
  return all;
}
