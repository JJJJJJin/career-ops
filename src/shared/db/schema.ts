// Inlined SQL schema — kept in TS so the compiled bin.js works without
// shipping a separate .sql file. The .sql sibling file is the readable
// version; keep them in sync if you edit either.

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  job_id            TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_fetched ON jobs(fetched_at);

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

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_recommendation ON applications(recommendation);
CREATE INDEX IF NOT EXISTS idx_applications_score ON applications(score_out_of_5);

CREATE TABLE IF NOT EXISTS scan_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at      TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  location    TEXT,
  days        INTEGER,
  jobs_found  INTEGER NOT NULL DEFAULT 0,
  jobs_new    INTEGER NOT NULL DEFAULT 0
);
`;
