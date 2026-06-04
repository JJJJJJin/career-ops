# career-ops — agent entrypoint

A multi-source job-search pipeline (SEEK, LinkedIn, Indeed, Built In) — scan,
evaluate, tailor résumé + cover letter, render PDFs, track applications.

## One core, two ways to run it

The reusable core is `src/` — pure functions in `src/tools/*/index.ts` and
`src/workflows/*.ts`, plus shared infra in `src/shared/*`. Nothing duplicated:
both entry points below call the SAME core.

1. **Offline scripts** — `scripts/`. Any agent can run every capability without a
   server:
   ```bash
   npx tsx scripts/career-ops.ts <command> [args]
   npm run career-ops -- <command> [args]
   ```
   `scripts/career-ops.ts` is the dispatcher; each command is a thin
   `scripts/cmd/<command>.ts` that parses args, calls the `src/` core, and prints.
   To learn a command: run it with no args (prints usage), or read its
   `scripts/cmd/<command>.ts` + the `src/` function it imports.

2. **MCP server** — `src/mcp/`. Stateful, agent-driven: the server holds a live
   browser session + run-state across the conversation, so the agent observes the
   page (`browser_observe`), decides one atomic action, and can keep a logged-in
   session open while asking you for a captcha / emailed code.
   ```bash
   npm run mcp-serve            # localhost Streamable-HTTP (or: npm run mcp-stdio)
   claude mcp add --transport http career-ops http://127.0.0.1:8731/mcp
   ```
   Tools: atomic `browser_*`, SEEK `seek_*`, the full search/evaluate/generate/
   render/track catalog (mirrors the scripts), `run_*` (durable progress),
   `workflow_*` (read + self-correct playbooks in `playbooks/`).

The two main flows (either mode): `evaluate-job <url>` (score) and
`apply-job <url>` (evaluate → assemble résumé + cover/brief → render PDFs).

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env       # set an LLM key + TRACKER_DATABASE_URL (optional)
npm run career-ops -- --help
```

## Important conventions

- `profile/profile_v3.md` is the **content library** — the single source of truth
  for résumé content. Résumés are ASSEMBLED, not generated: `assemble-resume`
  deterministically SELECTS pre-vetted, tagged bullets per JD (archetype via
  `classify-jd`), aligns vocabulary via the synonym map, and a traceability
  invariant (`src/shared/library/traceability.ts`) fails the run if any output
  line doesn't trace back to the library. Edit the résumé by editing
  `profile_v3.md`; validate with `career-ops parse-library`. The LLM only does JD
  parsing/classification, cover-letter/outreach drafting (each grounded +
  claim-checked in `src/shared/grounding/`), and scoring — never résumé content.
- `data/seek.sqlite3` holds the heavy local pipeline data (JD text, summaries,
  artefacts). `data/applications.md` is a generated read-only view — never hand-edit.
- `profile/profile_v3.md`, the optional Postgres **tracker** (`src/shared/tracker/`,
  dedup + status across machines), and local SQLite are the three stores. The
  tracker queues writes to `data/tracker-outbox.jsonl` when offline and syncs via
  `career-ops tracker-sync`.
- Per-job artefacts go to `output/<source>/<company-slug>-<role-slug>/`.
- **Never auto-submit applications and never email anyone but yourself.** SEEK
  submission is double-gated (`seek_apply_submit` needs `humanApproved:true` or
  `SEEK_ALLOW_SUBMIT=true`; default stops at the review page). Outreach drafts go
  to a review queue and are never sent.
