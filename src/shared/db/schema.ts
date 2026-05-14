// Inlined SQL schema — kept in TS so the compiled bin.js works without
// shipping a separate .sql file. The .sql sibling file is the readable
// version; keep them in sync if you edit either.
//
// Schema apply order matters: tables → ALTER migrations → indexes. Indexes
// on the `source` column would fail on a pre-existing DB if we tried to
// build them before the migration adds the column.

export const SCHEMA_TABLES_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  job_id            TEXT PRIMARY KEY,
  source            TEXT NOT NULL DEFAULT 'seek',
  url               TEXT NOT NULL,
  title             TEXT NOT NULL,
  company           TEXT,
  location          TEXT,
  work_type         TEXT,
  classification    TEXT,
  description       TEXT NOT NULL,
  salary_text       TEXT,
  posted_date       TEXT,
  fetched_at        TEXT NOT NULL,
  eligibility_flags TEXT
);

CREATE TABLE IF NOT EXISTS applications (
  job_id            TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
  fit_score         REAL,
  score_out_of_5    REAL,
  recommendation    TEXT,
  status            TEXT NOT NULL DEFAULT 'new',
  one_line_fit      TEXT,
  summary_json      TEXT,
  match_json        TEXT,
  resume_md         TEXT,
  cover_letter_md   TEXT,
  company_brief_md  TEXT,
  output_dir        TEXT,
  generated_at      TEXT,
  model             TEXT,
  profile_hash      TEXT,
  notes             TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at      TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'seek',
  keyword     TEXT NOT NULL,
  location    TEXT,
  days        INTEGER,
  jobs_found  INTEGER NOT NULL DEFAULT 0,
  jobs_new    INTEGER NOT NULL DEFAULT 0
);
`;

export const SCHEMA_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_fetched ON jobs(fetched_at);
CREATE INDEX IF NOT EXISTS idx_jobs_source  ON jobs(source);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_recommendation ON applications(recommendation);
CREATE INDEX IF NOT EXISTS idx_applications_score ON applications(score_out_of_5);
`;

/**
 * Idempotent ALTER TABLE migrations for DBs that were created before the
 * `source` column existed. `CREATE TABLE IF NOT EXISTS` won't add columns
 * to existing tables, so we patch them here. Must run AFTER table DDL and
 * BEFORE index DDL (the idx_jobs_source index targets this column).
 */
export const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'jobs',      column: 'source', ddl: `ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'seek'` },
  { table: 'scan_runs', column: 'source', ddl: `ALTER TABLE scan_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'seek'` },
];
