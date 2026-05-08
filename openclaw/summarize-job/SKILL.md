---
name: summarize-job
description: Convert a job description into a structured JobSummary (must-haves, nice-to-haves, tech stack, domain, seniority). LLM-backed. Use when the user wants a quick "what's this role asking for?" without a full match analysis. Auto-invoked by match-job and evaluate-job — invoke directly only for inspection.
---

# summarize-job

## When to use
- User asks "what does this role need?" or "summarize this JD"
- Debugging a poor match — you want to see if the summary captured the requirements correctly

Skip when:
- You want a verdict + score → use `evaluate-job`
- You only want a number → use `match-job`

## How to invoke
```
career-ops summarize-job <jobId> [--force] [--json]
```

## Inputs
- `<jobId>` (required) — must be in DB.
- `--force` — re-summarize even if cached.
- `--json` — emit full JobSummary.

## Outputs
- Stdout: one-line summary, must-haves, nice-to-haves, tech, seniority, domain.
- DB: `applications.summary_json`.

## Chaining
- `match-job` and `evaluate-job` call this automatically.
- A bad summary often produces a bad match — inspect it with `--json` if scores look off.
