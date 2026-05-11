---
name: render-company-brief-pdf
description: Load output/<slug>/company_brief.json, fill the company-brief.html template, write company_brief.pdf via Playwright. Cheap (no LLM). Use after generate-company-brief, or after hand-editing company_brief.json. Requires generate-company-brief to have run first.
---

# render-company-brief-pdf

## When to use
- After `generate-company-brief` (the user wants the printable brief)
- After hand-editing `output/<slug>/company_brief.json`
- Sub-step inside `apply-job` (runs in parallel with resume + cover letter PDF rendering)

Skip when:
- `output/<slug>/company_brief.json` doesn't exist yet → run `generate-company-brief` first

## How to invoke
```
career-ops render-company-brief-pdf <jobId> [--out <path>]
```

## Inputs
- `<jobId>` (required) — used to derive `output/<company-slug>-<role-slug>/`.
- `--out <path>` — override output path (default `output/<slug>/company_brief.pdf`).

## Outputs
- File: `output/<slug>/company_brief.pdf` (A4, 12mm margins, Space Grotesk + DM Sans).

## Chaining
- Standalone after generate-company-brief.
- `apply-job` runs this in parallel with `render-resume-pdf` and `render-cover-letter-pdf`.
