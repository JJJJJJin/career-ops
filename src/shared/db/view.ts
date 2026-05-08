// Generate data/applications.md as a read-only view of the DB.
// Always called after any application write so the markdown stays in sync.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from './store.js';

const RECOMMENDATION_EMOJI: Record<string, string> = {
  STRONG: '✅',
  BORDERLINE: '⚠️',
  SKIP: '❌',
  NOT_FOR_YOU: '🚫',
};

function fmtScore(s: number | null): string {
  if (s === null) return '—';
  return `${s.toFixed(1)}/5`;
}

function fmtRec(rec: string | null): string {
  if (!rec) return '—';
  return `${RECOMMENDATION_EMOJI[rec] ?? ''} ${rec}`.trim();
}

function escapePipes(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderTracker(): string {
  const rows = db.listJobs({ limit: 500 });
  const header = `# Applications

Generated from \`${path.relative(config.repoRoot, config.paths.dbPath)}\` — do not hand-edit.
Last updated: ${new Date().toISOString()}

| Date | Company | Role | Score | Rec | Status | Job ID |
|------|---------|------|-------|-----|--------|--------|`;

  const body = rows
    .map(({ job, application }) => {
      const date = (application?.updatedAt ?? job.fetchedAt).slice(0, 10);
      const company = escapePipes(job.company ?? '—');
      const role = escapePipes(job.title);
      const score = fmtScore(application?.scoreOutOf5 ?? null);
      const rec = fmtRec(application?.recommendation ?? null);
      const status = application?.status ?? 'new';
      return `| ${date} | ${company} | ${role} | ${score} | ${rec} | ${status} | ${job.jobId} |`;
    })
    .join('\n');

  return `${header}\n${body}\n`;
}

export function writeTracker(): string {
  const content = renderTracker();
  const outPath = path.join(path.dirname(config.paths.dbPath), 'applications.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content, 'utf-8');
  return outPath;
}
