---
name: seek-search
description: Search SEEK Australia for jobs by keyword and ingest results into the local SQLite DB. Use when the user asks to "find jobs", "scan SEEK", "search for X roles", "look for new postings", or wants a daily refresh of postings. Filters out senior/lead/principal titles by default. Returns thin job stubs (full descriptions are fetched later by seek-extract / evaluate-job).
---

# seek-search

## When to use
- User wants to discover new SEEK postings ("find me Python grad roles", "any new AI engineer jobs?")
- Daily / weekly job-news refresh
- First step inside the `daily-pipeline` workflow

Skip when:
- The user already has a specific URL → use `seek-extract` or `evaluate-job` directly
- The user wants to *read* what's already in the DB → use `query-jobs`

## How to invoke
```
career-ops seek-search [-q "keyword"] [--location "All Australia"] [--days 7] [--max 40] [--include-senior] [--no-store] [--json]
```

## Inputs
- `-q / --keyword <string>` — repeat to search multiple keywords. Defaults to `SEARCH_KEYWORDS` env (graduate/junior SWE & AI engineer).
- `--location <string>` — defaults to `SEARCH_LOCATION` env (`All Australia`).
- `--days <1|3|7|14|31>` — SEEK supports these specific values. Defaults to `DATE_RANGE_DAYS` env (7).
- `--max <N>` — polite cap per keyword. Default 40.
- `--include-senior` — disable the senior/lead/principal title filter.
- `--no-store` — don't write to DB or scan_runs (useful for dry runs).

## Outputs
- Stdout: per-keyword counts and a list of job stubs (`🆕` marks new ones).
- DB: thin `jobs` rows (full description filled in later by seek-extract).
- DB: `scan_runs` row per keyword.
- `--json` for piping to other tools.

## Chaining
- After this, the user usually wants `query-jobs --since-days N --eligible-only` to filter the new results.
- For a full scan→evaluate→apply loop, prefer `daily-pipeline` instead.
- Each new stub still needs `seek-extract` before it can be evaluated — `daily-pipeline` does this for you.
