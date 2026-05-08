---
name: apply-job
description: ⭐ Single-job full pipeline — evaluate + generate (resume + cover letter + company brief in parallel) + render PDFs. The deliverable bundle the user actually submits with. Use after the user says "apply", "yes go ahead", or pastes a URL with "give me everything for this".
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
career-ops apply-job <jobIdOrUrl> [--force] [--reextract] [--skip-brief] [--skip-pdf] [--company-website <url>]
```

## Inputs
- `<jobIdOrUrl>` (required) — full SEEK URL (auto-extracted) or numeric jobId.
- `--force` — regenerate everything even if cached.
- `--reextract` — re-fetch the job from SEEK before evaluating.
- `--skip-brief` — skip company brief (saves one LLM call).
- `--skip-pdf` — skip PDF rendering (markdown only — fastest iteration).
- `--company-website <url>` — passed through to generate-company-brief for grounding.

## Outputs (per-job folder under output/<company-slug>-<role-slug>/)
- `resume.json` + `resume.md` + `resume.pdf`
- `cover_letter.json` + `cover_letter.md` + `cover_letter.pdf`
- `company_brief.json` + `company_brief.md`
- DB: full population of `applications` row.
- File: `data/applications.md` regenerated.

## Behavior under eligibility blockers
- If `flag-eligibility` fires, this tool aborts BEFORE any LLM generation. The application row is written with `recommendation = NOT_FOR_YOU` and the user is told to inspect the flags.

## Submission policy
- This tool **never** auto-submits. Artefacts are produced for the user to review and submit themselves. Always pause and let the user act on the output.

## Token cost (per run, no cached state)
- ~5 LLM calls: summarize + match + resume + cover letter + brief.
- ~2 PDF render calls (no LLM, just Playwright).
- With `--skip-brief`: 4 LLM calls.
