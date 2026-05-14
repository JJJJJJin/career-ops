// SQLite store wrapper. Singleton — every tool imports `db` from here.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { SCHEMA_TABLES_SQL, SCHEMA_INDEXES_SQL, MIGRATIONS } from './schema.js';
import type {
  ApplicationRow,
  ApplicationStatus,
  EligibilityFlag,
  Job,
  JobSourceName,
  JobSummary,
  MatchAnalysis,
  ScanRunRow,
} from './types.js';

const log = createLogger('db');

type JobRow = {
  job_id: string;
  source: string;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  work_type: string | null;
  classification: string | null;
  description: string;
  salary_text: string | null;
  posted_date: string | null;
  fetched_at: string;
  eligibility_flags: string | null;
};

type AppRow = {
  job_id: string;
  fit_score: number | null;
  score_out_of_5: number | null;
  recommendation: string | null;
  status: string;
  one_line_fit: string | null;
  summary_json: string | null;
  match_json: string | null;
  resume_md: string | null;
  cover_letter_md: string | null;
  company_brief_md: string | null;
  output_dir: string | null;
  generated_at: string | null;
  model: string | null;
  profile_hash: string | null;
  notes: string | null;
  updated_at: string;
};

function rowToJob(row: JobRow): Job {
  return {
    jobId: row.job_id,
    source: (row.source as JobSourceName) ?? 'seek',
    url: row.url,
    title: row.title,
    company: row.company,
    location: row.location,
    workType: row.work_type,
    classification: row.classification,
    description: row.description,
    salaryText: row.salary_text,
    postedDate: row.posted_date,
    fetchedAt: row.fetched_at,
    eligibilityFlags: row.eligibility_flags ? (JSON.parse(row.eligibility_flags) as EligibilityFlag[]) : [],
  };
}

function rowToApplication(row: AppRow): ApplicationRow {
  return {
    jobId: row.job_id,
    fitScore: row.fit_score,
    scoreOutOf5: row.score_out_of_5,
    recommendation: (row.recommendation as ApplicationRow['recommendation']) ?? null,
    status: (row.status as ApplicationStatus) ?? 'new',
    oneLineFit: row.one_line_fit,
    summary: row.summary_json ? (JSON.parse(row.summary_json) as JobSummary) : null,
    match: row.match_json ? (JSON.parse(row.match_json) as MatchAnalysis) : null,
    resumeMd: row.resume_md,
    coverLetterMd: row.cover_letter_md,
    companyBriefMd: row.company_brief_md,
    outputDir: row.output_dir,
    generatedAt: row.generated_at,
    model: row.model,
    profileHash: row.profile_hash,
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}

class DbStore {
  private _db: Database.Database | null = null;

  private get db(): Database.Database {
    if (!this._db) {
      const dbPath = config.paths.dbPath;
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      log.debug({ dbPath }, 'db: opening');
      this._db = new Database(dbPath);
      this.applySchema(this._db);
    }
    return this._db;
  }

  private applySchema(db: Database.Database): void {
    // 1. Tables first (CREATE TABLE IF NOT EXISTS — no-op on existing DBs).
    db.exec(SCHEMA_TABLES_SQL);
    // 2. ALTER TABLE migrations to add columns that may not exist on
    //    pre-existing DBs. Must run BEFORE indexes that target those columns.
    for (const m of MIGRATIONS) {
      const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === m.column)) {
        log.info({ table: m.table, column: m.column }, 'db: applying migration');
        db.exec(m.ddl);
      }
    }
    // 3. Indexes last — `source` column is guaranteed to exist by now.
    db.exec(SCHEMA_INDEXES_SQL);
  }

  init(): void {
    void this.db;
  }

  close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }

  // ─── jobs ────────────────────────────────────────────────────────────
  upsertJob(job: Job): void {
    const stmt = this.db.prepare(`
      INSERT INTO jobs (job_id, source, url, title, company, location, work_type, classification,
                        description, salary_text, posted_date, fetched_at, eligibility_flags)
      VALUES (@job_id, @source, @url, @title, @company, @location, @work_type, @classification,
              @description, @salary_text, @posted_date, @fetched_at, @eligibility_flags)
      ON CONFLICT(job_id) DO UPDATE SET
        source = excluded.source,
        url = excluded.url,
        title = excluded.title,
        company = excluded.company,
        location = excluded.location,
        work_type = excluded.work_type,
        classification = excluded.classification,
        description = excluded.description,
        salary_text = excluded.salary_text,
        posted_date = excluded.posted_date,
        fetched_at = excluded.fetched_at,
        eligibility_flags = excluded.eligibility_flags
    `);
    stmt.run({
      job_id: job.jobId,
      source: job.source,
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location,
      work_type: job.workType,
      classification: job.classification,
      description: job.description,
      salary_text: job.salaryText,
      posted_date: job.postedDate,
      fetched_at: job.fetchedAt,
      eligibility_flags: job.eligibilityFlags.length ? JSON.stringify(job.eligibilityFlags) : null,
    });
  }

  /** Insert a thin job stub from a search result. Will not overwrite an existing row. */
  upsertJobStub(stub: {
    jobId: string;
    source: JobSourceName;
    url: string;
    title: string;
    company: string | null;
  }): boolean {
    const stmt = this.db.prepare(`
      INSERT INTO jobs (job_id, source, url, title, company, description, fetched_at)
      VALUES (@job_id, @source, @url, @title, @company, '', @fetched_at)
      ON CONFLICT(job_id) DO NOTHING
    `);
    const result = stmt.run({
      job_id: stub.jobId,
      source: stub.source,
      url: stub.url,
      title: stub.title,
      company: stub.company,
      fetched_at: new Date().toISOString(),
    });
    return result.changes > 0;
  }

  getJob(jobId: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  findJobByUrl(url: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE url = ?`).get(url) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  setEligibilityFlags(jobId: string, flags: EligibilityFlag[]): void {
    this.db
      .prepare(`UPDATE jobs SET eligibility_flags = ? WHERE job_id = ?`)
      .run(flags.length ? JSON.stringify(flags) : null, jobId);
  }

  // ─── applications ────────────────────────────────────────────────────
  ensureApplication(jobId: string): void {
    this.db
      .prepare(`INSERT INTO applications (job_id) VALUES (?) ON CONFLICT(job_id) DO NOTHING`)
      .run(jobId);
  }

  getApplication(jobId: string): ApplicationRow | null {
    const row = this.db.prepare(`SELECT * FROM applications WHERE job_id = ?`).get(jobId) as AppRow | undefined;
    return row ? rowToApplication(row) : null;
  }

  updateApplicationFields(jobId: string, fields: Partial<{
    fitScore: number;
    scoreOutOf5: number;
    recommendation: MatchAnalysis['recommendation'];
    status: ApplicationStatus;
    oneLineFit: string;
    summary: JobSummary;
    match: MatchAnalysis;
    resumeMd: string;
    coverLetterMd: string;
    companyBriefMd: string;
    outputDir: string;
    generatedAt: string;
    model: string;
    profileHash: string;
    notes: string;
  }>): void {
    this.ensureApplication(jobId);
    const sets: string[] = [];
    const params: Record<string, unknown> = { job_id: jobId };

    const map: Array<[keyof typeof fields, string, (v: unknown) => unknown]> = [
      ['fitScore', 'fit_score', (v) => v],
      ['scoreOutOf5', 'score_out_of_5', (v) => v],
      ['recommendation', 'recommendation', (v) => v],
      ['status', 'status', (v) => v],
      ['oneLineFit', 'one_line_fit', (v) => v],
      ['summary', 'summary_json', (v) => (v ? JSON.stringify(v) : null)],
      ['match', 'match_json', (v) => (v ? JSON.stringify(v) : null)],
      ['resumeMd', 'resume_md', (v) => v],
      ['coverLetterMd', 'cover_letter_md', (v) => v],
      ['companyBriefMd', 'company_brief_md', (v) => v],
      ['outputDir', 'output_dir', (v) => v],
      ['generatedAt', 'generated_at', (v) => v],
      ['model', 'model', (v) => v],
      ['profileHash', 'profile_hash', (v) => v],
      ['notes', 'notes', (v) => v],
    ];

    for (const [key, col, mapVal] of map) {
      if (fields[key] !== undefined) {
        sets.push(`${col} = @${col}`);
        params[col] = mapVal(fields[key]);
      }
    }

    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);

    const sql = `UPDATE applications SET ${sets.join(', ')} WHERE job_id = @job_id`;
    this.db.prepare(sql).run(params);
  }

  setStatus(jobId: string, status: ApplicationStatus, notes?: string): void {
    const fields: Parameters<typeof this.updateApplicationFields>[1] = { status };
    if (notes !== undefined) fields.notes = notes;
    this.updateApplicationFields(jobId, fields);
  }

  // ─── queries ─────────────────────────────────────────────────────────
  listJobs(opts: {
    sinceDays?: number;
    eligibleOnly?: boolean;
    ineligibleOnly?: boolean;
    keyword?: string;
    company?: string;
    source?: JobSourceName;
    minScore?: number;
    status?: ApplicationStatus;
    limit?: number;
  } = {}): Array<{ job: Job; application: ApplicationRow | null }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.sinceDays !== undefined) {
      params.since = new Date(Date.now() - opts.sinceDays * 86400_000).toISOString();
      where.push(`j.fetched_at >= @since`);
    }
    if (opts.eligibleOnly) {
      where.push(`(j.eligibility_flags IS NULL OR j.eligibility_flags = '[]')`);
    }
    if (opts.ineligibleOnly) {
      where.push(`(j.eligibility_flags IS NOT NULL AND j.eligibility_flags != '[]')`);
    }
    if (opts.keyword) {
      params.kw = `%${opts.keyword.toLowerCase()}%`;
      where.push(`(LOWER(j.title) LIKE @kw OR LOWER(j.company) LIKE @kw OR LOWER(j.description) LIKE @kw)`);
    }
    if (opts.company) {
      params.co = `%${opts.company.toLowerCase()}%`;
      where.push(`LOWER(j.company) LIKE @co`);
    }
    if (opts.source) {
      params.source = opts.source;
      where.push(`j.source = @source`);
    }
    if (opts.minScore !== undefined) {
      params.minScore = opts.minScore;
      where.push(`a.score_out_of_5 >= @minScore`);
    }
    if (opts.status) {
      params.status = opts.status;
      where.push(`a.status = @status`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitSql = opts.limit ? `LIMIT ${opts.limit}` : '';

    const sql = `
      SELECT j.*, a.* FROM jobs j
      LEFT JOIN applications a ON a.job_id = j.job_id
      ${whereSql}
      ORDER BY COALESCE(a.score_out_of_5, 0) DESC, j.fetched_at DESC
      ${limitSql}
    `;

    const rows = this.db.prepare(sql).all(params) as Array<JobRow & Partial<AppRow>>;
    return rows.map((row) => {
      const job = rowToJob(row);
      const hasApp = row.status !== undefined;
      const application = hasApp ? rowToApplication(row as AppRow) : null;
      return { job, application };
    });
  }

  // ─── scan history ────────────────────────────────────────────────────
  recordScanRun(run: Omit<ScanRunRow, 'id'>): void {
    this.db
      .prepare(`
        INSERT INTO scan_runs (ran_at, source, keyword, location, days, jobs_found, jobs_new)
        VALUES (@ran_at, @source, @keyword, @location, @days, @jobs_found, @jobs_new)
      `)
      .run({
        ran_at: run.ranAt,
        source: run.source,
        keyword: run.keyword,
        location: run.location,
        days: run.days,
        jobs_found: run.jobsFound,
        jobs_new: run.jobsNew,
      });
  }

  // ─── stats ───────────────────────────────────────────────────────────
  stats(): {
    totalJobs: number;
    eligibleJobs: number;
    ineligibleJobs: number;
    byStatus: Record<string, number>;
    byRecommendation: Record<string, number>;
    bySource: Record<string, number>;
    scoreBuckets: { strong: number; borderline: number; skip: number; unscored: number };
  } {
    const totalJobs = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n;
    const ineligibleJobs = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE eligibility_flags IS NOT NULL AND eligibility_flags != '[]'`)
        .get() as { n: number }
    ).n;
    const eligibleJobs = totalJobs - ineligibleJobs;

    const statusRows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM applications GROUP BY status`)
      .all() as Array<{ status: string; n: number }>;
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r.n;

    const recRows = this.db
      .prepare(`SELECT recommendation, COUNT(*) AS n FROM applications WHERE recommendation IS NOT NULL GROUP BY recommendation`)
      .all() as Array<{ recommendation: string; n: number }>;
    const byRecommendation: Record<string, number> = {};
    for (const r of recRows) byRecommendation[r.recommendation] = r.n;

    const sourceRows = this.db
      .prepare(`SELECT source, COUNT(*) AS n FROM jobs GROUP BY source`)
      .all() as Array<{ source: string; n: number }>;
    const bySource: Record<string, number> = {};
    for (const r of sourceRows) bySource[r.source] = r.n;

    const strong = (this.db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE recommendation = 'STRONG'`).get() as { n: number }).n;
    const borderline = (this.db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE recommendation = 'BORDERLINE'`).get() as { n: number }).n;
    const skip = (this.db.prepare(`SELECT COUNT(*) AS n FROM applications WHERE recommendation IN ('SKIP', 'NOT_FOR_YOU')`).get() as { n: number }).n;
    const unscored = (this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE job_id NOT IN (SELECT job_id FROM applications WHERE recommendation IS NOT NULL)`).get() as { n: number }).n;

    return {
      totalJobs,
      eligibleJobs,
      ineligibleJobs,
      byStatus,
      byRecommendation,
      bySource,
      scoreBuckets: { strong, borderline, skip, unscored },
    };
  }
}

export const db = new DbStore();
