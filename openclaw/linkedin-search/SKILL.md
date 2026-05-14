---
name: linkedin-search
description: Search LinkedIn for jobs by keyword via the public guest endpoint (no login). Use when the user asks to "find jobs on LinkedIn", "search LinkedIn for X roles", "scan LinkedIn", or wants LinkedIn-side discovery alongside SEEK. Filters out senior/lead/principal titles by default. Returns thin job stubs; full descriptions are fetched later by linkedin-extract / evaluate-job. Only public, login-free postings are visible.
---

# linkedin-search

## When to use
- User wants to discover LinkedIn postings without logging in
- Multi-source daily refresh (combined with `seek-search`)
- First step inside a LinkedIn-focused `daily-pipeline --source linkedin` run

Skip when:
- The user already has a specific LinkedIn URL → use `linkedin-extract` or `evaluate-job` directly
- The user wants to *read* what's already in the DB → use `query-jobs`

## How to invoke
```
career-ops linkedin-search [-q "keyword"] [--location "Australia"] [--days 7] [--max 40] [--include-senior] [--no-store] [--json]
```

## Inputs
- `-q / --keyword <string>` — repeat to search multiple keywords. Defaults to `SEARCH_KEYWORDS` env.
- `--location <string>` — defaults to `SEARCH_LOCATION` env.
- `--days <N>` — date-range in days (mapped to LinkedIn's `f_TPR` seconds). Defaults to `DATE_RANGE_DAYS` env.
- `--max <N>` — polite cap per keyword. Default 40.
- `--include-senior` — disable the senior/lead/principal title filter.
- `--no-store` — don't write to DB or scan_runs (useful for dry runs).

## Outputs
- Stdout: per-keyword counts and a list of job stubs (`🆕` marks new ones).
- DB: thin `jobs` rows with `source='linkedin'` (full description filled in later by linkedin-extract).
- DB: `scan_runs` row per keyword with `source='linkedin'`.
- `--json` for piping to other tools.

## Chaining
- After this, the user usually wants `query-jobs --since-days N --eligible-only` to filter the new results.
- For a full scan→evaluate→apply loop, prefer `daily-pipeline --source linkedin` instead.
- Each new stub still needs `linkedin-extract` before it can be evaluated — `evaluate-job <url>` auto-extracts when given a URL.
