// batch-extract — multi-page parallel job-description scraper.
//
// Opens ONE browser with N concurrent pages, fans out SEEK/LinkedIn/Indeed URLs
// across them, and persists every extracted job to SQLite.  Designed as a bulk
// refresh step before multi-subagent evaluation: pull all the JD text offline
// in one pass, then let Hermes fan out summarise+match+verdict in parallel.
//
// Safe for 4-6 concurrent pages against SEEK (one browser, same IP, short
// burst).  If you need more concurrency, add a random jitter to page.goto.

import type { Page } from 'playwright';
import { launchSession, closeSession } from '../../shared/browser/session.js';
import { createLogger } from '../../shared/logger.js';
import { db } from '../../shared/db/store.js';
import type { Job } from '../../shared/db/types.js';
import { seekExtract } from '../seek-extract/index.js';
import { linkedinExtract } from '../linkedin-extract/index.js';
import { indeedExtract } from '../indeed-extract/index.js';

const log = createLogger('batch-extract');

// ---- tiny async semaphore (zero deps) ---------------------------------------

class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(n: number) {
    this.permits = n;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.permits--;
        resolve();
      });
    });
  }

  release(): void {
    this.permits++;
    const next = this.waiters.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get available(): number {
    return this.permits;
  }
}

// ---- URL → source dispatch ------------------------------------------------

type SourceName = 'seek' | 'linkedin' | 'indeed';

function detectSource(url: string): SourceName | null {
  if (/seek\.com(\.au)?\/job\/\d+/.test(url)) return 'seek';
  if (/linkedin\.com\/jobs\/view\//.test(url)) return 'linkedin';
  if (/au\.indeed\.com\/viewjob/.test(url) || /indeed\.com\/viewjob/.test(url)) return 'indeed';
  return null;
}

function extractOne(page: Page, url: string, source: SourceName): Promise<Job> {
  switch (source) {
    case 'seek':
      return seekExtract(url, { page, reextract: true });
    case 'linkedin':
      return linkedinExtract(url, { page, reextract: true });
    case 'indeed':
      return indeedExtract(url, { page, reextract: true });
  }
}

// ---- public API ------------------------------------------------------------

export type BatchExtractOptions = {
  /** Max concurrent Playwright pages (default 4). */
  concurrency?: number;
  /** If true, skip DB persistence (caller handles results). */
  noStore?: boolean;
};

export type BatchResult = {
  ok: Job[];
  failed: Array<{ url: string; error: string }>;
};

/**
 * Scrape multiple job URLs in parallel using one shared browser session.
 *
 * Each URL is routed to the correct source extractor (SEEK / LinkedIn / Indeed).
 * Results are persisted to the local SQLite DB unless `noStore` is set.
 */
export async function batchExtract(
  urls: string[],
  opts: BatchExtractOptions = {},
): Promise<BatchResult> {
  const concurrency = opts.concurrency ?? 4;
  const ok: Job[] = [];
  const failed: BatchResult['failed'] = [];

  if (urls.length === 0) return { ok, failed };

  log.info({ count: urls.length, concurrency }, 'batch-extract: launching browser');
  const session = await launchSession();

  try {
    const sem = new Semaphore(concurrency);

    const tasks = urls.map(async (url) => {
      const source = detectSource(url);
      if (!source) {
        log.warn({ url }, 'batch-extract: unsupported URL, skipping');
        failed.push({ url, error: 'unsupported source — only SEEK, LinkedIn, Indeed' });
        return;
      }

      return sem.run(async () => {
        const start = Date.now();
        let page: Page | null = null;
        try {
          page = await session.context.newPage();
          const job = await extractOne(page, url, source);

          if (!opts.noStore) {
            db.upsertJob(job);
          }

          ok.push(job);
          log.info(
            { jobId: job.jobId, source, title: job.title?.slice(0, 40), ms: Date.now() - start },
            'batch-extract: ✓',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ url, err: msg, ms: Date.now() - start }, 'batch-extract: ✗');
          failed.push({ url, error: msg });
        } finally {
          if (page) await page.close().catch(() => {});
        }
      });
    });

    await Promise.all(tasks);
  } finally {
    await closeSession(session);
  }

  log.info({ ok: ok.length, failed: failed.length }, 'batch-extract: done');
  return { ok, failed };
}
