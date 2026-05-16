// Indeed behind the JobSource interface. Thin adapter — the actual
// scraping lives in src/tools/indeed-{search,extract}/.
import type { Job, JobSearchStub } from '../db/types.js';
import { indeedExtract, extractIndeedJobIdFromUrl } from '../../tools/indeed-extract/index.js';
import { indeedSearch } from '../../tools/indeed-search/index.js';
import type { JobExtractOptions, JobSearchOptions, JobSource } from './types.js';

export const INDEED_SOURCE: JobSource = {
  name: 'indeed',
  label: 'Indeed Australia',

  matchesUrl(url: string): boolean {
    return /\bindeed\.[a-z.]+\//i.test(url);
  },

  jobIdFromUrl(url: string): string {
    return extractIndeedJobIdFromUrl(url);
  },

  async extract(url: string, opts: JobExtractOptions = {}): Promise<Job> {
    return indeedExtract(url, opts);
  },

  async search(opts: JobSearchOptions = {}): Promise<JobSearchStub[]> {
    const results = await indeedSearch(opts);
    return results.map((r) => ({
      jobId: r.jobId,
      source: 'indeed',
      url: r.url,
      title: r.title,
      company: r.company,
      location: r.location,
      matchedKeyword: r.matchedKeyword,
      isNew: r.isNew,
    }));
  },
};
