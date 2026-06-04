---
name: gap-report
description: Aggregate every JD requirement the content library does not support, ranked by how many postings asked for it. This is the candidate's learning roadmap — the top rows are the highest-leverage skills to acquire. Gaps are recorded automatically by apply-job per job.
---

# gap-report

## When to use
- Periodically, to see what the market keeps asking for that your library lacks.

## How to invoke
```
career-ops gap-report [--top N]
```

## Outputs
- Console: a ranked table — `jobs` (distinct postings), `seen` (total mentions), requirement.

## Notes
- Populated by `apply-job` (assembly unmet-tech + go/no-go reasons). Re-running a job replaces its prior gaps.
