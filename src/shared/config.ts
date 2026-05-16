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
