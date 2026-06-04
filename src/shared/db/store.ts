// SQLite store wrapper. Singleton — every tool imports `db` from here.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { SCHEMA_TABLES_SQL, SCHEMA_INDEXES_SQL, MIGRATIONS } from './schema.js';
import type {
  AgentRun,
  AgentRunStatus,
  ApplicationRow,
  ApplicationStatus,
  ApplyAnswer,
  ApplyMethod,
  ApplyState,
  EligibilityFlag,
  Job,
  JobSourceName,
  JobSummary,
  MatchAnalysis,
  ScanRunRow,
  SelectorCacheEntry,
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
  apply_type: string | null;
  external_apply_url: string | null;
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
  apply_method: string | null;
  applied_at: string | null;
  apply_state: string | null;
  apply_resume_path: string | null;
  apply_answers_json: string | null;
  apply_error: string | null;
  updated_at: string;
};

type AgentRunRow = {
  run_id: string;
  workflow: string | null;
  goal: string | null;
  vars_json: string | null;
  current_step: string | null;
  status: string;
  steps_json: string | null;
  started_at: string;
  updated_at: string;
};

function rowToAgentRun(row: AgentRunRow): AgentRun {
  return {
    runId: row.run_id,
    workflow: row.workflow,
    goal: row.goal,
    vars: row.vars_json ? (JSON.parse(row.vars_json) as Record<string, unknown>) : {},
    currentStep: row.current_step,
    status: row.status as AgentRunStatus,
    steps: row.steps_json ? (JSON.parse(row.steps_json) as Array<{ ts: string; note: string }>) : [],
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

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
    applyType: (row.apply_type as Job['applyType']) ?? null,
    externalApplyUrl: row.external_apply_url ?? null,
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
    applyMethod: (row.apply_method as ApplyMethod) ?? null,
    appliedAt: row.applied_at,
    applyState: (row.apply_state as ApplyState) ?? null,
    applyResumePath: row.apply_resume_path,
    applyAnswers: row.apply_answers_json ? (JSON.parse(row.apply_answers_json) as ApplyAnswer[]) : null,
    applyError: row.apply_error,
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
                        description, salary_text, posted_date, fetched_at, eligibility_flags,
                        apply_type, external_apply_url)
      VALUES (@job_id, @source, @url, @title, @company, @location, @work_type, @classification,
              @description, @salary_text, @posted_date, @fetched_at, @eligibility_flags,
              @apply_type, @external_apply_url)
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
        eligibility_flags = excluded.eligibility_flags,
        apply_type = excluded.apply_type,
        external_apply_url = excluded.external_apply_url
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
      apply_type: job.applyType ?? null,
      external_apply_url: job.externalApplyUrl ?? null,
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
    applyMethod: ApplyMethod;
    appliedAt: string;
    applyState: ApplyState;
    applyResumePath: string;
    applyAnswers: ApplyAnswer[];
    applyError: string;
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
      ['applyMethod', 'apply_method', (v) => v],
      ['appliedAt', 'applied_at', (v) => v],
      ['applyState', 'apply_state', (v) => v],
      ['applyResumePath', 'apply_resume_path', (v) => v],
      ['applyAnswers', 'apply_answers_json', (v) => (v ? JSON.stringify(v) : null)],
      ['applyError', 'apply_error', (v) => v],
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

  // ─── selector cache (agent engine) ───────────────────────────────────
  getSelectorCache(flowId: string, stepId: string, pageSig: string): SelectorCacheEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM selector_cache WHERE flow_id = ? AND step_id = ? AND page_sig = ?`)
      .get(flowId, stepId, pageSig) as
      | {
          flow_id: string;
          step_id: string;
          page_sig: string;
          action: string;
          locator: string | null;
          value_tmpl: string | null;
          confidence: number | null;
          hits: number;
        }
      | undefined;
    if (!row) return null;
    return {
      flowId: row.flow_id,
      stepId: row.step_id,
      pageSig: row.page_sig,
      action: row.action,
      locator: row.locator,
      valueTmpl: row.value_tmpl,
      confidence: row.confidence,
      hits: row.hits,
    };
  }

  putSelectorCache(entry: Omit<SelectorCacheEntry, 'hits'>): void {
    this.db
      .prepare(`
        INSERT INTO selector_cache (flow_id, step_id, page_sig, action, locator, value_tmpl, confidence, hits, created_at, updated_at)
        VALUES (@flow_id, @step_id, @page_sig, @action, @locator, @value_tmpl, @confidence, 0, datetime('now'), datetime('now'))
        ON CONFLICT(flow_id, step_id, page_sig) DO UPDATE SET
          action = excluded.action,
          locator = excluded.locator,
          value_tmpl = excluded.value_tmpl,
          confidence = excluded.confidence,
          updated_at = datetime('now')
      `)
      .run({
        flow_id: entry.flowId,
        step_id: entry.stepId,
        page_sig: entry.pageSig,
        action: entry.action,
        locator: entry.locator,
        value_tmpl: entry.valueTmpl,
        confidence: entry.confidence,
      });
  }

  bumpSelectorCacheHit(flowId: string, stepId: string, pageSig: string): void {
    this.db
      .prepare(`UPDATE selector_cache SET hits = hits + 1, updated_at = datetime('now') WHERE flow_id = ? AND step_id = ? AND page_sig = ?`)
      .run(flowId, stepId, pageSig);
  }

  deleteSelectorCache(flowId: string, stepId: string, pageSig: string): void {
    this.db
      .prepare(`DELETE FROM selector_cache WHERE flow_id = ? AND step_id = ? AND page_sig = ?`)
      .run(flowId, stepId, pageSig);
  }

  // ─── MCP agent runs (durable workflow progress) ──────────────────────
  saveAgentRun(run: AgentRun): void {
    this.db
      .prepare(`
        INSERT INTO agent_runs (run_id, workflow, goal, vars_json, current_step, status, steps_json, started_at, updated_at)
        VALUES (@run_id, @workflow, @goal, @vars_json, @current_step, @status, @steps_json, @started_at, datetime('now'))
        ON CONFLICT(run_id) DO UPDATE SET
          workflow = excluded.workflow,
          goal = excluded.goal,
          vars_json = excluded.vars_json,
          current_step = excluded.current_step,
          status = excluded.status,
          steps_json = excluded.steps_json,
          updated_at = datetime('now')
      `)
      .run({
        run_id: run.runId,
        workflow: run.workflow,
        goal: run.goal,
        vars_json: JSON.stringify(run.vars ?? {}),
        current_step: run.currentStep,
        status: run.status,
        steps_json: JSON.stringify(run.steps ?? []),
        started_at: run.startedAt,
      });
  }

  getAgentRun(runId: string): AgentRun | null {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`).get(runId) as AgentRunRow | undefined;
    return row ? rowToAgentRun(row) : null;
  }

  latestAgentRun(): AgentRun | null {
    const row = this.db.prepare(`SELECT * FROM agent_runs ORDER BY updated_at DESC LIMIT 1`).get() as AgentRunRow | undefined;
    return row ? rowToAgentRun(row) : null;
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

  // ─── gap tracker ─────────────────────────────────────────────────────
  /** Replace this job's gaps with a fresh set (idempotent across re-runs). */
  recordGaps(jobId: string, gaps: Array<{ requirement: string; kind: string }>): void {
    const del = this.db.prepare(`DELETE FROM jd_gaps WHERE job_id = ?`);
    const ins = this.db.prepare(
      `INSERT INTO jd_gaps (job_id, requirement, norm_key, kind) VALUES (@job_id, @requirement, @norm_key, @kind)`,
    );
    const tx = this.db.transaction(() => {
      del.run(jobId);
      for (const g of gaps) {
        const requirement = g.requirement.trim();
        if (!requirement) continue;
        ins.run({ job_id: jobId, requirement, norm_key: normGapKey(requirement), kind: g.kind });
      }
    });
    tx();
  }

  /** Aggregate gaps across all JDs, ranked by frequency (the learning roadmap). */
  aggregateGaps(): Array<{ normKey: string; requirement: string; count: number; jobs: number }> {
    return this.db
      .prepare(
        `SELECT norm_key AS normKey,
                MIN(requirement) AS requirement,
                COUNT(*) AS count,
                COUNT(DISTINCT job_id) AS jobs
           FROM jd_gaps
          GROUP BY norm_key
          ORDER BY jobs DESC, count DESC, normKey ASC`,
      )
      .all() as Array<{ normKey: string; requirement: string; count: number; jobs: number }>;
  }

  // ─── outreach drafts ─────────────────────────────────────────────────
  insertOutreachDraft(d: {
    jobId: string;
    contactName: string;
    contactRole: string | null;
    channel: string;
    draft: string;
    status?: string;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO outreach_drafts (job_id, contact_name, contact_role, channel, draft, status)
         VALUES (@job_id, @contact_name, @contact_role, @channel, @draft, @status)`,
      )
      .run({
        job_id: d.jobId,
        contact_name: d.contactName,
        contact_role: d.contactRole,
        channel: d.channel,
        draft: d.draft,
        status: d.status ?? 'pending',
      });
    return Number(res.lastInsertRowid);
  }

  listOutreachDrafts(opts: { status?: string; jobId?: string } = {}): Array<{
    id: number;
    jobId: string;
    contactName: string;
    contactRole: string | null;
    channel: string;
    draft: string;
    status: string;
    createdAt: string;
  }> {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (opts.status) { where.push('status = @status'); params.status = opts.status; }
    if (opts.jobId) { where.push('job_id = @jobId'); params.jobId = opts.jobId; }
    const sql = `SELECT id, job_id AS jobId, contact_name AS contactName, contact_role AS contactRole,
                        channel, draft, status, created_at AS createdAt
                   FROM outreach_drafts
                   ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                  ORDER BY created_at DESC`;
    return this.db.prepare(sql).all(params) as ReturnType<DbStore['listOutreachDrafts']>;
  }

  updateOutreachDraftStatus(id: number, status: string): void {
    this.db.prepare(`UPDATE outreach_drafts SET status = ? WHERE id = ?`).run(status, id);
  }
}

/** Normalize a requirement for frequency aggregation (lowercase, collapse ws). */
function normGapKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#./ -]/g, '').replace(/\s+/g, ' ').trim();
}

export const db = new DbStore();
