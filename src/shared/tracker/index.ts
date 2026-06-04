// Shared Postgres job tracker (rpi). Two jobs:
//   • dedup-on-discovery: before processing a scanned job, check it isn't
//     already known (here or on another machine), and insert it if new.
//   • status-on-submit: after a successful application, update its status.
//
// Resilience: if Postgres is unreachable (you're out of the house), writes are
// appended to a local outbox and replayed automatically on the next successful
// connection (or via `career-ops tracker-sync`). Reads fall back to local dedup.
//
// The heavy pipeline data (JD text, summaries, artefacts) stays in local SQLite;
// this tracker only holds the lightweight cross-machine job/status table.
import pg from 'pg';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import * as outbox from './outbox.js';
import { toTrackerStatus, type OutboxOp, type TrackerJobInput, type TrackerStatus } from './types.js';

const log = createLogger('tracker');

let pool: pg.Pool | null = null;

export function isEnabled(): boolean {
  return Boolean(config.tracker.databaseUrl);
}

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.tracker.databaseUrl ?? undefined,
      connectionTimeoutMillis: config.tracker.connectTimeoutMs,
      max: 4,
    });
    pool.on('error', (err) => log.warn({ err: err.message }, 'tracker: idle pool error'));
  }
  return pool;
}

/** Connection-level failures queue to the outbox; everything else is a real bug. */
function isConnError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? '';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNRESET'].includes(code)) return true;
  return /timeout|connect|terminat|ECONNREFUSED|getaddrinfo/i.test(e?.message ?? '');
}

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(sql, params);
}

/**
 * Best-effort schema setup. The table is created by the rpi admin; we only
 * CREATE TABLE IF NOT EXISTS (no-op when it exists) and try to add the dedup
 * unique index. The `jobtracker` role may not OWN the table, so index creation
 * can fail with "must be owner" — that's fine, we just log a hint and rely on
 * the ownership-free WHERE-NOT-EXISTS dedup below.
 */
export async function ensureSchema(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            BIGSERIAL PRIMARY KEY,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source        TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      company       TEXT,
      title         TEXT NOT NULL,
      url           TEXT NOT NULL,
      score         REAL,
      status        TEXT NOT NULL DEFAULT '未申请',
      applied_at    TIMESTAMPTZ,
      notes         TEXT,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  try {
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_source_id_uniq ON jobs(source, source_id)`);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'tracker: could not create unique index (need table owner) — using WHERE-NOT-EXISTS dedup; consider adding UNIQUE(source, source_id) as the admin');
  }
}

// ── discovery (ownership-free dedup; no ON CONFLICT needed) ──────────────────
async function insertDiscover(job: TrackerJobInput): Promise<boolean> {
  const r = await query<{ id: string }>(
    `INSERT INTO jobs (source, source_id, company, title, url, score, status)
     SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::real, '未申请'
     WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE source = $1::text AND source_id = $2::text)
     RETURNING id`,
    [job.source, job.sourceId, job.company, job.title, job.url, job.score ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Record a discovered job. Returns whether it was newly inserted. If Postgres is
 * unreachable, the op is queued and `{ inserted:false, queued:true }` is returned.
 */
export async function discover(job: TrackerJobInput): Promise<{ inserted: boolean; queued?: boolean }> {
  if (!isEnabled()) return { inserted: false };
  try {
    await flushOutbox();
    const inserted = await insertDiscover(job);
    return { inserted };
  } catch (err) {
    if (isConnError(err)) {
      outbox.append({ kind: 'discover', at: new Date().toISOString(), job });
      return { inserted: false, queued: true };
    }
    log.warn({ err: (err as Error).message, sourceId: job.sourceId }, 'tracker: discover failed (non-connection)');
    return { inserted: false };
  }
}

/**
 * Cross-machine dedup: of the given sourceIds for a source, which already exist
 * in the tracker. Returns null if the tracker can't be reached (caller should
 * fall back to local dedup only).
 */
export async function existing(source: string, sourceIds: string[]): Promise<Set<string> | null> {
  if (!isEnabled() || !sourceIds.length) return new Set();
  try {
    const r = await query<{ source_id: string }>(
      `SELECT source_id FROM jobs WHERE source = $1::text AND source_id = ANY($2::text[])`,
      [source, sourceIds],
    );
    return new Set(r.rows.map((row) => row.source_id));
  } catch (err) {
    if (isConnError(err)) {
      log.warn('tracker: offline — cross-machine dedup unavailable, using local dedup only');
      return null;
    }
    log.warn({ err: (err as Error).message }, 'tracker: existing() failed');
    return null;
  }
}

// ── status ───────────────────────────────────────────────────────────────────
async function upsertStatus(job: TrackerJobInput, status: TrackerStatus, appliedAt: string | null, notes: string | null): Promise<void> {
  // UPDATE-then-INSERT (ownership-free; no ON CONFLICT). Last-write-wins.
  const upd = await query(
    `UPDATE jobs SET
       status     = $3,
       applied_at = COALESCE($4, applied_at),
       notes      = COALESCE($5, notes),
       company    = COALESCE($6, company),
       updated_at = now()
     WHERE source = $1 AND source_id = $2`,
    [job.source, job.sourceId, status, appliedAt, notes, job.company],
  );
  if ((upd.rowCount ?? 0) > 0) return;
  // Row didn't exist yet — insert it with this status (guard against a race).
  await query(
    `INSERT INTO jobs (source, source_id, company, title, url, score, status, applied_at, notes)
     SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::real, $7::text, $8::timestamptz, $9::text
     WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE source = $1::text AND source_id = $2::text)`,
    [job.source, job.sourceId, job.company, job.title, job.url, job.score ?? null, status, appliedAt, notes],
  );
}

/** Update a job's status (e.g. '已申请' on a successful submit). Queues if offline. */
export async function recordStatus(
  job: TrackerJobInput,
  status: string,
  opts: { appliedAt?: string | null; notes?: string | null } = {},
): Promise<{ ok: boolean; queued?: boolean }> {
  if (!isEnabled()) return { ok: false };
  const ts = toTrackerStatus(status);
  const appliedAt = opts.appliedAt ?? (ts === '已申请' ? new Date().toISOString() : null);
  const notes = opts.notes ?? null;
  try {
    await flushOutbox();
    await upsertStatus(job, ts, appliedAt, notes);
    return { ok: true };
  } catch (err) {
    if (isConnError(err)) {
      outbox.append({ kind: 'status', at: new Date().toISOString(), source: job.source, sourceId: job.sourceId, status: ts, appliedAt, notes });
      // Also queue a discover so the row exists when we sync, if it didn't.
      outbox.append({ kind: 'discover', at: new Date().toISOString(), job });
      return { ok: false, queued: true };
    }
    log.warn({ err: (err as Error).message, sourceId: job.sourceId }, 'tracker: recordStatus failed (non-connection)');
    return { ok: false };
  }
}

// ── outbox replay ──────────────────────────────────────────────────────────--
let flushing = false;

/** Replay queued ops in order. Stops on the first connection error (keeps the rest). */
export async function flushOutbox(): Promise<{ synced: number; pending: number }> {
  if (!isEnabled() || flushing) return { synced: 0, pending: outbox.pendingCount() };
  const ops = outbox.readAll();
  if (!ops.length) return { synced: 0, pending: 0 };
  flushing = true;
  let synced = 0;
  const remaining: OutboxOp[] = [];
  let offline = false;
  try {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (offline) { remaining.push(op); continue; }
      try {
        if (op.kind === 'discover') await insertDiscover(op.job);
        else await upsertStatus({ source: op.source, sourceId: op.sourceId, company: null, title: '', url: '' }, op.status, op.appliedAt ?? null, op.notes ?? null);
        synced++;
      } catch (err) {
        if (isConnError(err)) { offline = true; remaining.push(op); }
        else { log.warn({ err: (err as Error).message, kind: op.kind }, 'tracker: dropping un-syncable outbox op'); }
      }
    }
    outbox.rewrite(remaining);
  } finally {
    flushing = false;
  }
  if (synced) log.info({ synced, pending: remaining.length }, 'tracker: outbox synced');
  return { synced, pending: remaining.length };
}

export function pendingCount(): number {
  return outbox.pendingCount();
}

export async function close(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
