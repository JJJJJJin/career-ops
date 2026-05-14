// SEEK behind the JobSource interface. Thin adapter — the actual scraping
// lives in src/tools/seek-{search,extract}/.
import type { Job, JobSearchStub } from '../db/types.js';
import { seekExtract, extractJobIdFromUrl } from '../../tools/seek-extract/index.js';
import { seekSearch } from '../../tools/seek-search/index.js';
import type { JobExtractOptions, JobSearchOptions, JobSource } from './types.js';

export const SEEK_SOURCE: JobSource = {
  name: 'seek',
  label: 'SEEK Australia',

  matchesUrl(url: string): boolean {
    return /\bseek\.com\.au\//i.test(url);
  },

  jobIdFromUrl(url: string): string {
    return extractJobIdFromUrl(url);
  },

  async extract(url: string, opts: JobExtractOptions = {}): Promise<Job> {
    return seekExtract(url, opts);
  },

  async search(opts: JobSearchOptions = {}): Promise<JobSearchStub[]> {
    const results = await seekSearch(opts);
    return results.map((r) => ({
      jobId: r.jobId,
      source: 'seek',
      url: r.url,
      title: r.title,
      company: r.company,
      location: r.location,
      matchedKeyword: r.matchedKeyword,
      isNew: r.isNew,
    }));
  },
};
