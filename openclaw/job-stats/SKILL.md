---
name: job-stats
description: Aggregate counts — total jobs, eligible vs ineligible, breakdown by recommendation (STRONG / BORDERLINE / SKIP / NOT_FOR_YOU), breakdown by status. Use when the user asks "how's the pipeline?", "what's my conversion?", "total numbers".
---

# job-stats

## When to use
- Pipeline health questions
- Sanity checks ("did anything actually scan today?")
- Weekly summary asks

Skip when:
- The user wants specific rows → `query-jobs`

## How to invoke
```
career-ops job-stats [--json]
```

## Inputs
- `--json` — emit the structured stats object

## Outputs
- Stdout: counts grouped by total / eligibility / recommendation / status.
- DB: read-only.

## Chaining
- Often the first command at the start of a session to see what's there.
