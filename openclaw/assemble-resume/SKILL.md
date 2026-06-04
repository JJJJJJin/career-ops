---
name: assemble-resume
description: Assemble a job-tailored résumé by deterministically SELECTING and ordering pre-vetted bullets from the content library (profile/profile_v3.md) — never generating new claims. Picks the summary variant by archetype (classify-jd), orders bullets by the JD's emphasis, aligns vocabulary via the library's synonym map, and validates that every output line traces back to the library before writing. Outputs structured JSON + a markdown view to output/<source>/<company-slug>-<role-slug>/. This replaces the removed generate-resume (LLM) tool.
---

# assemble-resume

## When to use
- After `evaluate-job` / `go-no-go` clears a job and the user wants the résumé artefact
- User asks "tailor my resume for this job", "make me a resume", "write a CV"
- Sub-step inside `apply-job`

Skip when:
- Eligibility flags are non-empty or `go-no-go` returns `low-yield` — resolve first.
- The user just wants the score → `evaluate-job` only.

## How to invoke
```
career-ops assemble-resume <jobId> [--force]
```

## Inputs
- `<jobId>` (required) — job must be in DB. Auto-summarizes + classifies if needed.
- `--force` — re-assemble even if artefacts already exist.

## Outputs
(`<slug>` = `<company-slug>-<role-slug>`.)
- `output/<source>/<slug>/<slug>-resume.json` (structured TailoredResume)
- `output/<source>/<slug>/<slug>-resume.md` (markdown view)
- `output/<source>/<slug>/<slug>-match-report.json` (archetype, selected bullets, unmet requirements, synonym swaps)
- DB: `applications.resume_md`, `output_dir`, `generated_at`, `profile_hash` (= library hash).

## Guarantees (the point of the design)
- **Content is selected, never generated.** No LLM writes résumé bullets or the summary.
- **Traceability invariant:** every output line must trace back verbatim to `profile_v3.md` (modulo allowed synonym swaps); titles/seniority are never changed. If any line fails, the run errors — it does not emit a résumé.
- To change résumé content, edit `profile/profile_v3.md`, then `career-ops parse-library` to validate.

## Chaining
- Always followed by `render-resume-pdf <jobId>` to produce the submitted PDF.
- `apply-job` chains both automatically (and records gaps + the go/no-go decision).
