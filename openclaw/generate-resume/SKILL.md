---
name: generate-resume
description: Generate a tailored resume for one job — variant-aware (picks the closest project framing from profile.md without blending), one-page, ATS-friendly. Outputs structured JSON + a markdown view to output/<company-slug>-<role-slug>/. Use after the user decides to apply (recommendation STRONG, or BORDERLINE override).
---

# generate-resume

## When to use
- After `evaluate-job` returns STRONG and the user wants the artefact
- User asks "tailor my resume for this job", "make me a resume", "write a CV"
- Sub-step inside `apply-job`

Skip when:
- The eligibility flags are non-empty — applying is wasted effort. Resolve eligibility first.
- The user just wants the score → `evaluate-job` only.

## How to invoke
```
career-ops generate-resume <jobId> [--force]
```

## Inputs
- `<jobId>` (required) — job must be in DB. Auto-summarizes / matches / distills profile if needed.
- `--force` — regenerate even if `output/<slug>/<slug>-resume.json` already exists.

## Outputs
(`<slug>` = `<company-slug>-<role-slug>`; artefact filenames are prefixed with it.)
- File: `output/<slug>/<slug>-resume.json` (structured TailoredResume).
- File: `output/<slug>/<slug>-resume.md` (deterministic markdown view of the JSON).
- DB: `applications.resume_md`, `output_dir`, `generated_at`, `model`, `profile_hash`.

## Chaining
- Always followed by `render-resume-pdf <jobId>` to produce the PDF the user actually submits.
- `apply-job` chains both automatically.

## Variant-aware project framing
- If `profile.md` contains multiple `#### Variant — <focus>` blocks under one project, the LLM picks the variant whose framing best matches the JOB SUMMARY's domain (backend / AI / data / embedded / etc.) and uses **that** variant's intro paragraph and highlights — without blending phrasing across variants.
- It may add 1-2 highlights from another variant if those highlights directly address requirements the chosen variant doesn't cover, but it never paraphrases or merges variants.
