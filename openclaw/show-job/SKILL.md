---
name: show-job
description: Drill into one job by jobId — full job record, eligibility flags with evidence, application state (score, recommendation, status, output dir, model used). Use when the user asks "tell me more about <jobId>", "what's in this one", "show me the details".
---

# show-job

## When to use
- User wants the full picture for one job
- Debugging — checking why a particular job got a particular verdict

Skip when:
- The user wants a list → `query-jobs`
- The user wants aggregate numbers → `job-stats`

## How to invoke
```
career-ops show-job <jobId> [--json]
```

## Inputs
- `<jobId>` (required) — the numeric SEEK job id.

## Outputs
- Stdout: title, company, URL, all metadata, eligibility flags, application row (status / score / recommendation / one-line fit / output dir / generated_at / model / notes).
- `--json` for piping.

## Chaining
- Often paired with `mark-job <jobId> <status>` once the user reads the details and decides how to track it.
