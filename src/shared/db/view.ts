// Generate data/applications.md as a read-only view of the DB.
// Always called after any application write so the markdown stays in sync.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from './store.js';

function escapePipes(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderTracker(): string {
  const rows = db.listJobs({ limit: 500 });
  const header = `# Applications

Generated from \`${path.relative(config.repoRoot, config.paths.dbPath)}\` — do not hand-edit.
Last updated: ${new Date().toISOString()}

| 最后操作日期 | 公司 | 工作职位 | URL | 是否已申请 | Quick Apply | Job ID |
|------|------|------|------|------|------|------|`;

  const body = rows
    .map(({ job, application }) => {
      const date = (application?.appliedAt ?? application?.updatedAt ?? job.fetchedAt).slice(0, 10);
      const company = escapePipes(job.company ?? '—');
      const role = escapePipes(job.title);
      const url = escapePipes(job.url);
      const applied = application?.status === 'applied' ? '是' : '否';
      const quickApply = job.applyType === 'quick' ? '是' : '否';
      return `| ${date} | ${company} | ${role} | ${url} | ${applied} | ${quickApply} | ${job.jobId} |`;
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
