---
name: apply-job
description: ⭐ Single-job full pipeline — evaluate + generate (resume + cover letter + company brief in parallel) + render PDFs (all three) + email the PDF bundle to the user's inbox. The deliverable bundle the user actually submits with. Use after the user says "apply", "yes go ahead", or pastes a URL with "give me everything for this".
---

# apply-job

## When to use
- After `evaluate-job` returns STRONG and the user agrees to apply
- Direct ask: "apply to this job", "tailor everything for <jobId>", "make me the bundle"
- Most efficient way to get all three artefacts (parallel calls share one prompt cache)

Skip when:
- The user only wants the verdict → `evaluate-job`
- The user only wants ONE artefact → `generate-resume` / `generate-cover-letter` / `generate-company-brief`
- Eligibility is already known to fail → don't waste time

## How to invoke
```
career-ops apply-job <jobIdOrUrl> [--force] [--reextract] [--skip-brief] [--skip-pdf] [--company-website <url>] [--email | --no-email] [--email-to <addr>]
```

## Inputs
- `<jobIdOrUrl>` (required) — full SEEK / LinkedIn / Indeed URL (auto-detected & extracted) or stored jobId (numeric for SEEK, `linkedin:<id>`, `indeed:<jk>`).
- `--force` — regenerate everything even if cached.
- `--reextract` — re-fetch the job from SEEK before evaluating.
- `--skip-brief` — skip company brief (saves one LLM call).
- `--skip-pdf` — skip PDF rendering (markdown only — fastest iteration).
- `--company-website <url>` — passed through to generate-company-brief for grounding.
- `--email` / `--no-email` — force email delivery on/off (default: on when `.env` is configured).
- `--email-to <addr>` — override the recipient (default: `$EMAIL_TO`).

## Outputs (per-job folder under output/<source>/<slug>/ where slug = `<company-slug>-<role-slug>`)
The folder is namespaced by source platform so SEEK / LinkedIn / Indeed runs stay separate (e.g. `output/seek/acme-backend-engineer/`, `output/indeed/acme-backend-engineer/`). All artefact files are prefixed with the slug so they stay self-describing when copied out of the folder.
- `<slug>-resume.json` + `<slug>-resume.md` + `<slug>-resume.pdf`
- `<slug>-cover_letter.json` + `<slug>-cover_letter.md` + `<slug>-cover_letter.pdf`
- `<slug>-company_brief.json` + `<slug>-company_brief.md` + `<slug>-company_brief.pdf`
- DB: full population of `applications` row.
- File: `data/applications.md` regenerated.
- Email: when configured, all three PDFs are sent to `$EMAIL_TO` as attachments.

## Behavior under eligibility blockers
- If `flag-eligibility` fires, this tool aborts BEFORE any LLM generation. The application row is written with `recommendation = NOT_FOR_YOU` and the user is told to inspect the flags.

## Submission policy
- This tool **never** auto-submits. Artefacts are produced for the user to review and submit themselves. Always pause and let the user act on the output.

## Token cost (per run, no cached state)
- ~5 LLM calls: summarize + match + resume + cover letter + brief.
- ~3 PDF render calls (no LLM, just Playwright): resume, cover letter, company brief.
- With `--skip-brief`: 4 LLM calls and 2 PDFs.

## Email delivery
- Requires `EMAIL_USER`, `EMAIL_APP_PASSWORD`, and `EMAIL_TO` in `.env`. Gmail needs an App Password (not your normal password).
- Auto-fires once generation finishes. Subject includes company + role + fit score. The three PDFs are attached.
- Failure is non-fatal — the artefacts still land on disk and the tracker still updates.
- For ad-hoc file delivery to a group chat via webhook (separate from email), use `send-files`.
