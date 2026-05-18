---
name: builtin-search
description: Search Built In (builtin.com) for tech jobs by keyword and ingest results into the local SQLite DB. Use when the user asks to "find jobs on Built In", "search Built In for X roles", "scan builtin.com", or wants Built In discovery alongside SEEK / LinkedIn / Indeed. Built In is US- and remote-centric — location is advisory only (a "remote" hint flips the remote facet; other locations are ignored as server filters). Filters out senior/lead/principal titles by default. Returns thin job stubs; full descriptions are fetched later by builtin-extract / evaluate-job.
---

# builtin-search

## When to use
- User wants to discover Built In (builtin.com) postings — strong for US tech / startup / remote roles
- Multi-source daily refresh (combined with `seek-search` / `linkedin-search` / `indeed-search`)
- First step inside a Built In-focused `daily-pipeline --source builtin` run

Skip when:
- The user already has a specific Built In URL → use `builtin-extract` or `evaluate-job` directly
- The user wants to *read* what's already in the DB → use `query-jobs`

## How to invoke
```
career-ops builtin-search [-q "keyword"] [--location "Remote"] [--days 7] [--max 40] [--include-senior] [--no-store] [--json]
```

## Inputs
- `-q / --keyword <string>` — repeat to search multiple keywords. Defaults to `SEARCH_KEYWORDS` env.
- `--location <string>` — **advisory for Built In.** Built In's location facet uses internal location ids, not free text, so a generic value like "All Australia" can't be applied as a server filter and is ignored. Only a value containing "remote" has effect (flips Built In's remote facet). Defaults to `SEARCH_LOCATION` env.
- `--days <N>` — date-range in days (mapped best-effort to Built In's `daysSinceUpdated` facet). Defaults to `DATE_RANGE_DAYS` env.
- `--max <N>` — polite cap per keyword. Default 40.
- `--include-senior` — disable the senior/lead/principal title filter.
- `--no-store` — don't write to DB or scan_runs (useful for dry runs).

## Outputs
- Stdout: per-keyword counts and a list of job stubs (`🆕` marks new ones).
- DB: thin `jobs` rows with `source='builtin'` (full description filled in later by builtin-extract). jobIds are namespaced `builtin:<id>`.
- DB: `scan_runs` row per keyword with `source='builtin'`.
- `--json` for piping to other tools.

## Notes
- Built In is primarily a US / remote tech-jobs board. If you run it with the default `SEARCH_LOCATION=All Australia`, that location is dropped (Built In can't filter by it) and you get global/US/remote results. Set `--location remote` to bias toward remote roles.
- The listing is client-rendered — the tool waits for job links to hydrate before scraping. If you get zero cards, raise `SLOW_MO_MS` or run `HEADLESS=false` to inspect.

## Chaining
- After this, the user usually wants `query-jobs --since-days N --eligible-only` to filter the new results.
- For a full scan→evaluate→apply loop, prefer `daily-pipeline --source builtin` instead.
- Each new stub still needs `builtin-extract` before it can be evaluated — `evaluate-job <url>` auto-extracts when given a URL.
