---
name: render-cover-letter-pdf
description: Load output/<slug>/cover_letter.json, fill the cover-letter.html template, write cover_letter.pdf via Playwright. Cheap (no LLM). Use after generate-cover-letter, or after manually editing cover_letter.json.
---

# render-cover-letter-pdf

## When to use
- After `generate-cover-letter`
- After hand-editing `output/<slug>/cover_letter.json`
- Sub-step inside `apply-job`

Skip when:
- `cover_letter.json` doesn't exist yet → run `generate-cover-letter` first

## How to invoke
```
career-ops render-cover-letter-pdf <jobId> [--out <path>]
```

## Inputs
- `<jobId>` (required) — used to derive output path.
- `--out <path>` — override default `output/<slug>/cover_letter.pdf`.

## Outputs
- File: `output/<slug>/cover_letter.pdf` (A4, letterhead block + 3 paragraphs + signoff).

## Chaining
- Standalone after generate-cover-letter.
- `apply-job` runs this in parallel with `render-resume-pdf`.
