// Centralized env loading. All paths resolve to absolute against repo root.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defaultModelFor, PROVIDERS, type ProviderName } from './llm/providers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/shared/config.ts → repo root is two levels up.
export const REPO_ROOT = path.resolve(here, '../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env') });

function resolvePath(value: string | undefined, fallback: string): string {
  const raw = value && value.trim() ? value : fallback;
  return path.isAbsolute(raw) ? raw : path.join(REPO_ROOT, raw);
}

function parseInt10(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloat10(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseProvider(value: string | undefined, fallback: ProviderName): ProviderName {
  if (!value) return fallback;
  if (value in PROVIDERS) return value as ProviderName;
  throw new Error(
    `Invalid provider "${value}". Valid: ${Object.keys(PROVIDERS).join(', ')}.`,
  );
}

const primaryProvider = parseProvider(process.env.LLM_PROVIDER, 'openai');
const fallbackProvider = process.env.LLM_FALLBACK_PROVIDER === ''
  ? null
  : parseProvider(process.env.LLM_FALLBACK_PROVIDER, 'deepseek');

export const config = {
  repoRoot: REPO_ROOT,

  llm: {
    provider: primaryProvider,
    model: process.env.LLM_MODEL ?? defaultModelFor(primaryProvider),
    fallbackProvider,
    fallbackModel:
      fallbackProvider === null
        ? null
        : process.env.LLM_FALLBACK_MODEL ?? defaultModelFor(fallbackProvider),
  },

  search: {
    keywords: parseList(process.env.SEARCH_KEYWORDS, [
      'graduate software engineer',
      'junior software engineer',
      'ai engineer',
      'machine learning engineer',
    ]),
    location: process.env.SEARCH_LOCATION ?? 'All Australia',
    days: parseInt10(process.env.DATE_RANGE_DAYS, 7),
    maxJobsPerKeyword: parseInt10(process.env.MAX_JOBS_PER_KEYWORD, 40),
  },

  browser: {
    headless: parseBool(process.env.HEADLESS, true),
    slowMoMs: parseInt10(process.env.SLOW_MO_MS, 120),
    // Persist the browser profile across launches? Default OFF = a fresh,
    // ephemeral context every launch (like opening an incognito window) — no
    // accumulated cookies/cf_clearance, no profile-lock or stale-reputation
    // baggage. What actually gets us past Cloudflare is the real-Chrome+stealth
    // fingerprint, not stored cookies; persistence only lets you skip a check
    // you already passed, at the cost of carrying any flags forward too.
    // Turn ON (BROWSER_PERSIST=true) to keep a warm profile that passes the
    // human-check once then reuses cf_clearance.
    persist: parseBool(process.env.BROWSER_PERSIST, false),
    // Profile dir used only when persist is on. NOT your real Chrome profile —
    // a dedicated dir Playwright owns. Gitignored (under data/).
    userDataDir: resolvePath(process.env.BROWSER_USER_DATA_DIR, 'data/browser-profile'),
  },

  seek: {
    // Credentials for unattended re-login. The persisted session (below) is
    // tried first; these are the fallback when it has expired. SEEK may still
    // demand an emailed code/captcha — then a one-off `seek-login --manual`
    // (headful) establishes the session by hand and caches it.
    email: process.env.SEEK_EMAIL ?? '',
    password: process.env.SEEK_PASSWORD ?? '',
    authStatePath: resolvePath(process.env.SEEK_AUTH_STATE_PATH, 'data/seek-auth.json'),
    baseUrl: 'https://www.seek.com.au',
    // Filename substring of a resume to keep pinned as the Profile default:
    // never deleted during rotation, re-set as default after each upload.
    protectedResume: (process.env.SEEK_PROTECTED_RESUME ?? '').trim(),
    // MASTER SAFETY SWITCH. Submission only happens when this is true AND the
    // run is invoked with --submit. Default false = test mode: every run stops
    // at the review page and never clicks "Submit application".
    allowSubmit: parseBool(process.env.SEEK_ALLOW_SUBMIT, false),
    // Batch caps.
    maxAppliesPerRun: parseInt10(process.env.SEEK_MAX_APPLIES_PER_RUN, 5),
    applyMinScore: parseFloat10(process.env.SEEK_APPLY_MIN_SCORE, parseFloat10(process.env.SCORE_THRESHOLD_STRONG, 4.0)),
    // In a batch, run resume cleanup (seek_resume_delete_old) at the start and
    // after every N applications, since each quick-apply UPLOADS a resume that
    // counts toward SEEK's 10-resume cap. Default 9 = cap (10) − 1 protected default.
    applyCleanupEvery: parseInt10(process.env.SEEK_APPLY_CLEANUP_EVERY, 9),
  },

  render: {
    // Max time to wait for webfonts to finish loading before snapshotting.
    // Generous default so slow SD-card I/O (Raspberry Pi) doesn't time out.
    fontTimeoutMs: parseInt10(process.env.PDF_FONT_TIMEOUT_MS, 30000),
    // Extra settle after fonts report loaded, so the print-media reflow
    // has actually painted. Bump via env on very slow hosts (Pi: ~800).
    settleMs: parseInt10(process.env.PDF_RENDER_SETTLE_MS, 600),
  },

  paths: {
    profileDir: resolvePath(process.env.PROFILE_DIR, 'profile'),
    dbPath: resolvePath(process.env.DB_PATH, 'data/seek.sqlite3'),
    applicationsDir: resolvePath(process.env.APPLICATIONS_DIR, 'output'),
    reportsDir: resolvePath(process.env.REPORTS_DIR, 'reports'),
    templatesDir: path.join(REPO_ROOT, 'templates'),
    fontsDir: path.join(REPO_ROOT, 'fonts'),
  },

  scoring: {
    strongThreshold: parseFloat10(process.env.SCORE_THRESHOLD_STRONG, 4.0),
    borderlineThreshold: 3.0,
  },
} as const;

export function profileMarkdownPath(): string {
  return path.join(config.paths.profileDir, 'profile.md');
}

export function profileJsonPath(): string {
  return path.join(config.paths.profileDir, 'profile.json');
}
