# career-ops — Claude / openclaw entrypoint

This repo is a catalog of TypeScript tools for a multi-source job pipeline
(SEEK, LinkedIn, Indeed) — scan, evaluate, tailor resume + cover letter,
render PDFs.

## For openclaw / Claude Code

The skills live in `openclaw/`. Install them once:

```bash
./scripts/install-skills.sh
```

Each tool has its own `openclaw/<name>/SKILL.md` describing when to invoke it
and what flags to pass. The agent picks the right skill from the user's
natural-language ask.

The two main entry points:
- `evaluate-job <url>` — score a job (fit + eligibility + recommendation)
- `apply-job <url>` — full pipeline: evaluate + generate resume/cover/brief + render PDFs

For a full tool catalog and architecture see `README.md`.

## MCP server (stateful, agent-driven)

The same toolset is also exposed over **MCP** (`src/mcp/`). Here the local agent
(this Claude) is the reasoner: it observes the live page with `browser_observe`,
decides one atomic action, and the **server holds the live browser session +
run-state across the whole conversation** — so it can keep a logged-in session
open while it asks you for a captcha / emailed code.

- Run the daemon: `npm run mcp-serve` (default; localhost Streamable-HTTP) — or
  `npm run mcp-stdio`. Built bins: `career-ops-mcp` / `career-ops-mcp-stdio`.
- Register: `claude mcp add --transport http career-ops http://127.0.0.1:8731/mcp`.
- Tools: atomic `browser_*`, SEEK semantic `seek_*`, the full search/evaluate/
  generate/render/track catalog, `run_*` (durable progress), `workflow_*`
  (read + self-correct playbooks).
- **Playbooks** live in `playbooks/` (Markdown step-by-step guidelines + the shared
  `_contract.md`). Read one with `workflow_get`. When a step breaks, the agent
  proposes a fix (`workflow_propose_fix`), shows you the diff, and writes it only
  on your yes (`workflow_apply_fix`).
- Submission stays **double-gated**: `seek_apply_submit` clicks only with an explicit
  per-job `humanApproved:true` or `SEEK_ALLOW_SUBMIT=true`. Default = stop at review.
- The legacy agent engine (`src/shared/agent/{flow,resolver,cache}.ts` + the
  `run-flow`/`seek-login`/`seek-apply` CLIs) still works, but its internal-LLM
  resolver is **superseded** by this agent-driven MCP path.

## For humans

```bash
npm install
npx playwright install chromium
cp .env.example .env       # set OPENAI_API_KEY (or DEEPSEEK_API_KEY)
./scripts/install-skills.sh
npm run career-ops -- --help
```

## Important conventions

- `profile/profile.md` is the user's CV (free-form markdown, gitignored).
  Use `distill-profile` to convert it to `profile/profile.json` (structured).
- `data/seek.sqlite3` is the source of truth. `data/applications.md` is a
  generated read-only view — never hand-edit.
- Per-job artefacts go to `output/<source>/<company-slug>-<role-slug>/`
  (the `<source>` segment is `seek` / `linkedin` / `indeed` so you can
  navigate by platform at a glance).
- Never auto-submit applications. Render artefacts; the human submits.
