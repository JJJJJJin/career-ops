---
name: seek-extract
description: Fetch a single SEEK job posting URL, parse JSON-LD + __NEXT_DATA__ for structured fields, persist as a SeekJob row in the DB. Use when the user pastes a SEEK URL or wants to refresh a single cached job. Cheap — uses no LLM tokens unless the description is missing/thin and the LLM fallback fires.
---

# seek-extract

## When to use
- User pastes a SEEK URL ("here's a job: https://seek.com.au/job/12345")
- User asks to refresh a cached job's data
- Sub-step inside `evaluate-job` and `apply-job` (auto-invoked when needed)

Skip when:
- The user wants the full "should I apply?" verdict → use `evaluate-job`
- The user wants to search by keyword → use `seek-search`

## How to invoke
```
career-ops seek-extract <seek-url> [--no-llm] [--no-store] [--reextract] [--json]
```

## Inputs
- `<seek-url>` (required) — full SEEK job URL or a URL containing `/job/<numeric-id>`.
- `--no-llm` — skip the LLM fallback even if the description is thin.
- `--no-store` — don't write to DB.
- `--reextract` — force-refetch even if already cached.
- `--json` — emit the full SeekJob as JSON.

## Outputs
- Stdout: one-line summary (title, company, classification, description char count).
- DB: full row in `jobs` (job_id, url, title, company, location, work_type, classification, description, salary, posted_date).

## Chaining
- After this, the user usually wants `evaluate-job <jobId>` to score the role.
- If you only want the description text, `--json` and pipe to `jq '.description'`.
