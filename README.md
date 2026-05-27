# career-ops

A multi-source job-search pipeline (SEEK, LinkedIn, Indeed, Built In) you drive
from Claude Code (or any terminal). Twenty-plus composable tools — scan, extract,
evaluate, tailor, render — wired together as openclaw skills. The agent picks
one tool or chains many depending on what you ask.

> Originally forked from [santifer/career-ops](https://github.com/santifer/career-ops).
> This fork stripped it down to TypeScript + Playwright, multi-provider LLM
> (OpenAI primary + DeepSeek fallback, also Gemini & Groq), and rebuilt every
> step as a Claude Code skill so your local openclaw can compose them. SEEK
> Australia is the original target; LinkedIn and Indeed Australia are wired in
> through the same source-agnostic registry.

## What you get per job

Every artefact is prefixed with the folder's slug (`<company-slug>-<role-slug>`) so files stay self-describing once they're out of the folder (email attachments, chat uploads, etc.). The folder is namespaced by source platform — `output/seek/`, `output/linkedin/`, `output/indeed/`, `output/builtin/` — so you can eyeball at a glance which platform a result came from.

```
output/<source>/<slug>/                           # <source> = seek|linkedin|indeed|builtin
├── <slug>-resume.pdf            ← submit this        # <slug> = <company-slug>-<role-slug>
├── <slug>-resume.md             ← human-readable view
├── <slug>-resume.json           ← structured (re-renderable)
├── <slug>-cover_letter.pdf      ← submit this
├── <slug>-cover_letter.md
├── <slug>-cover_letter.json
├── <slug>-company_brief.pdf     ← read before applying / interviewing (or forward to phone)
├── <slug>-company_brief.md
├── <slug>-company_brief.json
└── last-updated-<ts>.txt
```

When `EMAIL_USER` / `EMAIL_APP_PASSWORD` / `EMAIL_TO` are set in `.env`,
`apply-job` automatically emails the three PDFs to your inbox so you
can review on a phone. For pushing files to a group chat (e.g. a
personal-AI-agent room), use the standalone `send-files` tool.

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

./scripts/install-skills.sh # bakes absolute paths into ~/.claude/skills/career-ops/

# Run from the terminal …
./scripts/career-ops evaluate-job https://www.seek.com.au/job/12345678
# (or `npm run career-ops -- evaluate-job <url>` — same thing)

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
| **`seek-search`** | keywords, location, days → `[{jobId, url, title, company}]` (upserts thin job rows + scan_runs, `source='seek'`) | no |
| **`seek-extract`** | url → `Job` (parses JSON-LD + `__NEXT_DATA__`, falls back to visible text, then LLM) | rare |
| **`linkedin-search`** | same contract as seek-search but against LinkedIn's public guest endpoint, `source='linkedin'` | no |
| **`linkedin-extract`** | url → `Job` (LinkedIn JSON-LD JobPosting, `linkedin:<id>` namespacing) | rare |
| **`indeed-search`** | same contract as seek-search but against Indeed Australia, `source='indeed'` | no |
| **`indeed-extract`** | url → `Job` (Indeed JSON-LD JobPosting, `indeed:<jk>` namespacing) | rare |
| **`builtin-search`** | same contract as seek-search but against Built In (builtin.com), `source='builtin'`. US/remote-centric — location is advisory (a "remote" hint only) | no |
| **`builtin-extract`** | url → `Job` (Built In JSON-LD JobPosting, `builtin:<id>` namespacing) | rare |
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
| **`generate-resume`** | jobId → `<slug>-resume.json` + `<slug>-resume.md` (variant-aware) | yes |
| **`generate-cover-letter`** | jobId → `<slug>-cover_letter.json` + `<slug>-cover_letter.md` (3 paragraphs, < 250 words) | yes |
| **`generate-company-brief`** | jobId, optional company URL → `<slug>-company_brief.md` (web-distill grounded if URL given) | yes |

### Rendering

| Tool | Contract | LLM? |
|---|---|---|
| **`render-resume-pdf`** | jobId → `<slug>-resume.pdf` (Playwright HTML→PDF) | no |
| **`render-cover-letter-pdf`** | jobId → `<slug>-cover_letter.pdf` | no |
| **`render-company-brief-pdf`** | jobId → `<slug>-company_brief.pdf` | no |

### Delivery

| Tool | Contract | LLM? |
|---|---|---|
| **`send-files`** | one or more file paths (or `--job <jobId>`) → pushed to a webhook chat (WeChat Work today; pluggable provider layer) | no |

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
| **`apply-job`** ⭐ | `evaluate-job` → (parallel) `generate-{resume, cover-letter, company-brief}` → (parallel) `render-{resume, cover-letter, company-brief}-pdf` → `render-tracker` → (optional) email PDF bundle to `$EMAIL_TO` |
| **`daily-pipeline`** | `<source>-search` (seek\|linkedin\|indeed\|builtin) → for each new job: `<source>-extract` + `evaluate-job` → optional auto-`apply-job` for top N STRONG matches |

⭐ = the two main entry points. Most natural-language asks route to one of these.

## Workflow examples

```bash
# Score one role
career-ops evaluate-job https://www.seek.com.au/job/12345678
#   → 4.2/5  STRONG
#   → next: career-ops apply-job 12345678

# Generate the full bundle
career-ops apply-job 12345678
#   → output/seek/acme-pty-ltd-senior-backend-engineer/
#       ├── acme-pty-ltd-senior-backend-engineer-resume.pdf
#       ├── acme-pty-ltd-senior-backend-engineer-cover_letter.pdf
#       └── acme-pty-ltd-senior-backend-engineer-company_brief.md
#
# Indeed / LinkedIn URLs land under their own subdir:
career-ops apply-job https://au.indeed.com/viewjob?jk=abc123…
#   → output/indeed/acme-pty-ltd-backend-engineer/…

# Daily morning brief (with auto-apply for STRONG matches)
career-ops daily-pipeline --auto-apply-top 3

# What's in the pipeline?
career-ops query-jobs --since-days 7 --eligible-only --min-score 4
career-ops job-stats

# I applied to one
career-ops mark-job 12345678 applied --notes "applied via SEEK Easy Apply"

# Push a job's PDFs to my personal-AI-agent group chat (separate from email)
career-ops send-files --job 12345678
# or send arbitrary files
career-ops send-files /tmp/screenshot.png /path/to/notes.pdf --text "fyi"
```

## openclaw integration

Once `./scripts/install-skills.sh` has linked the skills into
`~/.claude/skills/career-ops/`, your Claude Code instance can route from
natural language:

| User says | openclaw chains |
|---|---|
| "find me python grad jobs this week" | `seek-search -q python --days 7` → `query-jobs --since-days 7 --eligible-only` |
| "scan Indeed for AI engineer roles" | `indeed-search -q "ai engineer" --days 7` |
| "find remote roles on Built In" | `builtin-search -q "software engineer" --location remote` |
| "should I apply to https://seek.com.au/job/12345" | `evaluate-job 12345` |
| "should I apply to https://au.indeed.com/viewjob?jk=abc…" | `evaluate-job <url>` (auto-routes through indeed-extract) |
| "yes, apply" | `apply-job 12345` |
| "what did I apply to last month?" | `query-jobs --status applied --since-days 30` |
| "regenerate the resume PDF" | `render-resume-pdf 12345` |
| "morning brief" | `daily-pipeline --source seek --source indeed` |
| "I got rejected from Acme" | find jobId, then `mark-job <jobId> rejected` |

Add new natural-language patterns by editing the `description:` field in
the relevant `openclaw/<tool>/SKILL.md`.

## MCP server (stateful, agent-driven)

The whole toolset is also exposed over the **Model Context Protocol** (`src/mcp/`),
which inverts the automation model: instead of an internal LLM resolver deciding
clicks, **your local agent is the reasoner** and the server is a stateful service.

```bash
npm run mcp-serve            # localhost Streamable-HTTP daemon (default)
# or: npm run mcp-stdio      # stdio, spawned by the client

# register with Claude Code:
claude mcp add --transport http career-ops http://127.0.0.1:8731/mcp
#   (stdio: claude mcp add career-ops -- node dist/mcp/transports/stdio.js)
```

Why a server: it **holds one live browser session and the run-state across the
whole conversation** — so it can keep a half-finished, logged-in session open
*while it asks you for a captcha or an emailed code*, then carry on. The browser
is launched lazily and idle-closed (`MCP_BROWSER_IDLE_MS`) to spare RAM on a Pi;
cookies persist across the close.

**Tool families**

| Family | Tools | What they do |
|---|---|---|
| Session | `session_status` / `session_open` / `session_close` | manage the one live browser |
| Perceive | `browser_observe` | ref-tagged snapshot of interactive elements |
| Act (atomic) | `browser_click` / `browser_type` / `browser_select` / `browser_check` / `browser_upload` / `browser_press` / `browser_goto` / `browser_read` / `browser_screenshot` / `browser_assert` | one human-like action on a `ref` |
| SEEK semantic | `seek_login_status` / `seek_save_session` / `seek_resume_list` / `seek_resume_rotate` / `seek_apply_{open,detect_step,fill_documents,extract_questions,answer_questions,advance,submit}` | deterministic bundles for SEEK's stable, structured surfaces |
| Catalog | `job_search` / `job_extract` / `evaluate_job` / `generate_*` / `render_*_pdf` / `apply_job` / `daily_pipeline` / `query_jobs` / `show_job` / `mark_job` / `job_stats` / `render_tracker` / `distill_profile` / `send_files` | the stateless pipeline, unchanged |
| Run-state | `run_begin` / `run_note` / `run_status` / `run_end` | durable progress (resume "where were we?") |
| Workflow | `workflow_list` / `workflow_get` / `workflow_propose_fix` / `workflow_apply_fix` | read & self-correct playbooks |

**Playbooks** (`playbooks/`) are Markdown step-by-step guidelines the agent reads
via `workflow_get` (or the `playbook://` resources). Each step says what it's for,
how to recognise the page, which tools to call, how to verify, and *when to stop and
ask you*. The shared `_contract.md` defines the observe→act→verify loop and the
safety rules. When a step breaks, the agent diagnoses it with you, calls
`workflow_propose_fix` (returns a diff, writes nothing), shows you the diff, and only
on your "yes" calls `workflow_apply_fix` — so the next run is more reliable, and you
stay in the loop on what gets "learned".

**Resources:** `playbook://…`, `guideline://seek-answers`, `run://current`,
`profile://json`. **Prompts:** `seek-apply`, `seek-login`, `seek-search-triage`
(each briefs the agent with the contract + the relevant playbook).

Submission stays **double-gated**: `seek_apply_submit` clicks "Submit application"
only with an explicit per-job `humanApproved:true` *or* `SEEK_ALLOW_SUBMIT=true`.
By default every run stops at the review page.

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
| `LLM_PROVIDER` | `openai` | primary provider — `openai \| deepseek \| gemini \| groq` |
| `LLM_MODEL` | `gpt-5.4-nano` | model id; see model presets in `.env.example` |
| `LLM_FALLBACK_PROVIDER` | `deepseek` | tried when primary errors or its key is missing; set empty to disable |
| `LLM_FALLBACK_MODEL` | `deepseek-chat` | DeepSeek V3. Use `deepseek-reasoner` for R1. |
| `OPENAI_API_KEY` | — | required when `LLM_PROVIDER=openai` |
| `DEEPSEEK_API_KEY` | — | required when DeepSeek is primary OR fallback |
| `GEMINI_API_KEY` | — | OpenAI-compat endpoint (`generativelanguage.googleapis.com/v1beta/openai`) |
| `GROQ_API_KEY` | — | OpenAI-compat endpoint (`api.groq.com/openai/v1`) |
| `SEARCH_KEYWORDS` | grad/junior SWE & AI | comma-separated; one search per keyword |
| `SEARCH_LOCATION` | `All Australia` | any SEEK / LinkedIn / Indeed -recognised string. Indeed prefers city/state/postcode or "Australia". **Built In ignores it** (US/remote-centric, internal location ids) — pass `--location remote` to bias remote. |
| `DATE_RANGE_DAYS` | `7` | SEEK supports 1, 3, 7, 14, 31. LinkedIn / Indeed / Built In accept arbitrary day windows. |
| `MAX_JOBS_PER_KEYWORD` | `40` | polite cap |
| `HEADLESS` | `true` | `false` shows the browser |
| `SLOW_MO_MS` | `120` | per-op delay |
| `DB_PATH` | `data/seek.sqlite3` | SQLite source-of-truth |
| `APPLICATIONS_DIR` | `output` | per-job artefact folders go here |
| `SCORE_THRESHOLD_STRONG` | `4.0` | scoreOutOf5 ≥ this → STRONG |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error \| silent` |
| `LOG_JSON` | `false` | one-JSON-per-line for log shippers |
| `EMAIL_HOST` | `smtp.gmail.com` | SMTP host for `apply-job` auto-send |
| `EMAIL_PORT` | `465` | `465` = implicit TLS, `587` = STARTTLS |
| `EMAIL_SECURE` | auto | leave blank to derive from port; `true`/`false` to force |
| `EMAIL_USER` | — | Gmail account; required for email delivery |
| `EMAIL_APP_PASSWORD` | — | 16-char [Google App Password](https://myaccount.google.com/apppasswords) (NOT your regular Gmail password) |
| `EMAIL_FROM` | `$EMAIL_USER` | sender address (set if you use an alias) |
| `EMAIL_TO` | — | recipient — usually your own inbox |
| `EMAIL_SUBJECT_PREFIX` | `[career-ops]` | prepended to every subject |
| `WEBHOOK_PROVIDER` | `wecom` | only `wecom` (WeChat Work) is implemented today |
| `WEBHOOK_URL` | — | default webhook for the `send-files` tool (`?key=...` URL for WeCom) |

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
│   ├── tools/<tool>/             # one dir per tool (index.ts + cli.ts)
│   ├── workflows/                # apply-job, daily-pipeline
│   └── shared/                   # logger, config, llm, browser, db, render, slug
└── openclaw/<tool>/SKILL.md      # one skill manifest per tool + index
```

## SQLite schema

Three tables:

- **`jobs`** — raw scraped data (title, company, description, classification, eligibility flags). One row per posting; `source` column tags it as `seek` / `linkedin` / `indeed`.
- **`applications`** — LLM-derived score + status. `status` lifecycle: `new → interested → applied → interview → rejected | offer | skip`.
- **`scan_runs`** — history of `seek-search` invocations (per keyword: jobs found, jobs new).

`data/applications.md` is generated from these tables and is **read-only** —
edit via `mark-job`, never by hand.

## Troubleshooting

- **"profile.md has changed since last distillation"** — run `career-ops distill-profile`.
- **SEEK selector drift** — selectors are in `src/tools/seek-search/index.ts` (top of file). Update there when SEEK churns.
- **CAPTCHA / anti-bot** — use lower `MAX_JOBS_PER_KEYWORD`, increase `SLOW_MO_MS`, or run with `HEADLESS=false` to inspect.
- **LLM returned non-JSON** — `src/shared/llm/client.ts` has retry + fence-stripping + balanced-object fallback. If it still fails, raise `--max-tokens` (the model may be truncating).
- **Rate-limited or down provider** — the fallback chain auto-engages on errors. To force a provider switch, change `LLM_PROVIDER` in `.env`. To run cheaply, use `LLM_MODEL=gpt-5.4-nano` or `LLM_PROVIDER=deepseek LLM_MODEL=deepseek-chat`.
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
