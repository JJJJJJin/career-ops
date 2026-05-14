// LinkedIn behind the JobSource interface. Thin adapter — the actual
// scraping lives in src/tools/linkedin-{search,extract}/.
import type { Job, JobSearchStub } from '../db/types.js';
import { linkedinExtract, extractLinkedInJobIdFromUrl } from '../../tools/linkedin-extract/index.js';
import { linkedinSearch } from '../../tools/linkedin-search/index.js';
import type { JobExtractOptions, JobSearchOptions, JobSource } from './types.js';

export const LINKEDIN_SOURCE: JobSource = {
  name: 'linkedin',
  label: 'LinkedIn',

  matchesUrl(url: string): boolean {
    return /\blinkedin\.com\//i.test(url);
  },

  jobIdFromUrl(url: string): string {
    return extractLinkedInJobIdFromUrl(url);
  },

  async extract(url: string, opts: JobExtractOptions = {}): Promise<Job> {
    return linkedinExtract(url, opts);
  },

  async search(opts: JobSearchOptions = {}): Promise<JobSearchStub[]> {
    const results = await linkedinSearch(opts);
    return results.map((r) => ({
      jobId: r.jobId,
      source: 'linkedin',
      url: r.url,
      title: r.title,
      company: r.company,
      location: r.location,
      matchedKeyword: r.matchedKeyword,
      isNew: r.isNew,
    }));
  },
};
