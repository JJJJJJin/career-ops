---
name: indeed-extract
description: Fetch a single Indeed job posting URL, parse JSON-LD JobPosting for structured fields, persist as a Job row in the DB with source='indeed'. Use when the user pastes an Indeed URL (au.indeed.com / www.indeed.com) or wants to refresh a single cached Indeed job. Cheap — uses no LLM tokens unless the description is missing/thin and the LLM fallback fires. jobIds are namespaced `indeed:<jk>` so they don't collide with SEEK or LinkedIn.
---

# indeed-extract

## When to use
- User pastes an Indeed URL ("here's a job: https://au.indeed.com/viewjob?jk=abc123…")
- User asks to refresh a cached Indeed job's data
- Sub-step inside `evaluate-job` / `apply-job` (auto-invoked when the URL is on indeed.*)

Skip when:
- The user wants the full "should I apply?" verdict → use `evaluate-job`
- The user wants to search by keyword → use `indeed-search`
- The URL is on SEEK → use `seek-extract`; LinkedIn → `linkedin-extract`

## How to invoke
```
career-ops indeed-extract <indeed-url> [--no-llm] [--no-store] [--reextract] [--json]
```

## Inputs
- `<indeed-url>` (required) — full Indeed job URL. Accepted forms:
  - `https://au.indeed.com/viewjob?jk=<key>`
  - `https://www.indeed.com/viewjob?jk=<key>`
  - tracking redirects like `/rc/clk?jk=<key>&…` (the `jk=` is what matters)
- `--no-llm` — skip the LLM fallback even if the description is thin.
- `--no-store` — don't write to DB.
- `--reextract` — force-refetch even if already cached.
- `--json` — emit the full Job as JSON.

## Outputs
- Stdout: one-line summary (title, company, classification, description char count).
- DB: full row in `jobs` with `source='indeed'`. jobId is `indeed:<jk>` to disambiguate from SEEK / LinkedIn.

## Anti-bot notes
Indeed sometimes serves an interstitial CAPTCHA or a blank shell. If extraction returns very few description chars:
- Re-run with `--reextract` and `HEADLESS=false` to see what Indeed served
- Indeed may rate-limit the IP for a few minutes — try again later

## Chaining
- After this, the user usually wants `evaluate-job <jobId>` (or pass the URL directly to evaluate-job) to score the role.
- The downstream pipeline (`evaluate-job`, `generate-resume`, `generate-cover-letter`, etc.) is source-agnostic — Indeed jobs flow through the same generators as SEEK / LinkedIn jobs, and artefacts land in `output/indeed/<slug>/`.
