---
name: linkedin-extract
description: Fetch a single LinkedIn job posting URL (public, login-free), parse JSON-LD JobPosting for structured fields, persist as a Job row in the DB with source='linkedin'. Use when the user pastes a LinkedIn jobs URL or wants to refresh a single cached LinkedIn job. Cheap — uses no LLM tokens unless the description is missing/thin and the LLM fallback fires. jobIds are namespaced `linkedin:<numeric>` so they don't collide with SEEK.
---

# linkedin-extract

## When to use
- User pastes a LinkedIn URL ("here's a job: https://www.linkedin.com/jobs/view/3927464923")
- User asks to refresh a cached LinkedIn job's data
- Sub-step inside `evaluate-job` / `apply-job` (auto-invoked when the URL is on linkedin.com)

Skip when:
- The user wants the full "should I apply?" verdict → use `evaluate-job`
- The user wants to search by keyword → use `linkedin-search`
- The URL is on SEEK → use `seek-extract`

## How to invoke
```
career-ops linkedin-extract <linkedin-url> [--no-llm] [--no-store] [--reextract] [--json]
```

## Inputs
- `<linkedin-url>` (required) — public LinkedIn job URL, e.g. `https://www.linkedin.com/jobs/view/<id>` or any URL containing `/jobs/view/<numeric-id>`.
- `--no-llm` — skip the LLM fallback even if the description is thin.
- `--no-store` — don't write to DB.
- `--reextract` — force-refetch even if already cached.
- `--json` — emit the full Job as JSON.

## Outputs
- Stdout: one-line summary (title, company, classification, description char count).
- DB: full row in `jobs` with `source='linkedin'`. jobId is `linkedin:<numeric>` to disambiguate from SEEK.

## Auth
This tool only works with **public** LinkedIn jobs (login-free guest view). If a posting requires login, the description will be empty / paywalled and the LLM fallback will likely fail too.

## Chaining
- After this, the user usually wants `evaluate-job <jobId>` (or pass the URL directly to evaluate-job) to score the role.
- The downstream pipeline (`evaluate-job`, `generate-resume`, `generate-cover-letter`, etc.) is source-agnostic — LinkedIn jobs flow through the same generators as SEEK jobs.
