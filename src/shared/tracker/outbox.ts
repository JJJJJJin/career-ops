// Offline outbox — append-only JSONL of tracker ops that could not reach
// Postgres (no connection). Replayed in order on the next successful connect.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import type { OutboxOp } from './types.js';

const log = createLogger('tracker:outbox');

function file(): string {
  return config.paths.trackerOutbox;
}

export function append(op: OutboxOp): void {
  const p = file();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(op) + '\n', 'utf-8');
  log.info({ kind: op.kind }, 'tracker: queued op offline (will sync later)');
}

export function readAll(): OutboxOp[] {
  const p = file();
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as OutboxOp);
}

export function clear(): void {
  const p = file();
  if (fs.existsSync(p)) fs.rmSync(p);
}

/** Overwrite the outbox with the ops that still failed (so progress isn't lost). */
export function rewrite(ops: OutboxOp[]): void {
  const p = file();
  if (!ops.length) { clear(); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, ops.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf-8');
}

export function pendingCount(): number {
  return readAll().length;
}
