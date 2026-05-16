---
name: indeed-search
description: Search Indeed Australia (au.indeed.com) for jobs by keyword and ingest results into the local SQLite DB. Use when the user asks to "find jobs on Indeed", "search Indeed for X roles", "scan Indeed", or wants Indeed-side discovery alongside SEEK / LinkedIn. Filters out senior/lead/principal titles by default. Returns thin job stubs; full descriptions are fetched later by indeed-extract / evaluate-job. Indeed throttles aggressively — keep MAX_JOBS_PER_KEYWORD modest if you hit blank pages.
---

# indeed-search

## When to use
- User wants to discover Indeed postings
- Multi-source daily refresh (combined with `seek-search` / `linkedin-search`)
- First step inside an Indeed-focused `daily-pipeline --source indeed` run

Skip when:
- The user already has a specific Indeed URL → use `indeed-extract` or `evaluate-job` directly
- The user wants to *read* what's already in the DB → use `query-jobs`

## How to invoke
```
career-ops indeed-search [-q "keyword"] [--location "Australia"] [--days 7] [--max 40] [--include-senior] [--no-store] [--json]
```

## Inputs
- `-q / --keyword <string>` — repeat to search multiple keywords. Defaults to `SEARCH_KEYWORDS` env.
- `--location <string>` — defaults to `SEARCH_LOCATION` env. Indeed accepts city, state, postcode, or "Australia".
- `--days <N>` — date-range in days (mapped to Indeed's `fromage` param). Defaults to `DATE_RANGE_DAYS` env.
- `--max <N>` — polite cap per keyword. Default 40. Lower if Indeed bot-blocks you.
- `--include-senior` — disable the senior/lead/principal title filter.
- `--no-store` — don't write to DB or scan_runs (useful for dry runs).

## Outputs
- Stdout: per-keyword counts and a list of job stubs (`🆕` marks new ones).
- DB: thin `jobs` rows with `source='indeed'` (full description filled in later by indeed-extract).
- DB: `scan_runs` row per keyword with `source='indeed'`.
- `--json` for piping to other tools.

## Anti-bot notes
Indeed is more aggressive than SEEK/LinkedIn about CAPTCHAs and blank-result pages. If you get zero cards on the first page:
- Lower `--max` (or `MAX_JOBS_PER_KEYWORD` in `.env`) to ~10–20
- Raise `SLOW_MO_MS` to 300+
- Try `HEADLESS=false` to inspect what Indeed is actually serving

## Chaining
- After this, the user usually wants `query-jobs --since-days N --eligible-only` to filter the new results.
- For a full scan→evaluate→apply loop, prefer `daily-pipeline --source indeed` instead.
- Each new stub still needs `indeed-extract` before it can be evaluated — `evaluate-job <url>` auto-extracts when given a URL.
