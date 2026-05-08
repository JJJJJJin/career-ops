# career-ops — Claude / openclaw entrypoint

This repo is a catalog of TypeScript tools for a SEEK-focused job pipeline
(scan, evaluate, tailor resume + cover letter, render PDFs).

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
- Per-job artefacts go to `output/<company-slug>-<role-slug>/`.
- Never auto-submit applications. Render artefacts; the human submits.
