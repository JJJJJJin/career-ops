// Built In behind the JobSource interface. Thin adapter — the actual
// scraping lives in src/tools/builtin-{search,extract}/.
import type { Job, JobSearchStub } from '../db/types.js';
import { builtinExtract, extractBuiltinJobIdFromUrl } from '../../tools/builtin-extract/index.js';
import { builtinSearch } from '../../tools/builtin-search/index.js';
import type { JobExtractOptions, JobSearchOptions, JobSource } from './types.js';

export const BUILTIN_SOURCE: JobSource = {
  name: 'builtin',
  label: 'Built In',

  matchesUrl(url: string): boolean {
    // builtin.com plus legacy regional hosts (builtinnyc.com, builtinla.com…).
    return /\bbuiltin[a-z]*\.(com|org)\//i.test(url);
  },

  jobIdFromUrl(url: string): string {
    return extractBuiltinJobIdFromUrl(url);
  },

  async extract(url: string, opts: JobExtractOptions = {}): Promise<Job> {
    return builtinExtract(url, opts);
  },

  async search(opts: JobSearchOptions = {}): Promise<JobSearchStub[]> {
    const results = await builtinSearch(opts);
    return results.map((r) => ({
      jobId: r.jobId,
      source: 'builtin',
      url: r.url,
      title: r.title,
      company: r.company,
      location: r.location,
      matchedKeyword: r.matchedKeyword,
      isNew: r.isNew,
    }));
  },
};
