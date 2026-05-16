// indeed-search — keyword search across Indeed Australia (au.indeed.com),
// ingests thin job stubs into the DB.
//
// Indeed exposes a public search at:
//   https://au.indeed.com/jobs?q=<keyword>&l=<location>&fromage=<days>&start=<offset>
// Each result card carries a `data-jk` attribute with the stable job key.
// We canonicalise the URL to /viewjob?jk=<key> so downstream tools never
// see Indeed's tracking permutations.
//
// Indeed is more aggressive than SEEK/LinkedIn about anti-bot challenges
// (CAPTCHAs, blank pages on first hit). We hit one search page at a time,
// jitter between pages, and bail out if a page returns no cards rather
// than spinning indefinitely. If you get blocked: lower MAX_JOBS_PER_KEYWORD,
// raise SLOW_MO_MS, and run with HEADLESS=false to inspect.
import type { Page } from 'playwright';
import { withBrowser } from '../../shared/browser/session.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import { extractIndeedJobIdFromUrl, canonicalIndeedUrl, INDEED_JOB_ID_PREFIX } from '../indeed-extract/index.js';

const log = createLogger('indeed-search');

const BASE_URL = 'https://au.indeed.com';

const SENIORITY_BLOCKLIST =
  /\b(senior|sr\.?|lead|principal|staff|head\s+of|director|architect|vp|chief|\d{2,}\+?\s*years?)\b/i;

function isEntryLevel(title: string): boolean {
  return !SENIORITY_BLOCKLIST.test(title);
}

function buildSearchUrl(keyword: string, location: string, days: number, start: number): string {
  const params = new URLSearchParams({
    q: keyword,
    l: location,
    fromage: String(Math.max(1, days)),
    sort: 'date',
  });
  if (start > 0) params.set('start', String(start));
  return `${BASE_URL}/jobs?${params.toString()}`;
}

async function dismissOverlaysIfPresent(page: Page): Promise<void> {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept all")',
    'button:has-text("Accept")',
    '[aria-label="close"]',
    '[data-testid="closeIcon"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ timeout: 1500 });
        await page.waitForTimeout(250);
      }
    } catch {
      // try next
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
  includeSenior?: boolean;
  noStore?: boolean;
};

type CardData = { jk: string | null; title: string; href: string; company: string | null; location: string | null };

async function readCards(page: Page): Promise<CardData[]> {
  return page.$$eval('[data-jk], .job_seen_beacon, .result', (nodes) => {
    const out: { jk: string | null; title: string; href: string; company: string | null; location: string | null }[] = [];
    const seenJk = new Set<string>();
    for (const node of nodes) {
      const jk =
        (node.getAttribute('data-jk') ?? null) ||
        (node.querySelector('[data-jk]')?.getAttribute('data-jk') ?? null);
      if (jk && seenJk.has(jk)) continue;
      if (jk) seenJk.add(jk);

      const titleAnchor =
        (node.querySelector('h2.jobTitle a') as HTMLAnchorElement | null) ??
        (node.querySelector('a.jcs-JobTitle') as HTMLAnchorElement | null) ??
        (node.querySelector('a[data-jk]') as HTMLAnchorElement | null) ??
        (node.querySelector('h2 a') as HTMLAnchorElement | null);
      const titleEl =
        (node.querySelector('h2.jobTitle span[title]') as HTMLElement | null) ??
        (node.querySelector('h2.jobTitle span') as HTMLElement | null) ??
        titleAnchor;
      if (!titleEl || !titleAnchor) continue;

      const companyEl =
        (node.querySelector('[data-testid="company-name"]') as HTMLElement | null) ??
        (node.querySelector('.companyName') as HTMLElement | null) ??
        (node.querySelector('span.companyName') as HTMLElement | null);
      const locationEl =
        (node.querySelector('[data-testid="text-location"]') as HTMLElement | null) ??
        (node.querySelector('.companyLocation') as HTMLElement | null);

      out.push({
        jk,
        title: (titleEl.getAttribute('title') ?? titleEl.textContent ?? '').trim(),
        href: titleAnchor.getAttribute('href') ?? '',
        company: companyEl?.textContent?.trim() ?? null,
        location: locationEl?.textContent?.trim() ?? null,
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
  location: string,
  days: number,
  maxJobs: number,
  includeSenior: boolean,
  noStore: boolean,
): Promise<SearchResult[]> {
  const found: SearchResult[] = [];
  const seenJobIds = new Set<string>();
  let start = 0;
  // Indeed paginates 10–15 results per page; step by 10.
  const STEP = 10;

  while (found.length < maxJobs) {
    const url = buildSearchUrl(keyword, location, days, start);
    log.info({ keyword, start, url }, 'indeed-search: fetching results page');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      log.warn({ keyword, start, err: (err as Error).message }, 'indeed-search: nav failed');
      break;
    }

    if (start === 0) await dismissOverlaysIfPresent(page);

    // Wait briefly for cards to render; bail if none.
    await page
      .waitForSelector('[data-jk], .job_seen_beacon', { timeout: 10_000 })
      .catch(() => null);

    const cards = await readCards(page).catch(() => [] as CardData[]);
    if (cards.length === 0) {
      log.info({ keyword, start }, 'indeed-search: no cards on page (possibly bot-blocked)');
      break;
    }

    let addedThisPage = 0;
    for (const c of cards) {
      if (found.length >= maxJobs) break;
      if (!c.title) continue;

      // Prefer building the URL from `data-jk` so we ignore /rc/clk?…
      // tracking redirects.
      const cleanUrl = c.jk ? `${BASE_URL}/viewjob?jk=${c.jk}` : canonicalIndeedUrl(absoluteUrl(c.href));
      const jobId = c.jk ? `${INDEED_JOB_ID_PREFIX}${c.jk}` : extractIndeedJobIdFromUrl(cleanUrl);
      if (seenJobIds.has(jobId)) continue;
      seenJobIds.add(jobId);

      if (!includeSenior && !isEntryLevel(c.title)) {
        log.debug({ title: c.title }, 'indeed-search: filtered (seniority)');
        continue;
      }

      let isNew = false;
      if (!noStore) {
        isNew = db.upsertJobStub({
          jobId,
          source: 'indeed',
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
    start += STEP;
    // Polite jitter — Indeed throttles aggressively.
    await page.waitForTimeout(1500 + Math.random() * 1500);
  }

  return found;
}

export async function indeedSearch(opts: SearchOptions = {}): Promise<SearchResult[]> {
  const keywords = opts.keywords ?? config.search.keywords;
  const location = opts.location ?? config.search.location;
  const days = opts.days ?? config.search.days;
  const maxJobs = opts.maxJobsPerKeyword ?? config.search.maxJobsPerKeyword;
  const includeSenior = opts.includeSenior ?? false;
  const noStore = opts.noStore ?? false;

  log.info({ keywords, location, days, maxJobs }, 'indeed-search: starting');

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
          source: 'indeed',
          keyword: kw,
          location,
          days,
          jobsFound: results.length,
          jobsNew: newCount,
        });
      }
      log.info({ keyword: kw, found: results.length, isNew: newCount }, 'indeed-search: keyword done');
    }
  });

  log.info({ totalFound: all.length, totalNew: all.filter((r) => r.isNew).length }, 'indeed-search: complete');
  return all;
}
