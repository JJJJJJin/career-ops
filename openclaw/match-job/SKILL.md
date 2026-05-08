---
name: match-job
description: Score the candidate's profile against a summarized job — fitScore (0-100), scoreOutOf5, recommendation (STRONG / BORDERLINE / SKIP), strengths and gaps with cited evidence. Auto-invoked by evaluate-job. Use directly only when you've already summarized and want to redo just the scoring step.
---

# match-job

## When to use
- The summary is fine but you want to re-score (e.g. after editing your profile)
- Inspecting why a score is what it is — `--json` shows strengths/gaps with citations

Skip when:
- You want eligibility + summary + score together → use `evaluate-job`
- The job hasn't been summarized yet — `match-job` will summarize first, but `evaluate-job` is the cleaner entry point

## How to invoke
```
career-ops match-job <jobId> [--force] [--json]
```

## Inputs
- `<jobId>` (required) — job must be in DB; auto-summarizes if needed.
- `--force` — re-score even if cached.
- `--json` — emit full MatchAnalysis.

## Outputs
- Stdout: badge + score (`✅ STRONG  4.2/5  (84/100)`), one-line fit, strengths, gaps, keywords-to-emphasize.
- DB: `applications.match_json`, `fit_score`, `score_out_of_5`, `recommendation`, `one_line_fit`, `profile_hash`.

## Recommendation thresholds
- `STRONG` — score ≥ `SCORE_THRESHOLD_STRONG` env (default 4.0/5)
- `BORDERLINE` — between 3.0 and the strong threshold
- `SKIP` — below 3.0
- `NOT_FOR_YOU` — set by `evaluate-job` when eligibility flags fire (this tool never sets it)

## Chaining
- After STRONG, the user usually wants `apply-job` or `generate-resume` + `generate-cover-letter`.
- `match.keywordsToEmphasize` flows through to the resume generator automatically.
