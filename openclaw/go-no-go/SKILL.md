---
name: go-no-go
description: Compare a JD's hard must-haves against the real profile and return go or low-yield with reasons. Catches blocking gates the candidate clearly fails — 4+ years required, mandatory citizenship/PR, security clearance, or a core framework that runs through the whole role and is absent from the library — so you can skip or apply with eyes open instead of wasting an assembly cycle.
---

# go-no-go

## When to use
- Before assembling, to decide whether a job is worth the effort.
- Auto-invoked by `apply-job`, which skips generation on `low-yield` (override with `--apply-anyway`).

## How to invoke
```
career-ops go-no-go <jobId>
```

## Outputs
- Console: `GO` or `LOW-YIELD` with one line per blocking reason.
- On `low-yield`, `apply-job` records the reasons to the gap report.
