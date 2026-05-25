// Run journal — a persistent, human-readable trace of every decision and its
// outcome, for after-the-fact debugging ("why did this application fail?").
//
// Live logs (createLogger) go to stderr and are lost once a background run
// ends. The journal writes a durable, timestamped file per run under
// reports/agent-runs/ capturing: agent decisions (action, ref, source,
// confidence, REASONING), deterministic steps (resume rotation, document
// selection, each employer question → answer / unanswered), stage transitions,
// and every failure with its cause + screenshot.
//
// Ambient singleton (like `db`): owners (seek-apply, run-flow) call start()/end();
// the engine and SEEK modules just call note()/fail(). When no run is open,
// every call is a cheap no-op, so flows still work standalone.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('journal');

function fmtFields(fields?: Record<string, unknown>): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > 300 ? s.slice(0, 300) + '…' : s}`);
  }
  return parts.length ? '  ' + parts.join('  ') : '';
}

class Journal {
  private fd: number | null = null;
  private _path: string | null = null;

  /** Begin a run trace. Returns the file path (also logged). Safe to ignore the return. */
  start(runId: string, meta: Record<string, unknown> = {}): string | null {
    try {
      const dir = path.join(config.paths.reportsDir, 'agent-runs');
      fs.mkdirSync(dir, { recursive: true });
      const safe = runId.replace(/[^A-Za-z0-9_.-]/g, '_');
      this._path = path.join(dir, `${safe}.log`);
      this.fd = fs.openSync(this._path, 'a');
      this.line(`━━━ RUN START${fmtFields(meta)}`);
      log.info({ trace: this._path }, 'journal: trace opened');
      return this._path;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'journal: failed to open trace');
      this.fd = null;
      this._path = null;
      return null;
    }
  }

  /** A section divider (e.g. per job in a batch). */
  section(title: string, fields?: Record<string, unknown>): void {
    this.line(`\n── ${title} ──${fmtFields(fields)}`);
  }

  /** An informational trace line. */
  note(msg: string, fields?: Record<string, unknown>): void {
    this.line(`  • ${msg}${fmtFields(fields)}`);
  }

  /** A failure with its cause — these are what you grep for when tracing. */
  fail(msg: string, fields?: Record<string, unknown>): void {
    this.line(`  ✗ FAIL ${msg}${fmtFields(fields)}`);
  }

  end(summary: Record<string, unknown> = {}): void {
    this.line(`━━━ RUN END${fmtFields(summary)}`);
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* best effort */ }
    }
    this.fd = null;
  }

  get path(): string | null {
    return this._path;
  }

  private line(s: string): void {
    if (this.fd === null) return; // no run open → no-op
    try {
      fs.writeSync(this.fd, `[${new Date().toISOString()}]${s}\n`);
    } catch {
      /* best effort — never let tracing break a run */
    }
  }
}

export const journal = new Journal();
