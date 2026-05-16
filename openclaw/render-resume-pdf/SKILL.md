---
name: render-resume-pdf
description: Load output/<source>/<slug>/<slug>-resume.json, fill the resume.html template, write <slug>-resume.pdf via Playwright. Cheap (no LLM). Use after generate-resume, or after manually editing the resume JSON. Requires generate-resume to have run first.
---

# render-resume-pdf

## When to use
- After `generate-resume` (the user wants the deliverable PDF)
- After hand-editing `output/<source>/<slug>/<slug>-resume.json` (re-render without an LLM call)
- Sub-step inside `apply-job`

Skip when:
- `output/<source>/<slug>/<slug>-resume.json` doesn't exist yet → run `generate-resume` first

## How to invoke
```
career-ops render-resume-pdf <jobId> [--out <path>]
```

## Inputs
- `<jobId>` (required) — used to derive `output/<source>/<slug>/` where `<slug>` = `<company-slug>-<role-slug>`. Artefact filenames are prefixed with the slug.
- `--out <path>` — override output path (default `output/<source>/<slug>/<slug>-resume.pdf`).

## Outputs
- File: `output/<source>/<slug>/<slug>-resume.pdf` (A4, 12mm margins, Space Grotesk + DM Sans).

## Chaining
- Standalone after generate-resume.
- `apply-job` runs this in parallel with `render-cover-letter-pdf`.
