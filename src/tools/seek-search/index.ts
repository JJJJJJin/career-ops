// seek-search — keyword search across SEEK, ingest job stubs into DB.
//
// Selectors are kept here at module top so they can be updated in one place
// when SEEK churns.
import type { Page } from 'playwright';
import { withBrowser } from '../../shared/browser/session.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import { extractJobIdFromUrl } from '../seek-extract/index.js';

const log = createLogger('seek-search');

const BASE_URL = 'https://www.seek.com.au';

const SEL_JOB_CARD = '[data-automation="normalJob"]';
const SEL_JOB_TITLE = '[data-automation="jobTitle"]';
const SEL_JOB_COMPANY = '[data-automation="jobCompany"]';
const SEL_JOB_LOCATION = '[data-automation="jobLocation"]';
const SEL_PAGE_NEXT = '[data-automation="page-next"]';

// Titles that loudly say senior / lead / etc. We keep the filter permissive —
// "Software Engineer" with no qualifier still passes.
const SENIORITY_BLOCKLIST =
  /\b(senior|sr\.?|lead|principal|staff|head\s+of|director|architect|vp|chief|\d{2,}\+?\s*years?)\b/i;

function isEntryLevel(title: string): boolean {
  return !SENIORITY_BLOCKLIST.test(title);
}

function buildSearchUrl(keyword: string, location: string, days: number, page: number): string {
  const params = new URLSearchParams({
    keywords: keyword,
    where: location,
    daterange: String(days),
    sortmode: 'ListedDate',
  });
  if (page > 1) params.set('page', String(page));
  return `${BASE_URL}/jobs?${params.toString()}`;
}

async function acceptCookiesIfPresent(page: Page): Promise<void> {
  const selectors = ['#onetrust-accept-btn-handler', 'button:has-text("Accept All")', 'button:has-text("Accept")'];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ timeout: 1500 });
        await page.waitForTimeout(300);
        return;
      }
    } catch {
      // try next selector
    }
  }
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
  /** If true, skip filter that drops senior titles. */
  includeSenior?: boolean;
  /** If true, skip writing to DB and scan_runs history. */
  noStore?: boolean;
};

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
  let pageNum = 1;

  while (found.length < maxJobs) {
    const url = buildSearchUrl(keyword, location, days, pageNum);
    log.info({ keyword, page: pageNum, url }, 'seek-search: fetching results page');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      log.warn({ keyword, page: pageNum, err: (err as Error).message }, 'seek-search: nav failed');
      break;
    }

    if (pageNum === 1) await acceptCookiesIfPresent(page);

    const cardsVisible = await page
      .waitForSelector(SEL_JOB_CARD, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!cardsVisible) {
      log.info({ keyword, page: pageNum }, 'seek-search: no cards on page');
      break;
    }

    const cardData = await page.$$eval(
      SEL_JOB_CARD,
      (cards, sels) => {
        return cards.map((card) => {
          const titleEl = card.querySelector(sels.title) as HTMLAnchorElement | null;
          const companyEl = card.querySelector(sels.company);
          const locationEl = card.querySelector(sels.location);
          return {
            title: titleEl?.textContent?.trim() ?? '',
            href: titleEl?.getAttribute('href') ?? '',
            company: companyEl?.textContent?.trim() ?? null,
            location: locationEl?.textContent?.trim() ?? null,
          };
        });
      },
      { title: SEL_JOB_TITLE, company: SEL_JOB_COMPANY, location: SEL_JOB_LOCATION },
    );

    if (cardData.length === 0) break;

    for (const c of cardData) {
      if (found.length >= maxJobs) break;
      if (!c.href || !c.title) continue;

      const absoluteUrl = c.href.startsWith('http') ? c.href : `${BASE_URL}${c.href}`;
      // SEEK URLs include tracking; strip query for dedup but keep for click-through.
      const cleanUrl = absoluteUrl.split('?')[0] || absoluteUrl;
      if (seenUrls.has(cleanUrl)) continue;
      seenUrls.add(cleanUrl);

      if (!includeSenior && !isEntryLevel(c.title)) {
        log.debug({ title: c.title }, 'seek-search: filtered (seniority)');
        continue;
      }

      const jobId = extractJobIdFromUrl(cleanUrl);
      let isNew = false;
      if (!noStore) {
        isNew = db.upsertJobStub({
          jobId,
          url: cleanUrl,
          title: c.title,
          company: c.company,
        });
        // Also update location on the stub if available (description still empty).
        if (isNew && c.location) {
          // Cheap update — store a simple location patch via a direct query.
          // (We're not exposing setLocation publicly to keep store API small.)
          // Reload + upsert is cleaner; keep it simple: just leave location
          // empty until seek-extract runs. The card location is approximate
          // anyway and the detail page is canonical.
        }
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

    // Next page button — SEEK marks it aria-disabled when there's no more.
    const nextDisabled = await page
      .locator(SEL_PAGE_NEXT)
      .first()
      .getAttribute('aria-disabled', { timeout: 1500 })
      .catch(() => 'true');
    if (nextDisabled === 'true' || nextDisabled === null) break;

    pageNum += 1;
    // Polite jitter between pages.
    await page.waitForTimeout(1200 + Math.random() * 1200);
  }

  return found;
}

export async function seekSearch(opts: SearchOptions = {}): Promise<SearchResult[]> {
  const keywords = opts.keywords ?? config.search.keywords;
  const location = opts.location ?? config.search.location;
  const days = opts.days ?? config.search.days;
  const maxJobs = opts.maxJobsPerKeyword ?? config.search.maxJobsPerKeyword;
  const includeSenior = opts.includeSenior ?? false;
  const noStore = opts.noStore ?? false;

  log.info({ keywords, location, days, maxJobs }, 'seek-search: starting');

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
          keyword: kw,
          location,
          days,
          jobsFound: results.length,
          jobsNew: newCount,
        });
      }
      log.info({ keyword: kw, found: results.length, isNew: newCount }, 'seek-search: keyword done');
    }
  });

  log.info({ totalFound: all.length, totalNew: all.filter((r) => r.isNew).length }, 'seek-search: complete');
  return all;
}
