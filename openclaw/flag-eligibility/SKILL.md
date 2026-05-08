---
name: flag-eligibility
description: Scan a job description for AU citizenship / PR / security clearance / visa-sponsorship requirements. Heuristic regex (false positives possible). Use to quickly check whether a job is reachable before spending LLM tokens on evaluation. Auto-invoked by evaluate-job — invoke directly only when you want to inspect the heuristic in isolation.
---

# flag-eligibility

## When to use
- Debugging a NOT_FOR_YOU verdict (you want to see exactly which signal fired)
- Manually re-running the heuristic after `seek-extract` updated the description

Skip when:
- You want a full eligibility + score verdict → use `evaluate-job` (calls this internally and short-circuits to NOT_FOR_YOU when flags fire)

## How to invoke
```
career-ops flag-eligibility <jobId> [--json]
```

## Inputs
- `<jobId>` (required) — the job must already be in the DB (run `seek-extract` first).

## Outputs
- Stdout: `✔ eligible` or `🚫 NOT FOR YOU` with each flag and a quoted evidence snippet.
- DB: `jobs.eligibility_flags` is updated.

## Flag types
- `AU_CITIZENSHIP_REQUIRED` — "Australian citizens only"
- `AU_CITIZENSHIP_OR_PR_REQUIRED` — "must be a citizen or permanent resident"
- `SECURITY_CLEARANCE_REQUIRED` — AGSVA / Baseline / NV1 / NV2 / negative vetting
- `NO_VISA_SPONSORSHIP` — "we do not sponsor", "unable to provide sponsorship"

## Chaining
- The user does not have AU citizenship/PR (default profile assumption); any flag = role is unreachable. `evaluate-job` short-circuits to `NOT_FOR_YOU` and skips LLM calls.
- If the user actually does hold one of these, edit `src/tools/flag-eligibility/index.ts` to remove the relevant pattern group, or simply ignore the flag manually.
