// Filesystem-safe naming for per-job artefacts.
//
// Two distinct names:
//   • FOLDER  <company>-<position>-<date>   — local organisation; company name
//     is fine here because the folder never leaves your machine.
//   • FILES   <Name>-<Position>-<phone>     — these are what an employer's HR
//     sees (the uploaded resume/cover filename), so they carry YOUR identity
//     (name, role, phone) and NOT the company name.
import path from 'node:path';
import { config } from './config.js';
import { ensureLibrary } from './library/parse.js';
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
  return `${slug(company ?? 'unknown')}-${slug(role)}`;
}

/** Readable, case-preserved position token for file names, e.g. "Software-Developer-Internship". */
function positionToken(role: string): string {
  return (role || 'Role')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Date segment for the folder: posting date if known, else fetched date. YYYY-MM-DD. */
function dateSegment(job: Pick<Job, 'postedDate' | 'fetchedAt'>): string {
  const raw = job.postedDate || job.fetchedAt || '';
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return (raw.slice(0, 10) || 'undated');
}

// Cache the applicant identity (name + phone) read from the content library.
let _identity: { name: string; phone: string } | null = null;
function applicantIdentity(): { name: string; phone: string } {
  if (_identity) return _identity;
  let name = 'Applicant';
  let phone = '';
  try {
    const { library } = ensureLibrary();
    if (library.contact.name) name = library.contact.name;
    if (library.contact.phone) phone = library.contact.phone;
  } catch {
    /* fall back to defaults */
  }
  const nameToken = name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '');
  const phoneDigits = phone.replace(/\D/g, '');
  _identity = { name: nameToken || 'Applicant', phone: phoneDigits };
  return _identity;
}

/**
 * HR-facing file-name base for a job's artefacts: <Name>-<Position>-<phone>.
 * No company name (the employer sees this filename). Used as the prefix for
 * <base>-resume.pdf, <base>-cover_letter.pdf, etc.
 */
export function artefactBase(job: Pick<Job, 'title'>): string {
  const { name, phone } = applicantIdentity();
  return [name, positionToken(job.title), phone].filter(Boolean).join('-');
}

/**
 * Absolute output directory for a job's artefacts:
 *   <APPLICATIONS_DIR>/<source>/<company>-<position>-<date>/
 */
export function applicationDir(job: Pick<Job, 'source' | 'company' | 'title' | 'postedDate' | 'fetchedAt'>): string {
  const folder = `${slug(job.company ?? 'unknown')}-${slug(job.title)}-${dateSegment(job)}`;
  return path.join(config.paths.applicationsDir, job.source, folder);
}

/** Same as applicationDir but for callers that already have a folder name + source. */
export function applicationDirFor(source: JobSourceName, folderName: string): string {
  return path.join(config.paths.applicationsDir, source, folderName);
}
