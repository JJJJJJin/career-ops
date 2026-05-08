---
name: render-resume-pdf
description: Load output/<slug>/resume.json, fill the resume.html template, write resume.pdf via Playwright. Cheap (no LLM). Use after generate-resume, or after manually editing resume.json. Requires generate-resume to have run first.
---

# render-resume-pdf

## When to use
- After `generate-resume` (the user wants the deliverable PDF)
- After hand-editing `output/<slug>/resume.json` (re-render without an LLM call)
- Sub-step inside `apply-job`

Skip when:
- `output/<slug>/resume.json` doesn't exist yet → run `generate-resume` first

## How to invoke
```
career-ops render-resume-pdf <jobId> [--out <path>]
```

## Inputs
- `<jobId>` (required) — used to derive `output/<company-slug>-<role-slug>/`.
- `--out <path>` — override output path (default `output/<slug>/resume.pdf`).

## Outputs
- File: `output/<slug>/resume.pdf` (A4, 12mm margins, Space Grotesk + DM Sans).

## Chaining
- Standalone after generate-resume.
- `apply-job` runs this in parallel with `render-cover-letter-pdf`.
