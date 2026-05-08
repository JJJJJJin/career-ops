---
name: daily-pipeline
description: Scheduled / on-demand full sweep — scan SEEK with the configured keywords, extract + evaluate every new job, optionally auto-apply the top N STRONG matches. Use as a morning brief, a cron job, or whenever the user says "refresh and tell me what's worth applying to".
---

# daily-pipeline

## When to use
- "Morning brief" / "what's new today?"
- Recurring scheduled run (cron / launchd / Claude Code routine)
- "Scan and apply to the best ones"

Skip when:
- The user has a specific URL in mind → `evaluate-job` or `apply-job`
- The user is reviewing existing pipeline state → `query-jobs` / `job-stats`

## How to invoke
```
career-ops daily-pipeline [-q "keyword"] [--auto-apply-top N] [--force]
```

## Inputs
- `-q / --keyword` — override config keywords. Repeatable.
- `--auto-apply-top N` — automatically run `apply-job` for the top N STRONG matches discovered this run (default 0 = evaluate only).
- `--force` — re-evaluate cached jobs.

## Outputs
- Stdout: scan totals → `(scanned: X, new: Y, evaluated: Z, STRONG: K, applied: M)`
- DB: scan_runs row per keyword, jobs / applications populated for new finds.
- Files: per-job artefacts for any auto-applied roles in `output/<slug>/`.
- File: `data/applications.md` regenerated.

## Behavior
1. **Scan** — runs `seek-search` with config keywords / location / days.
2. **Extract + evaluate** — for each NEW job: `seek-extract` then `evaluate-job` (sequential, polite jitter inherited from seek-search).
3. **Auto-apply** — for the top `N` STRONG eligible matches by score, runs `apply-job`. If `N = 0`, this stage is skipped.

## Token cost
- 2 LLM calls per new job (summarize + match) for evaluation.
- 0 LLM calls for jobs blocked by eligibility heuristic.
- ~4-5 LLM calls per auto-applied job (resume + cover letter + brief + already-cached summary/match).

## Recommended cadence
- Daily during active job hunt: `daily-pipeline --auto-apply-top 3`
- Weekly review only: `daily-pipeline` (no auto-apply), then human review with `query-jobs --since-days 7 --min-score 4 --status new`.
