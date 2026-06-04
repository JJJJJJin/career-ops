// Traceability invariant — enforced in code, not by trusting any model.
//
// After assembly, EVERY line of the output resume must trace back to a line in
// the content library (modulo allowed synonym swaps + case/whitespace/bold).
// We also forbid title/seniority drift and summaries that are not one of the
// vetted variants. If anything fails, the caller fails the run. This guardrail
// is the entire point of the refactor — do not weaken it.
import type { ContentLibrary } from './types.js';
import type { TailoredResume } from '../../tools/assemble-resume/types.js';
import { makeCanonicalizer } from './synonyms.js';

export type TraceViolation = {
  kind: 'untraceable-bullet' | 'untraceable-summary' | 'title-change' | 'untraceable-skill' | 'untraceable-education';
  where: string;
  value: string;
};

export type TraceResult = { ok: boolean; violations: TraceViolation[] };

export function validateTraceability(resume: TailoredResume, library: ContentLibrary): TraceResult {
  const canon = makeCanonicalizer(library.synonyms);
  const violations: TraceViolation[] = [];

  // Allowed bullet lines: every library bullet text.
  const bulletKeys = new Set<string>();
  for (const e of [...library.experience, ...library.projects]) {
    for (const b of e.bullets) bulletKeys.add(canon(b.text));
  }
  // Allowed summaries: the three vetted variants.
  const summaryKeys = new Set(Object.values(library.summaryVariants).map((v) => canon(v)));
  // Allowed skill items + titles.
  const skillKeys = new Set<string>();
  for (const g of library.skills) for (const it of g.items) skillKeys.add(canon(it));
  const expTitleKeys = new Set(library.experience.map((e) => canon(e.title)));
  const expOrgKeys = new Set(library.experience.map((e) => canon(e.org ?? '')));
  const projTitleKeys = new Set(library.projects.map((p) => canon(p.title)));
  const eduKeys = new Set(library.education.map((e) => canon(`${e.degree} ${e.institution}`)));

  // 1. Summary must be one of the vetted variants.
  if (resume.summary && !summaryKeys.has(canon(resume.summary))) {
    violations.push({ kind: 'untraceable-summary', where: 'summary', value: resume.summary });
  }

  // 2. Experience: titles unchanged (no seniority promotion), every highlight traceable.
  for (const e of resume.experience) {
    if (!expTitleKeys.has(canon(e.role))) {
      violations.push({ kind: 'title-change', where: `experience.role`, value: e.role });
    }
    if (e.company && !expOrgKeys.has(canon(e.company))) {
      violations.push({ kind: 'title-change', where: `experience.company`, value: e.company });
    }
    for (const h of e.highlights) {
      if (!bulletKeys.has(canon(h))) {
        violations.push({ kind: 'untraceable-bullet', where: `experience "${e.role}"`, value: h });
      }
    }
  }

  // 3. Projects: names unchanged, every highlight traceable.
  for (const p of resume.projects) {
    if (!projTitleKeys.has(canon(p.name))) {
      violations.push({ kind: 'title-change', where: `project.name`, value: p.name });
    }
    for (const h of p.highlights) {
      if (!bulletKeys.has(canon(h))) {
        violations.push({ kind: 'untraceable-bullet', where: `project "${p.name}"`, value: h });
      }
    }
  }

  // 4. Skills + competencies must be a subset of library skill items.
  for (const g of resume.skills) {
    for (const it of g.items) {
      if (!skillKeys.has(canon(it))) {
        violations.push({ kind: 'untraceable-skill', where: `skills.${g.category}`, value: it });
      }
    }
  }
  for (const c of resume.competencies) {
    if (!skillKeys.has(canon(c))) {
      violations.push({ kind: 'untraceable-skill', where: 'competencies', value: c });
    }
  }

  // 5. Education must match a library entry.
  for (const ed of resume.education) {
    if (!eduKeys.has(canon(`${ed.degree} ${ed.institution}`))) {
      violations.push({ kind: 'untraceable-education', where: 'education', value: `${ed.degree} — ${ed.institution}` });
    }
  }

  return { ok: violations.length === 0, violations };
}

export function formatViolations(violations: TraceViolation[]): string {
  return violations
    .map((v) => `  ✗ [${v.kind}] ${v.where}\n      "${v.value}"`)
    .join('\n');
}
