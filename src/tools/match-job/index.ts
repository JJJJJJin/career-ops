// match-job — score profile against summarized JD. Returns fitScore (0-100),
// scoreOutOf5, recommendation (STRONG | BORDERLINE | SKIP), strengths,
// gaps, keywords. NOT_FOR_YOU is set elsewhere (eligibility short-circuit).
import { callJson } from '../../shared/llm/client.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import type { JobSummary, MatchAnalysis } from '../../shared/db/types.js';
import { ensureProfileFromLibrary } from '../../shared/library/profile-adapter.js';
import { summarizeJob } from '../summarize-job/index.js';

const log = createLogger('match-job');

const SYSTEM_PROMPT = `You evaluate how well a candidate matches a job. Be honest — surface real gaps, not just praise. Cite SPECIFIC evidence from the candidate profile (a project name, role, or skill). Never invent evidence. Output strict JSON.

CRITICAL — strengths vs gaps are MUTUALLY EXCLUSIVE. A requirement is a STRENGTH only if the candidate profile contains concrete evidence for it; otherwise it is a GAP. NEVER list the same requirement in both. If you are unsure, it is a GAP, not a strength. Do not restate a job requirement as a strength unless the profile actually evidences it — an unmet must-have is a gap and MUST lower the score per the rubric.

Scoring rubric (0-100):
- 85-100: strong fit. Most must-haves directly evidenced. Senior-or-equal level. Domain match.
- 70-84:  good fit. All hard must-haves met; missing 1-2 nice-to-haves; transferable skills cover the rest.
- 55-69:  borderline. Half the must-haves directly evidenced; rest are transferable but not direct.
- 30-54:  weak. Significant gaps in must-haves; would need a strong cover letter to compensate.
- 0-29:   skip. Fundamental mismatch (wrong domain, wrong seniority, wrong stack).`;

const SCHEMA = `Return JSON: {
  "fitScore": number,
  "oneLineFit": string,
  "strengths": [ { "requirement": string, "evidence": string } ],
  "gaps": [ { "requirement": string, "suggestion": string } ],
  "transferableSkills": string[],
  "keywordsToEmphasize": string[]
}`;

function deriveRecommendation(scoreOutOf5: number): MatchAnalysis['recommendation'] {
  if (scoreOutOf5 >= config.scoring.strongThreshold) return 'STRONG';
  if (scoreOutOf5 >= config.scoring.borderlineThreshold) return 'BORDERLINE';
  return 'SKIP';
}

function normRequirement(s: string): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Safety net for weaker models that list the same requirement as BOTH a
 * strength and a gap (a self-contradiction that inflates the apparent fit).
 * The gap wins: any strength whose requirement matches a gap requirement is
 * dropped. Matching is by normalized equality, or substring containment when
 * the shorter string is long enough to be unambiguous.
 */
function pruneContradictedStrengths(
  strengths: NonNullable<MatchAnalysis['strengths']>,
  gaps: NonNullable<MatchAnalysis['gaps']>,
): { strengths: MatchAnalysis['strengths']; dropped: string[] } {
  const gapKeys = gaps.map((g) => normRequirement(g.requirement)).filter(Boolean);
  const dropped: string[] = [];
  const kept = strengths.filter((s) => {
    const k = normRequirement(s.requirement);
    if (!k) return true;
    const clash = gapKeys.some(
      (gk) => gk === k || (k.length >= 15 && gk.includes(k)) || (gk.length >= 15 && k.includes(gk)),
    );
    if (clash) dropped.push(s.requirement);
    return !clash;
  });
  return { strengths: kept, dropped };
}

export type MatchOptions = {
  /** Skip writing match to applications row. */
  noStore?: boolean;
  /** Force re-evaluation even if match already cached. */
  force?: boolean;
  /** Pass an explicit summary (skips re-summarization). */
  summary?: JobSummary;
};

export async function matchJob(jobId: string, opts: MatchOptions = {}): Promise<MatchAnalysis> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`match-job: ${jobId} not in DB. Run seek-extract first.`);

  if (!opts.force) {
    const existing = db.getApplication(jobId);
    if (existing?.match) {
      log.info({ jobId }, 'match-job: returning cached match');
      return existing.match;
    }
  }

  const summary = opts.summary ?? (await summarizeJob(jobId));
  const { profile } = ensureProfileFromLibrary();

  log.info({ jobId, model: config.llm.model }, 'match-job: calling LLM');
  const out = await callJson<Partial<MatchAnalysis>>({
    step: 'match-job',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `${SCHEMA}

JOB SUMMARY:
${JSON.stringify(summary, null, 2)}

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}`,
  });

  const fitScore = typeof out.fitScore === 'number' ? Math.max(0, Math.min(100, out.fitScore)) : 0;
  const scoreOutOf5 = Math.round((fitScore / 20) * 10) / 10;
  const recommendation = deriveRecommendation(scoreOutOf5);

  const gaps = out.gaps ?? [];
  const { strengths, dropped } = pruneContradictedStrengths(out.strengths ?? [], gaps);
  if (dropped.length) {
    log.warn({ jobId, dropped }, 'match-job: pruned strengths that contradicted gaps (model self-contradiction)');
  }

  const match: MatchAnalysis = {
    fitScore,
    scoreOutOf5,
    recommendation,
    oneLineFit: out.oneLineFit ?? '',
    strengths,
    gaps,
    transferableSkills: out.transferableSkills ?? [],
    keywordsToEmphasize: out.keywordsToEmphasize ?? [],
  };

  if (!opts.noStore) {
    db.updateApplicationFields(jobId, {
      match,
      fitScore,
      scoreOutOf5,
      recommendation,
      oneLineFit: match.oneLineFit,
      profileHash: profile.sourceMarkdownHash,
      model: config.llm.model,
    });
  }

  log.info(
    {
      jobId,
      fitScore,
      scoreOutOf5,
      recommendation,
      strengths: match.strengths.length,
      gaps: match.gaps.length,
    },
    'match-job: complete',
  );

  return match;
}
