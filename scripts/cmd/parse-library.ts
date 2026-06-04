// parse-library — sanity-check the content library (profile_v3.md): parse it,
// print what was extracted, and self-test that every summary variant assembles
// into a fully traceable resume. Run this after editing profile_v3.md.
import { ensureLibrary } from '../../src/shared/library/parse.js';
import { buildTailoredResume } from '../../src/tools/assemble-resume/index.js';
import { validateTraceability } from '../../src/shared/library/traceability.js';
import { ARCHETYPES } from '../../src/shared/library/types.js';
import type { JobSummary } from '../../src/shared/db/types.js';

export async function runCli(_argv: string[]): Promise<void> {
  const { library: l } = ensureLibrary();
  process.stdout.write(`Content library parsed (${l.sourceHash}):\n`);
  process.stdout.write(`  contact:   ${l.contact.name} <${l.contact.email}>\n`);
  process.stdout.write(`  summaries: ${ARCHETYPES.filter((a) => l.summaryVariants[a]).join(', ')}\n`);
  process.stdout.write(`  skills:    ${l.skills.length} groups\n`);
  process.stdout.write(`  experience:${l.experience.length} · projects: ${l.projects.length} · education: ${l.education.length}\n`);
  process.stdout.write(`  synonyms:  ${l.synonyms.length} groups\n\n`);

  for (const e of [...l.experience, ...l.projects]) {
    process.stdout.write(`  • ${e.title} — ${e.bullets.length} bullets (${e.bullets.filter((b) => b.conditional).length} conditional)\n`);
  }

  // Self-test: each archetype must assemble into a traceable resume.
  process.stdout.write(`\nSelf-test (assemble + traceability per archetype):\n`);
  const emptySummary: JobSummary = {
    oneLineSummary: '', responsibilities: [], mustHaveRequirements: [],
    niceToHaveRequirements: [], techStack: [], domain: '', seniority: '',
  };
  let allOk = true;
  for (const archetype of ARCHETYPES) {
    try {
      const { resume } = buildTailoredResume(l, emptySummary, { archetype, emphasisTags: [], rationale: '' });
      const trace = validateTraceability(resume, l);
      process.stdout.write(`  ${trace.ok ? '✓' : '✗'} ${archetype}\n`);
      if (!trace.ok) allOk = false;
    } catch (err) {
      allOk = false;
      process.stdout.write(`  ✗ ${archetype} — ${(err as Error).message.split('\n')[0]}\n`);
    }
  }
  if (!allOk) process.exitCode = 1;
}
