-- career-ops SQLite schema. Three tables: jobs (raw), applications (LLM-derived
-- + human status), scan_runs (history of seek-search invocations).
--
-- Apply via DbStore.init() — uses CREATE TABLE IF NOT EXISTS so safe to re-run.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  job_id            TEXT PRIMARY KEY,
  source            TEXT NOT NULL DEFAULT 'seek',  -- 'seek' | 'linkedin' | …
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
  eligibility_flags TEXT,  -- JSON array of {flag, evidence}
  apply_type        TEXT,  -- 'quick' | 'external' | 'unknown' (SEEK apply button)
  external_apply_url TEXT  -- destination when apply_type='external'
);

CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_fetched ON jobs(fetched_at);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);

CREATE TABLE IF NOT EXISTS applications (
  job_id            TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
  fit_score         REAL,
  score_out_of_5    REAL,
  recommendation    TEXT,                          -- STRONG | BORDERLINE | SKIP | NOT_FOR_YOU
  status            TEXT NOT NULL DEFAULT 'new',   -- new | interested | applied | interview | rejected | offer | skip
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
  apply_method      TEXT,   -- 'quick' | 'external'
  applied_at        TEXT,
  apply_state       TEXT,   -- 'submitted' | 'filled_pending_review' | 'external_pending' | 'failed'
  apply_resume_path TEXT,
  apply_answers_json TEXT,  -- audit trail of employer-question answers
  apply_error       TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_recommendation ON applications(recommendation);
CREATE INDEX IF NOT EXISTS idx_applications_score ON applications(score_out_of_5);

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

-- Agent engine: learned element selectors keyed by (flow, step, page signature).
-- A cache hit lets the flow runner skip the LLM resolver — the main perf lever
-- on a Raspberry Pi.
CREATE TABLE IF NOT EXISTS selector_cache (
  flow_id     TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  page_sig    TEXT NOT NULL,
  action      TEXT NOT NULL,
  locator     TEXT,
  value_tmpl  TEXT,
  confidence  REAL,
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (flow_id, step_id, page_sig)
);
