---
name: evaluate-job
description: ⭐ Main "should I apply?" entry point. Source-agnostic — auto-detects SEEK vs LinkedIn from the URL and dispatches to the right extractor, then runs flag-eligibility + summarize-job + match-job. Returns fit score 0-5 and recommendation (STRONG / BORDERLINE / SKIP / NOT_FOR_YOU). Eligibility short-circuits to NOT_FOR_YOU before any LLM calls — saves tokens on roles the user can't apply to.
---

# evaluate-job

## When to use
- User pastes a SEEK or LinkedIn URL (or jobId) and wants a verdict ("is this worth applying to?", "rate this role", "score this")
- Composite step inside `apply-job` and `daily-pipeline`

This is the right tool **most of the time** for asks about a single role. Prefer it over the granular tools (flag-eligibility / summarize-job / match-job) unless the user specifically wants to inspect one stage.

## How to invoke
```
career-ops evaluate-job <jobIdOrUrl> [--force] [--reextract] [--json]
```

## Inputs
- `<jobIdOrUrl>` (required) — full SEEK or LinkedIn URL (auto-extracted into DB), or a stored jobId (numeric for SEEK, `linkedin:<numeric>` for LinkedIn).
- `--force` — re-summarize and re-match even if cached.
- `--reextract` — also re-fetch the job from its source.
- `--json` — emit `{job, eligibility, summary, match}`.

## Outputs
- Stdout: badge + score, one-line fit, top strengths/gaps. Eligibility blockers if any. Suggests next step (`career-ops apply-job <jobId>`) for STRONG matches.
- DB: full population of `applications` row + `jobs.eligibility_flags`.

## Chaining
- After STRONG → user usually says "apply" → `apply-job <jobId>`.
- After NOT_FOR_YOU → do NOT auto-proceed to apply-job. Surface the eligibility flags and let the user decide.
- After BORDERLINE → ask the user before generating artefacts; consider `generate-cover-letter` only if they have a specific reason to apply anyway.

## Token cost
- ~2 LLM calls (summarize + match) when eligibility passes.
- 0 LLM calls when eligibility blocks (regex short-circuit).
- 1 extra LLM call if `seek-extract` falls back to LLM (rare; SEEK reliably has JSON-LD).
