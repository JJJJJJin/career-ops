// assemble-resume — the deterministic core of the refactor. Given a JD, it
// SELECTS and ORDERS pre-vetted bullets from the content library (profile_v3.md)
// into a TailoredResume. It NEVER generates new claims: the LLM is not called
// here at all. Vocabulary is aligned to the JD only via the library's synonym
// map, and the result is validated against the traceability invariant before
// anything is written. This replaces the LLM-generation path in generate-resume.
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import { applicationDir, artefactBase } from '../../shared/slug.js';
import type { Job, JobSummary } from '../../shared/db/types.js';
import { ensureLibrary } from '../../shared/library/parse.js';
import type { Archetype, ContentLibrary, LibraryBullet, LibraryEntry } from '../../shared/library/types.js';
import { validateTraceability, formatViolations } from '../../shared/library/traceability.js';
import { summarizeJob } from '../summarize-job/index.js';
import { classifyJd, type JdClassification } from '../classify-jd/index.js';
import type { AssemblyReport, TailoredContact, TailoredResume } from './types.js';

const log = createLogger('assemble-resume');

const CAP_EXPERIENCE = 5;
const CAP_PROJECT = 4;

// Default bullet-ordering priority per archetype. JD-derived emphasis tags are
// prepended to this at runtime, so the JD always wins ties.
const DEFAULT_TAG_PRIORITY: Record<Archetype, string[]> = {
  backend: ['backend', 'concurrency', 'ddd', 'real-time', 'devops', 'observability', 'data', 'automation', 'scrum', 'ai-llm', 'embedded', 'leadership', 'communication'],
  'full-stack': ['backend', 'real-time', 'frontend', 'ddd', 'automation', 'observability', 'scrum', 'concurrency', 'ai-llm', 'data', 'leadership', 'communication'],
  'ai-agent': ['ai-llm', 'automation', 'backend', 'observability', 'data', 'concurrency', 'devops', 'real-time', 'scrum', 'leadership', 'communication'],
};

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapContact(c: ContentLibrary['contact']): TailoredContact {
  const url = (s: string | null): string | null => {
    if (!s) return null;
    return /^https?:\/\//.test(s) ? s : `https://${s}`;
  };
  return {
    email: c.email,
    phone: c.phone,
    location: c.location,
    linkedinUrl: url(c.linkedin),
    linkedinDisplay: c.linkedin,
    portfolioUrl: null,
    portfolioDisplay: null,
    github: url(c.github),
    workRights: c.workRights,
  };
}

/** Build a synonym aligner that swaps library terms for the JD's preferred synonym. */
function buildAligner(library: ContentLibrary, jdText: string) {
  const jdLower = jdText.toLowerCase();
  const rules: Array<{ others: string[]; to: string }> = [];
  for (const group of library.synonyms) {
    const pref = group.find((m) => new RegExp(`\\b${escRe(m.toLowerCase())}\\b`).test(jdLower));
    if (!pref) continue;
    const others = group.filter((m) => m !== pref);
    if (others.length) rules.push({ others, to: pref });
  }
  return (text: string): { text: string; swaps: Array<{ from: string; to: string }> } => {
    let out = text;
    const swaps: Array<{ from: string; to: string }> = [];
    for (const r of rules) {
      for (const o of r.others) {
        const re = new RegExp(`\\b${escRe(o)}\\b`, 'gi');
        if (re.test(out)) {
          out = out.replace(re, r.to);
          swaps.push({ from: o, to: r.to });
        }
      }
    }
    return { text: out, swaps };
  };
}

/** Ordered emphasis tags: JD-derived first, then archetype defaults. */
function emphasisOrder(cls: JdClassification): string[] {
  return [...new Set([...cls.emphasisTags, ...DEFAULT_TAG_PRIORITY[cls.archetype]])];
}

function scoreBullet(b: LibraryBullet, priority: string[]): number {
  let s = 0;
  for (const tag of b.tags) {
    const idx = priority.indexOf(tag);
    if (idx !== -1) s += priority.length - idx;
  }
  return s;
}

type SelectedEntry = {
  entry: LibraryEntry;
  bullets: LibraryBullet[];
  relevanceScore: number;
};

/** Select + order bullets for one entry. */
function selectEntry(entry: LibraryEntry, cls: JdClassification, priority: string[], cap: number): SelectedEntry {
  const emphasisSet = new Set(cls.emphasisTags);
  const candidates = entry.bullets
    .filter((b) => !b.conditional || b.tags.some((t) => emphasisSet.has(t)))
    .map((b, i) => ({ b, i, score: scoreBullet(b, priority) }));

  candidates.sort((a, z) => (z.score - a.score) || (a.i - z.i)); // score desc, stable

  const relevanceScore = candidates.reduce((sum, c) => sum + c.score, 0);
  // Irrelevant entries are kept but trimmed to a single line; relevant ones up to cap.
  const keep = relevanceScore === 0 ? Math.min(1, candidates.length) : Math.min(cap, candidates.length);
  const bullets = candidates.slice(0, keep).map((c) => c.b);
  return { entry, bullets, relevanceScore };
}

function deriveBadge(tags: string[]): string | null {
  const set = new Set(tags);
  if (set.has('ai-llm')) return 'AI / LLM';
  if (set.has('embedded')) return 'Embedded';
  if (set.has('frontend')) return 'Full-Stack';
  if (set.has('ddd') || set.has('backend') || set.has('concurrency') || set.has('real-time')) return 'Backend';
  return null;
}

function renderMarkdown(r: TailoredResume): string {
  const lines: string[] = [];
  lines.push(`# ${r.name}`);
  const contact = [
    r.contact.email, r.contact.phone, r.contact.location,
    r.contact.linkedinDisplay ?? r.contact.linkedinUrl, r.contact.github,
  ].filter(Boolean);
  if (contact.length) lines.push(contact.join(' · '));
  if (r.contact.workRights) lines.push(`**${r.contact.workRights}**`);
  lines.push('');
  if (r.summary) { lines.push(`> ${r.summary}`); lines.push(''); }
  if (r.experience.length) {
    lines.push('## Experience', '');
    for (const e of r.experience) {
      lines.push(`### ${e.role} — ${e.company}`);
      const sub = [e.period, e.location].filter(Boolean).join(' · ');
      if (sub) lines.push(`*${sub}*`);
      lines.push('');
      for (const h of e.highlights) lines.push(`- ${h}`);
      lines.push('');
    }
  }
  if (r.projects.length) {
    lines.push('## Projects', '');
    for (const p of r.projects) {
      const badge = p.badge ? ` _(${p.badge})_` : '';
      lines.push(`### ${p.name}${badge}`);
      if (p.description) lines.push(p.description);
      if (p.highlights.length) { lines.push(''); for (const h of p.highlights) lines.push(`- ${h}`); }
      if (p.technologies.length) { lines.push(''); lines.push(`*Tech:* ${p.technologies.join(', ')}`); }
      lines.push('');
    }
  }
  if (r.education.length) {
    lines.push('## Education', '');
    for (const ed of r.education) {
      lines.push(`**${ed.degree}** — ${ed.institution} (${ed.period})`);
      if (ed.details) lines.push(ed.details);
      lines.push('');
    }
  }
  if (r.skills.length) {
    lines.push('## Skills', '');
    for (const g of r.skills) lines.push(`**${g.category}:** ${g.items.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** JD tech-stack items with no support anywhere in the library → gap candidates. */
function computeUnmet(summary: JobSummary, library: ContentLibrary): string[] {
  const blob = [
    ...library.experience.flatMap((e) => e.bullets.map((b) => b.text)),
    ...library.projects.flatMap((p) => [...p.bullets.map((b) => b.text), ...p.tech, p.role ?? '']),
    ...library.skills.flatMap((g) => g.items),
  ].join(' \n ').toLowerCase();
  const unmet: string[] = [];
  for (const tech of summary.techStack) {
    const t = tech.toLowerCase().trim();
    if (!t) continue;
    if (!new RegExp(`\\b${escRe(t)}\\b`).test(blob)) unmet.push(tech);
  }
  return unmet;
}

/**
 * Pure assembly: library + parsed JD → TailoredResume + report. No DB, no LLM,
 * no filesystem. Deterministic and unit-testable. Runs the traceability check
 * and THROWS if any output line is not traceable to the library.
 */
export function buildTailoredResume(
  library: ContentLibrary,
  summary: JobSummary,
  cls: JdClassification,
): { resume: TailoredResume; report: Omit<AssemblyReport, 'jobId'> } {
  const priority = emphasisOrder(cls);
  const jdText = [summary.oneLineSummary, ...summary.responsibilities, ...summary.mustHaveRequirements, ...summary.niceToHaveRequirements, ...summary.techStack].join('\n');
  const align = buildAligner(library, jdText);
  const allSwaps: Array<{ from: string; to: string }> = [];
  const applyAlign = (s: string): string => { const r = align(s); allSwaps.push(...r.swaps); return r.text; };

  // Experience: keep library order (recency + flagship intern first).
  const selExp = library.experience.map((e) => selectEntry(e, cls, priority, CAP_EXPERIENCE));
  // Projects: order by relevance to this JD.
  const selProj = library.projects
    .map((p) => selectEntry(p, cls, priority, CAP_PROJECT))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  const resume: TailoredResume = {
    name: library.contact.name,
    contact: mapContact(library.contact),
    summary: applyAlign(library.summaryVariants[cls.archetype] || library.summaryVariants.backend),
    competencies: [],
    experience: selExp.map((s) => ({
      company: s.entry.org ?? '',
      role: s.entry.title,
      period: s.entry.dates ?? '',
      location: s.entry.location,
      highlights: s.bullets.map((b) => applyAlign(b.text)),
    })),
    projects: selProj.map((s) => ({
      name: s.entry.title,
      badge: deriveBadge(s.bullets.flatMap((b) => b.tags)),
      description: s.entry.role ?? '',
      highlights: s.bullets.map((b) => applyAlign(b.text)),
      technologies: s.entry.tech,
    })),
    education: library.education.map((e) => ({
      degree: e.degree,
      institution: e.institution,
      period: e.dates ?? '',
      details: e.details,
    })),
    certifications: library.certifications,
    skills: library.skills,
  };

  // ── The guardrail. Validate BEFORE writing anything. ──────────────────
  const trace = validateTraceability(resume, library);
  if (!trace.ok) {
    throw new Error(
      `assemble-resume: traceability invariant FAILED — ${trace.violations.length} line(s) do not trace to the library:\n${formatViolations(trace.violations)}`,
    );
  }

  const report: Omit<AssemblyReport, 'jobId'> = {
    archetype: cls.archetype,
    summaryVariant: cls.archetype,
    selections: [
      ...selExp.map((s) => ({ kind: 'experience' as const, title: s.entry.title, picked: s.bullets.length, available: s.entry.bullets.length, relevanceScore: s.relevanceScore })),
      ...selProj.map((s) => ({ kind: 'project' as const, title: s.entry.title, picked: s.bullets.length, available: s.entry.bullets.length, relevanceScore: s.relevanceScore })),
    ],
    unmetRequirements: computeUnmet(summary, library),
    synonymSwaps: [...new Map(allSwaps.map((s) => [`${s.from}->${s.to}`, s])).values()],
    traceability: 'passed',
  };

  return { resume, report };
}

export type AssembleResult = {
  jobId: string;
  outputDir: string;
  resumeJsonPath: string;
  resumeMdPath: string;
  reportPath: string;
  resume: TailoredResume;
  markdown: string;
  report: AssemblyReport;
};

export type AssembleOptions = {
  force?: boolean;
  summary?: JobSummary;
  classification?: JdClassification;
};

/** IO wrapper: resolve JD inputs, assemble, persist artefacts, update DB. */
export async function assembleResume(jobId: string, opts: AssembleOptions = {}): Promise<AssembleResult> {
  const job: Job | null = db.getJob(jobId);
  if (!job) throw new Error(`assemble-resume: ${jobId} not in DB. Run seek-extract first.`);

  const summary = opts.summary ?? (await summarizeJob(jobId));
  const cls = opts.classification ?? (await classifyJd(jobId, { summary }));
  const { library } = ensureLibrary();

  const slug = artefactBase(job);
  const outputDir = applicationDir(job);
  const resumeJsonPath = path.join(outputDir, `${slug}-resume.json`);
  const resumeMdPath = path.join(outputDir, `${slug}-resume.md`);
  const reportPath = path.join(outputDir, `${slug}-match-report.json`);

  const { resume, report: reportBase } = buildTailoredResume(library, summary, cls);
  const report: AssemblyReport = { jobId, ...reportBase };

  const markdown = renderMarkdown(resume);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(resumeJsonPath, JSON.stringify(resume, null, 2), 'utf-8');
  fs.writeFileSync(resumeMdPath, markdown, 'utf-8');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  db.updateApplicationFields(jobId, {
    resumeMd: markdown,
    outputDir,
    generatedAt: new Date().toISOString(),
    model: `assembled:${library.sourceHash}`,
    profileHash: library.sourceHash,
  });

  log.info(
    { jobId, archetype: cls.archetype, exp: resume.experience.length, proj: resume.projects.length, unmet: report.unmetRequirements.length, swaps: report.synonymSwaps.length },
    'assemble-resume: complete (traceability passed)',
  );

  return { jobId, outputDir, resumeJsonPath, resumeMdPath, reportPath, resume, markdown, report };
}
