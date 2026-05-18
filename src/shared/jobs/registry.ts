// Registry of job sources. Tools that don't care which platform a job came
// from import `getSource`, `detectSource`, or `sourceForJobId` from here.
import { BUILTIN_JOB_ID_PREFIX } from '../../tools/builtin-extract/index.js';
import { INDEED_JOB_ID_PREFIX } from '../../tools/indeed-extract/index.js';
import { LINKEDIN_JOB_ID_PREFIX } from '../../tools/linkedin-extract/index.js';
import { BUILTIN_SOURCE } from './builtin.js';
import { INDEED_SOURCE } from './indeed.js';
import { LINKEDIN_SOURCE } from './linkedin.js';
import { SEEK_SOURCE } from './seek.js';
import type { JobSource, JobSourceName } from './types.js';

export const SOURCES: Record<JobSourceName, JobSource> = {
  seek: SEEK_SOURCE,
  linkedin: LINKEDIN_SOURCE,
  indeed: INDEED_SOURCE,
  builtin: BUILTIN_SOURCE,
};

/** Look up a source by name. Throws on unknown name to fail loudly. */
export function getSource(name: JobSourceName): JobSource {
  const s = SOURCES[name];
  if (!s) throw new Error(`Unknown job source: ${name}. Known: ${Object.keys(SOURCES).join(', ')}`);
  return s;
}

/** Auto-detect a source from a URL. Returns null if no source claims the URL. */
export function detectSource(url: string): JobSource | null {
  for (const s of Object.values(SOURCES)) {
    if (s.matchesUrl(url)) return s;
  }
  return null;
}

/**
 * Figure out which source a stored jobId belongs to. LinkedIn / Indeed /
 * Built In IDs are namespace-prefixed (`linkedin:…`, `indeed:…`,
 * `builtin:…`); everything else is assumed SEEK (legacy bare-numeric IDs).
 */
export function sourceForJobId(jobId: string): JobSource {
  if (jobId.startsWith(LINKEDIN_JOB_ID_PREFIX)) return SOURCES.linkedin;
  if (jobId.startsWith(INDEED_JOB_ID_PREFIX)) return SOURCES.indeed;
  if (jobId.startsWith(BUILTIN_JOB_ID_PREFIX)) return SOURCES.builtin;
  return SOURCES.seek;
}

export function listSources(): JobSource[] {
  return Object.values(SOURCES);
}
