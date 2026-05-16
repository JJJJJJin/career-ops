// Filesystem-safe slug — used to build output/<source>/<company>-<role>/ paths.
import path from 'node:path';
import { config } from './config.js';
import type { Job, JobSourceName } from './db/types.js';

export function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function applicationSlug(company: string | null, role: string): string {
  const c = slug(company ?? 'unknown');
  const r = slug(role);
  return `${c}-${r}`;
}

/**
 * Absolute output directory for a single job's artefacts. Layout:
 *   <APPLICATIONS_DIR>/<source>/<company-slug>-<role-slug>/
 * The source segment lets you eyeball which platform a result came from
 * (`output/seek/...`, `output/linkedin/...`, `output/indeed/...`).
 */
export function applicationDir(job: Pick<Job, 'source' | 'company' | 'title'>): string {
  return path.join(config.paths.applicationsDir, job.source, applicationSlug(job.company, job.title));
}

/** Same as applicationDir but for callers that already have a slug + source. */
export function applicationDirFor(source: JobSourceName, slugStr: string): string {
  return path.join(config.paths.applicationsDir, source, slugStr);
}
