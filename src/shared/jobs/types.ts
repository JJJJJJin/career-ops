// Source-agnostic job abstraction. Each platform (SEEK, LinkedIn, …) ships a
// JobSource implementation; downstream tools (evaluate-job, generate-*, etc.)
// work against `Job` and never know which platform produced the data.

import type { Page } from 'playwright';
import type { Job, JobSearchStub } from '../db/types.js';

export type { Job, JobSearchStub };

/** Platform identifier. Add new keys here when wiring a new source. */
export type JobSourceName = 'seek' | 'linkedin' | 'indeed' | 'builtin';

export type JobSearchOptions = {
  keywords?: string[];
  location?: string;
  /** Date-range in days. Each source maps to its own supported window. */
  days?: number;
  maxJobsPerKeyword?: number;
  /** Drop senior/lead/principal titles. */
  includeSenior?: boolean;
  /** Skip writing stubs to the DB. */
  noStore?: boolean;
};

export type JobExtractOptions = {
  /** Skip LLM fallback if the page parse comes back thin. */
  noLlm?: boolean;
  noStore?: boolean;
  reextract?: boolean;
  /**
   * Reuse an already-open live page (the stateful MCP browser session) instead
   * of launching a throwaway browser. Critical for anti-bot-heavy sources like
   * Indeed: a warmed-up, cookie-bearing session gets through where a cold
   * headless launch is Cloudflare-challenged.
   */
  page?: Page;
};

/**
 * Each platform conforms to this interface. The downstream pipeline
 * (evaluate-job, apply-job, daily-pipeline) dispatches through the
 * registry rather than calling SEEK or LinkedIn directly.
 */
export interface JobSource {
  /** Stable identifier — also the value persisted in jobs.source. */
  readonly name: JobSourceName;

  /** Human-friendly label for logs and CLI output. */
  readonly label: string;

  /** Returns true if the URL belongs to this source. Used for auto-detect. */
  matchesUrl(url: string): boolean;

  /**
   * Derive a globally-unique jobId from a URL. SEEK keeps numeric IDs
   * as-is (legacy); LinkedIn prefixes with `linkedin:` to disambiguate.
   */
  jobIdFromUrl(url: string): string;

  /** Pull a single posting and persist it. */
  extract(url: string, opts?: JobExtractOptions): Promise<Job>;

  /** Keyword search; returns thin stubs. Optional for sources that don't support search. */
  search?(opts?: JobSearchOptions): Promise<JobSearchStub[]>;
}
