---
name: generate-cover-letter
description: Generate a tailored 3-paragraph cover letter for one job (under 250 words). Cliché blocklist enforced ("passionate self-starter", etc.). Outputs structured JSON + markdown to output/<slug>/. Use after evaluate-job returns STRONG / BORDERLINE.
---

# generate-cover-letter

## When to use
- User asks to "write a cover letter", "draft a CL"
- Sub-step inside `apply-job`

Skip when:
- The user wants the resume too → `apply-job` does both in parallel, much cheaper than two sequential LLM calls

## How to invoke
```
career-ops generate-cover-letter <jobId> [--force]
```

## Inputs
- `<jobId>` (required) — job must be in DB.
- `--force` — regenerate even if cached.

## Outputs
- File: `output/<slug>/cover_letter.json` (TailoredCoverLetter).
- File: `output/<slug>/cover_letter.md` (markdown view).
- DB: `applications.cover_letter_md`, `output_dir`, `generated_at`, `model`.

## Format constraints (enforced via system prompt)
- Para 1: why this role — concrete reference to JD content.
- Para 2: top 1-2 strengths from match analysis with cited profile evidence.
- Para 3: closing — what excites them + ask for the conversation.
- Total ~250 words max.
- No clichés ("passionate self-starter", "team player", "results-driven").

## Chaining
- Always followed by `render-cover-letter-pdf <jobId>` for the submittable PDF.
- `apply-job` chains both automatically.
