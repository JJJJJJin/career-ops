---
name: builtin-extract
description: Fetch a single Built In (builtin.com) job posting URL, parse JSON-LD JobPosting for structured fields, persist as a Job row in the DB with source='builtin'. Use when the user pastes a builtin.com URL (or a legacy regional host like builtinnyc.com) or wants to refresh a single cached Built In job. Cheap — uses no LLM tokens unless the description is missing/thin and the LLM fallback fires. jobIds are namespaced `builtin:<id>` so they don't collide with SEEK, LinkedIn, or Indeed.
---

# builtin-extract

## When to use
- User pastes a Built In URL ("here's a job: https://builtin.com/job/software-engineer/1234567")
- User asks to refresh a cached Built In job's data
- Sub-step inside `evaluate-job` / `apply-job` (auto-invoked when the URL is on builtin.com)

Skip when:
- The user wants the full "should I apply?" verdict → use `evaluate-job`
- The user wants to search by keyword → use `builtin-search`
- The URL is on SEEK → use `seek-extract`; LinkedIn → `linkedin-extract`; Indeed → `indeed-extract`

## How to invoke
```
career-ops builtin-extract <builtin-url> [--no-llm] [--no-store] [--reextract] [--json]
```

## Inputs
- `<builtin-url>` (required) — full Built In job URL. Accepted forms:
  - `https://builtin.com/job/<role-slug>/<numeric-id>`
  - `https://builtin.com/job/<numeric-id>`
  - `https://builtin.com/company/<company-slug>/job/<numeric-id>`
  - legacy regional hosts (`builtinnyc.com`, `builtinla.com`, …) — they 301 to builtin.com
  - tracking params (`?utm_…`) are stripped; the trailing numeric id is what matters
- `--no-llm` — skip the LLM fallback even if the description is thin.
- `--no-store` — don't write to DB.
- `--reextract` — force-refetch even if already cached.
- `--json` — emit the full Job as JSON.

## Outputs
- Stdout: one-line summary (title, company, classification, description char count).
- DB: full row in `jobs` with `source='builtin'`. jobId is `builtin:<id>` to disambiguate from SEEK / LinkedIn / Indeed.

## Notes
Built In is SEO-heavy, so JSON-LD JobPosting is usually present and extraction is LLM-free. The page hydrates the description client-side — the tool waits for the JSON-LD or description container before scraping. If extraction returns very few description chars, re-run with `--reextract` and `HEADLESS=false` to inspect.

## Chaining
- After this, the user usually wants `evaluate-job <jobId>` (or pass the URL directly to evaluate-job) to score the role.
- The downstream pipeline (`evaluate-job`, `generate-resume`, `generate-cover-letter`, etc.) is source-agnostic — Built In jobs flow through the same generators as SEEK / LinkedIn / Indeed jobs, and artefacts land in `output/builtin/<slug>/`.
