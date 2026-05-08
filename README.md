# career-ops

A SEEK-focused job-search pipeline you drive from Claude Code (or any
terminal). Twenty composable tools — scan, extract, evaluate, tailor,
render — wired together as openclaw skills. The agent picks one tool or
chains many depending on what you ask.

> Originally forked from [santifer/career-ops](https://github.com/santifer/career-ops).
> This fork strips it down to: SEEK Australia only, TypeScript +
> Playwright, single direct-API stack (Anthropic), every step exposed as
> a Claude Code skill so your local openclaw can compose them.

## What you get per job

```
output/<company-slug>-<role-slug>/
├── resume.pdf            ← submit this
├── resume.md             ← human-readable view
├── resume.json           ← structured (re-renderable)
├── cover_letter.pdf      ← submit this
├── cover_letter.md
├── cover_letter.json
├── company_brief.md      ← read before applying / interviewing
├── company_brief.json
└── last-updated-<ts>.txt
```

…plus a fit score (0–5) and a recommendation (`STRONG`, `BORDERLINE`,
`SKIP`, `NOT_FOR_YOU`) stored in the local SQLite DB and rendered as
`data/applications.md`.

## Quick start

```bash
git clone https://github.com/JJJJJJin/career-ops.git
cd career-ops
npm install
npx playwright install chromium

cp .env.example .env       # set ANTHROPIC_API_KEY
$EDITOR profile/profile.md  # write your CV (see "Profile format" below)

./scripts/install-skills.sh # symlink openclaw skills into ~/.claude/skills/

# Run from the terminal …
npm run career-ops -- evaluate-job https://www.seek.com.au/job/12345678

# … or just ask Claude Code:
#   "should I apply to https://seek.com.au/job/12345678"
```

## Tool catalog

Every tool has a discrete CLI (`career-ops <tool>`) and a matching
`openclaw/<tool>/SKILL.md` so Claude Code can invoke it from natural
language. The pure functions are importable from `src/tools/<tool>/index.ts`.

### Discovery & ingestion

| Tool | Contract | LLM? |
|---|---|---|
| **`seek-search`** | keywords, location, days → `[{jobId, url, title, company}]` (upserts thin job rows + scan_runs) | no |
| **`seek-extract`** | url → `SeekJob` (parses JSON-LD + `__NEXT_DATA__`, falls back to visible text, then LLM) | rare |
| **`web-distill`** | any url → clean markdown (Mozilla Readability + sanitize-html) | no |

### Profile

| Tool | Contract | LLM? |
|---|---|---|
| **`distill-profile`** | `profile.md` → `profile.json` (`StructuredProfile`, hash-cached) | yes |

### Evaluation

| Tool | Contract | LLM? |
|---|---|---|
| **`flag-eligibility`** | jobId → `EligibilityFlag[]` (regex on JD: AU citizenship, PR, clearance, no-sponsorship) | no |
| **`summarize-job`** | jobId → `JobSummary` (must-haves / nice-to-haves / tech / seniority) | yes |
| **`match-job`** | jobId → `MatchAnalysis` (fitScore 0–100, recommendation, strengths/gaps with cited evidence) | yes |
| **`evaluate-job`** ⭐ | url\|jobId → `{eligibility, summary, match}` (composite; eligibility short-circuit) | yes |

### Generation

| Tool | Contract | LLM? |
|---|---|---|
| **`generate-resume`** | jobId → `resume.json` + `resume.md` (variant-aware) | yes |
| **`generate-cover-letter`** | jobId → `cover_letter.json` + `cover_letter.md` (3 paragraphs, < 250 words) | yes |
| **`generate-company-brief`** | jobId, optional company URL → `company_brief.md` (web-distill grounded if URL given) | yes |

### Rendering

| Tool | Contract | LLM? |
|---|---|---|
| **`render-resume-pdf`** | jobId → `resume.pdf` (Playwright HTML→PDF) | no |
| **`render-cover-letter-pdf`** | jobId → `cover_letter.pdf` | no |

### Tracking

| Tool | Contract | LLM? |
|---|---|---|
| **`query-jobs`** | filters → table\|JSON | no |
| **`show-job`** | jobId → full record + application state | no |
| **`mark-job`** | jobId, status, notes? → updates `applications.status` | no |
| **`job-stats`** | — → counts by status / recommendation / eligibility | no |
| **`render-tracker`** | — → regenerates `data/applications.md` from DB | no |

### Workflows

| Tool | Chains |
|---|---|
| **`apply-job`** ⭐ | `evaluate-job` → (parallel) `generate-{resume, cover-letter, company-brief}` → (parallel) `render-{resume, cover-letter}-pdf` → `render-tracker` |
| **`daily-pipeline`** | `seek-search` → for each new job: `seek-extract` + `evaluate-job` → optional auto-`apply-job` for top N STRONG matches |

⭐ = the two main entry points. Most natural-language asks route to one of these.

## Workflow examples

```bash
# Score one role
career-ops evaluate-job https://www.seek.com.au/job/12345678
#   → 4.2/5  STRONG
#   → next: career-ops apply-job 12345678

# Generate the full bundle
career-ops apply-job 12345678
#   → output/acme-pty-ltd-senior-backend-engineer/
#       ├── resume.pdf
#       ├── cover_letter.pdf
#       └── company_brief.md

# Daily morning brief (with auto-apply for STRONG matches)
career-ops daily-pipeline --auto-apply-top 3

# What's in the pipeline?
career-ops query-jobs --since-days 7 --eligible-only --min-score 4
career-ops job-stats

# I applied to one
career-ops mark-job 12345678 applied --notes "applied via SEEK Easy Apply"
```

## openclaw integration

Once `./scripts/install-skills.sh` has linked the skills into
`~/.claude/skills/career-ops/`, your Claude Code instance can route from
natural language:

| User says | openclaw chains |
|---|---|
| "find me python grad jobs this week" | `seek-search -q python --days 7` → `query-jobs --since-days 7 --eligible-only` |
| "should I apply to https://seek.com.au/job/12345" | `evaluate-job 12345` |
| "yes, apply" | `apply-job 12345` |
| "what did I apply to last month?" | `query-jobs --status applied --since-days 30` |
| "regenerate the resume PDF" | `render-resume-pdf 12345` |
| "morning brief" | `daily-pipeline` |
| "I got rejected from Acme" | find jobId, then `mark-job <jobId> rejected` |

Add new natural-language patterns by editing the `description:` field in
the relevant `openclaw/<tool>/SKILL.md`.

## Profile format

Write your CV in `profile/profile.md` as free-form markdown. The
distiller is faithful — it never invents facts. Include every detail you
might want pulled into a tailored resume.

```markdown
# Jin Doe — Software Engineer
hello@example.com · Sydney, AU · linkedin.com/in/jin · github.com/jin

## Summary
2-3 sentence headline.

## Experience
### Software Engineer Intern — Acme Pty Ltd · 2024 · Sydney
- Built X using Y. Reduced Z by N%.
- ...

## Projects

### NRF24L01p Wireless Mesh
**Common tech:** C++, RTOS, FreeRTOS, ...

#### Variant — Embedded / firmware focus
[intro paragraph emphasizing realtime constraints, low-power design]
- highlight emphasizing firmware aspects
- highlight emphasizing hardware bring-up

#### Variant — Backend / IoT platform focus
[intro paragraph emphasizing the gateway service, MQTT bridge, Postgres]
- highlight emphasizing backend aspects
- highlight emphasizing scaling

## Skills
**Languages:** TypeScript, Python, C++, Go
**Frameworks:** React, FastAPI, Playwright
```

### Multi-variant project framings

If a project can be framed differently per role (backend vs AI vs data
engineer), write multiple `#### Variant — <focus>` sub-sections under
one `### <Project Name>` heading. The distiller preserves all variants
as a UNION of highlights/technologies in a single project entry. The
resume generator then picks the **single variant** whose framing best
matches the target job — it never blends them.

## Configuration

`.env` (copy from `.env.example`):

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required for any LLM step |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | use `claude-opus-4-7` for higher quality |
| `SEARCH_KEYWORDS` | grad/junior SWE & AI | comma-separated; one search per keyword |
| `SEARCH_LOCATION` | `All Australia` | any SEEK-recognised string |
| `DATE_RANGE_DAYS` | `7` | SEEK supports 1, 3, 7, 14, 31 |
| `MAX_JOBS_PER_KEYWORD` | `40` | polite cap |
| `HEADLESS` | `true` | `false` shows the browser |
| `SLOW_MO_MS` | `120` | per-op delay |
| `DB_PATH` | `data/seek.sqlite3` | SQLite source-of-truth |
| `APPLICATIONS_DIR` | `output` | per-job artefact folders go here |
| `SCORE_THRESHOLD_STRONG` | `4.0` | scoreOutOf5 ≥ this → STRONG |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error \| silent` |
| `LOG_JSON` | `false` | one-JSON-per-line for log shippers |

## Eligibility flagging

The pipeline scans every JD for signals you can't satisfy and tags the
role `NOT_FOR_YOU` if any fire. Eligibility blocks short-circuit before
the summarize/match LLM calls — saves tokens.

| Flag | Triggered by phrases like |
|---|---|
| `AU_CITIZENSHIP_REQUIRED` | "must be an Australian citizen", "citizens only" |
| `AU_CITIZENSHIP_OR_PR_REQUIRED` | "Australian citizens or permanent residents only" |
| `SECURITY_CLEARANCE_REQUIRED` | AGSVA, Baseline / NV1 / NV2 clearance, security clearance |
| `NO_VISA_SPONSORSHIP` | "we do not sponsor", "unable to provide sponsorship" |

Flagged roles are kept in the DB (so you can read the evidence and
verify) but evaluation skips the LLM. Edit
`src/tools/flag-eligibility/index.ts` to tune the patterns.

## Project layout

```
career-ops/
├── package.json                  # bin: career-ops → dist/bin.js
├── tsconfig.json
├── .env.example
├── README.md                     # this file
├── CLAUDE.md                     # short pointer for Claude Code
├── profile/                      # gitignored — profile.md + profile.json
├── data/                         # gitignored — seek.sqlite3 + applications.md
├── output/                       # gitignored — per-job artefacts
├── reports/                      # gitignored — reserved
├── templates/
│   ├── resume.html               # adapted from career-ops
│   ├── cover-letter.html
│   └── states.yml
├── fonts/                        # Space Grotesk + DM Sans
├── scripts/
│   └── install-skills.sh
├── src/
│   ├── bin.ts                    # CLI dispatcher
│   ├── tools/<tool>/             # 18 tools (index.ts + cli.ts)
│   ├── workflows/                # apply-job, daily-pipeline
│   └── shared/                   # logger, config, llm, browser, db, render, slug
└── openclaw/<tool>/SKILL.md      # 20 skill manifests + index
```

## SQLite schema

Three tables:

- **`jobs`** — raw scraped data (title, company, description, classification, eligibility flags). One row per SEEK posting.
- **`applications`** — LLM-derived score + status. `status` lifecycle: `new → interested → applied → interview → rejected | offer | skip`.
- **`scan_runs`** — history of `seek-search` invocations (per keyword: jobs found, jobs new).

`data/applications.md` is generated from these tables and is **read-only** —
edit via `mark-job`, never by hand.

## Troubleshooting

- **"profile.md has changed since last distillation"** — run `career-ops distill-profile`.
- **SEEK selector drift** — selectors are in `src/tools/seek-search/index.ts` (top of file). Update there when SEEK churns.
- **CAPTCHA / anti-bot** — use lower `MAX_JOBS_PER_KEYWORD`, increase `SLOW_MO_MS`, or run with `HEADLESS=false` to inspect.
- **LLM returned non-JSON** — `src/shared/llm/client.ts` has retry + fence-stripping + balanced-object fallback. If it still fails, raise `--max-tokens` (the model may be truncating).
- **Anthropic rate limits** — set `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` for cheap iteration.
- **Resume PDF fonts blank** — fonts load via relative `../fonts/*.woff2`. The renderer writes the HTML next to `templates/`; if you moved that directory, update `config.paths.templatesDir`.

## Disclaimer

This is a local tool. Your data stays on your machine and is sent only
to the LLM provider you configured. The pipeline never auto-submits
applications — every artefact lands in `output/` for you to review and
submit yourself. Use in accordance with the SEEK Terms of Service; do
not spam employers.

## License

MIT. See [LICENSE](LICENSE). Originally forked from
[santifer/career-ops](https://github.com/santifer/career-ops); credit
remains to the original author for the resume template and the overall
pipeline shape.
