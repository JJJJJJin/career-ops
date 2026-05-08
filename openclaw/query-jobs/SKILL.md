---
name: query-jobs
description: Read the local SQLite DB with composable filters — by status, eligibility, score, keyword, company, recency. Tabular or JSON output. Use whenever the user asks to see what's in the pipeline (today / this week / applied / by tech / etc.).
---

# query-jobs

## When to use
- "What did I apply to last month?"
- "Any python roles this week?"
- "Show me unscored jobs"
- "Top 10 STRONG matches"

Skip when:
- The user wants details on ONE job → use `show-job`
- The user wants aggregate counts → use `job-stats`

## How to invoke
```
career-ops query-jobs [--since-days N] [--eligible-only|--ineligible-only] [--min-score X] [--status STATUS] [-q "keyword"] [--company NAME] [--limit N] [--json]
```

## Inputs (all optional, AND'd together)
- `--since-days N` — restrict to jobs fetched in the last N days
- `--eligible-only` / `--ineligible-only` — filter by eligibility flags
- `--min-score X` — only show applications scored at X/5 or higher
- `--status STATUS` — `new | interested | applied | interview | rejected | offer | skip`
- `-q "keyword"` / `--keyword` — case-insensitive substring across title/company/description
- `--company NAME` — case-insensitive substring on company
- `--limit N` — cap results

## Outputs
- Stdout: `<rec> <score> <status> <company> <title> [<jobId>]` per row, sorted by score desc then fetched-at desc.
- `--json` for piping to other tools.

## Common combos
- `--since-days 7 --eligible-only` — this week's reachable jobs
- `--status applied --since-days 30` — applications from the last month
- `--min-score 4 --status new` — STRONG matches you haven't acted on
