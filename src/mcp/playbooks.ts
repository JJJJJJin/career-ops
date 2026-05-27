// Playbooks — the agent-facing workflow guidelines (Markdown under playbooks/).
// This module loads/lists them and (Phase 5) proposes/applies self-correction
// edits. A playbook id is its path without extension, e.g. "seek/login".
//
// Step ids are heading slugs (## <title>), so editing a step's text in place
// supersedes the old guidance for the next run — the "改流程→下次就修好" loop.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../shared/config.js';
import { slug } from '../shared/slug.js';

export function playbooksDir(): string {
  return path.join(config.repoRoot, 'playbooks');
}

function playbookPath(id: string): string {
  // Disallow path escapes; ids are simple slash-separated slugs.
  const clean = id.replace(/\.md$/i, '').replace(/^[/.]+/, '');
  if (clean.includes('..')) throw new Error(`invalid playbook id: ${id}`);
  return path.join(playbooksDir(), `${clean}.md`);
}

/** All playbook ids (excluding the shared _contract). */
export function listPlaybooks(): string[] {
  const root = playbooksDir();
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
        out.push(`${prefix}${entry.name.replace(/\.md$/, '')}`);
      }
    }
  };
  walk(root, '');
  return out.sort();
}

export function loadContract(): string {
  const p = path.join(playbooksDir(), '_contract.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

// ─── self-correction (propose → confirm → apply) ───────────────────────────
type StepRange = { stepId: string; title: string; level: number; startLine: number; endLine: number };

/** Locate each step's heading line range, recomputing ids exactly as loadPlaybook does. */
function stepRanges(markdown: string): StepRange[] {
  const lines = markdown.split('\n');
  const ranges: StepRange[] = [];
  const seen = new Map<string, number>();
  let sawTitle = false;
  let cur: { title: string; level: number; start: number; id: string } | null = null;
  const close = (end: number): void => {
    if (cur) ranges.push({ stepId: cur.id, title: cur.title, level: cur.level, startLine: cur.start, endLine: end });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(HEADING_RE);
    if (!m) continue;
    const level = m[1]!.length;
    const text = m[2]!.trim();
    if (level === 1 && ranges.length === 0 && !cur && !sawTitle) {
      sawTitle = true;
      continue;
    }
    close(i);
    let base = slug(text) || `step-${ranges.length + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if (n > 0) base = `${base}-${n + 1}`;
    cur = { title: text, level, start: i, id: base };
  }
  close(lines.length);
  return ranges;
}

export type ProposedFix = {
  fixId: string;
  workflow: string;
  stepId: string;
  title: string;
  before: string;
  after: string;
  diff: string;
  rationale: string;
};

type PendingFix = ProposedFix & { newMarkdown: string };
const PENDING = new Map<string, PendingFix>();

function unifiedish(before: string, after: string): string {
  const b = before.split('\n').map((l) => `- ${l}`);
  const a = after.split('\n').map((l) => `+ ${l}`);
  return ['@@ step block @@', ...b, ...a].join('\n');
}

/**
 * Stage an improved version of one step. Returns a diff WITHOUT writing. The
 * heading (step id) is kept unless `newTitle` is given; `newText` replaces the
 * step's body (everything under the heading).
 */
export function proposeFix(args: { workflow: string; stepId: string; newText: string; rationale: string; newTitle?: string }): ProposedFix {
  const pb = loadPlaybook(args.workflow);
  const lines = pb.markdown.split('\n');
  const ranges = stepRanges(pb.markdown);
  const r = ranges.find((x) => x.stepId === args.stepId);
  if (!r) throw new Error(`step "${args.stepId}" not in ${args.workflow}. Known steps: ${ranges.map((x) => x.stepId).join(', ')}`);

  const hashes = '#'.repeat(r.level);
  const title = args.newTitle?.trim() || r.title;
  const before = lines.slice(r.startLine, r.endLine).join('\n').replace(/\s+$/, '');
  const afterLines = [`${hashes} ${title}`, ...args.newText.replace(/\s+$/, '').split('\n')];
  const after = afterLines.join('\n');
  const newMarkdown = [...lines.slice(0, r.startLine), ...afterLines, '', ...lines.slice(r.endLine)].join('\n').replace(/\n{3,}/g, '\n\n');

  const fixId = `${args.workflow.replace(/\//g, '_')}-${args.stepId}-${Date.now().toString(36)}`;
  const fix: PendingFix = { fixId, workflow: args.workflow, stepId: args.stepId, title, before, after, diff: unifiedish(before, after), rationale: args.rationale, newMarkdown };
  PENDING.set(fixId, fix);
  const { newMarkdown: _omit, ...proposed } = fix;
  void _omit;
  return proposed;
}

/** Apply a previously proposed fix to the playbook file, and append an audit record. */
export function applyFix(fixId: string): { applied: true; workflow: string; stepId: string; auditPath: string } {
  const pf = PENDING.get(fixId);
  if (!pf) throw new Error(`no pending fix "${fixId}" — call workflow_propose_fix first (and apply before the daemon restarts).`);
  fs.writeFileSync(playbookPath(pf.workflow), pf.newMarkdown);
  const auditPath = appendAudit(pf);
  PENDING.delete(fixId);
  return { applied: true, workflow: pf.workflow, stepId: pf.stepId, auditPath };
}

function appendAudit(pf: PendingFix): string {
  const dir = path.join(config.paths.reportsDir, 'playbook-fixes');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${pf.workflow.replace(/\//g, '_')}.md`);
  const entry =
    `\n## ${new Date().toISOString()} — step "${pf.stepId}"\n\n` +
    `**Rationale:** ${pf.rationale}\n\n` +
    `\`\`\`diff\n${pf.diff}\n\`\`\`\n`;
  fs.appendFileSync(p, entry);
  return p;
}

export type Playbook = { id: string; title: string; markdown: string; steps: PlaybookStep[] };
export type PlaybookStep = { id: string; title: string; body: string };

const HEADING_RE = /^(#{1,3})\s+(.*)$/;

/** Parse a playbook into its title + ## steps (heading slug = stable step id). */
export function loadPlaybook(id: string): Playbook {
  const p = playbookPath(id);
  if (!fs.existsSync(p)) throw new Error(`playbook not found: ${id} (${p})`);
  const markdown = fs.readFileSync(p, 'utf-8');
  const lines = markdown.split('\n');
  let title = id;
  const steps: PlaybookStep[] = [];
  const seen = new Map<string, number>();
  let cur: { title: string; body: string[] } | null = null;
  const flush = (): void => {
    if (!cur) return;
    let base = slug(cur.title) || `step-${steps.length + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if (n > 0) base = `${base}-${n + 1}`;
    steps.push({ id: base, title: cur.title, body: cur.body.join('\n').trim() });
  };
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      const level = m[1]!.length;
      const text = m[2]!.trim();
      if (level === 1 && steps.length === 0 && !cur) {
        title = text.replace(/^playbook:\s*/i, '');
        continue;
      }
      flush();
      cur = { title: text, body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  flush();
  return { id, title, markdown, steps };
}
