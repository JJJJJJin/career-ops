# Playbook: SEEK quick-apply

Drive a SEEK "Quick apply" wizard for one job to (by default) the review page, filling the
resume, cover letter and employer questions — then STOP. Submission is separately gated.

Wizard stages: **documents → employer questions → SEEK profile → review → (submit)**. Use
the `seek_apply_*` tools for the stages (they reuse stable hooks); call `seek_apply_detect_step`
between stages and reason about what you see — the order can vary and stages can be absent.

Preconditions: you are logged in (run the login playbook first) and the tailored artefacts
exist (`apply_job <jobId>` has produced the resume PDF + cover_letter.json). Start a run with
`run_begin { workflow: "seek/quick-apply", goal, vars: { jobId } }`.

Vars: `{{jobId}}`, `{{resumeFilename}}` (basename of the tailored resume PDF), `{{coverLetterText}}`.

## open the application
**Goal:** load the wizard and learn the starting stage — only for quick-apply jobs.
**Do:** `seek_apply_open { jobId }`. Read the returned `step`.
**Verify:** `step` is one of documents/questions/profile/review.
**If unexpected:**
- `alreadyApplied: true` (`step: "already_applied"`) → you already applied to this job (our
  records, or the page shows "Applied" where the apply button should be). SKIP it — do not re-apply.
- `external: true` / `step: "external"` → this job redirects to the employer's own site; do NOT
  drive the wizard. Record `{ title, company, externalUrl }` for the user to apply manually (in a
  batch, add it to the `external[]` report).
- `step: "unknown"` → `browser_observe` + `browser_screenshot`. If you SEE an "Applied" badge /
  "you've already applied" (no apply button/wizard), treat it as already-applied and skip.
  Otherwise STOP, show the user, and propose a detection fix.

## choose documents
**Goal:** attach the tailored resume AND cover letter as PDFs (HR sees the filenames).
**You're here when:** `seek_apply_detect_step` → "documents".
**Do:** `seek_apply_fill_documents { jobId }` — by default it UPLOADS both PDFs resolved from
`output/seek/<dir>/<base>-resume.pdf` and `-cover_letter.pdf` (the files `apply_job` generated).
No `seek_resume_rotate` needed — uploading per-application avoids SEEK's 10-resume cap entirely.
Then `seek_apply_advance`.
**Verify:** advance returns the next stage (questions / profile / review). The page shows
"… attached" under each section.
**If unexpected:** if a PDF path is missing, run `apply_job <jobId>` first. The documents UI
uses custom radios (Upload / Select / Write / Don't include) that `browser_observe` can't see —
do NOT try to click them atomically; the tool handles them by label text + the stable file
inputs `#resume-fileFile` / `#coverLetter-fileFile`. Fallbacks: `resume:"select"` +
`resumeFilename` (pick a SEEK-saved resume), or `coverLetter:"write"` + `coverLetterText`.

## answer employer questions
**Goal:** answer every employer question from the user's guideline — never guess.
**You're here when:** stage is "questions".
**Do:** `seek_apply_answer_questions`. It fills only from `profile/seek-answers.md` and accepts
SEEK-prefilled choices.
**If it returns `needs_human_input`:** some questions have no saved answer. For each, ask the
user; once they answer, add it to the guideline file (heading `## <qid> — <text>`, line
`answer: <value>`; for choice questions use one of the listed options) — propose this via the
workflow-fix flow if you want their confirmation — then call `seek_apply_answer_questions`
again. Repeat until `allAnswered: true`. Do NOT submit with unanswered questions.
**Then:** `seek_apply_advance`. Record answers with `run_note`.

## SEEK profile step
**Goal:** pass the "Update SEEK Profile" stage without modifying the profile.
**You're here when:** stage is "profile".
**Do:** just `seek_apply_advance` (Continue). Do NOT click "Add to Profile" / add anything.

## review
**Goal:** let the user verify before anything is sent.
**You're here when:** stage is "review".
**Do:** `browser_observe` (and `browser_screenshot` if helpful) and summarize back to the user:
which resume, the cover letter, and every employer answer. Note "You answered N out of N".
**Verify:** all stages were completed; nothing is missing.

## submit
**Goal:** submit with authority. Default is the user submitting MANUALLY, auto-detected.
**Manual submit (default / preferred):** tell the user to click "Submit application" in the window
themselves, then call `seek_apply_wait_submitted { jobId }`. It polls for SEEK's "Your application
has been sent" confirmation; the instant the user submits, it records the job applied and returns
`submitted: true` → proceed to the next job. If it returns `submitted: false` (bounded ~45s), the
user is still reviewing/editing (that never false-triggers) — call it AGAIN to keep waiting, unless
they said skip. You never click submit in this mode.
**Agent submit (only if authorized):** `seek_apply_submit { jobId, humanApproved: true }` after an
explicit per-job yes, or unattended only when `SEEK_ALLOW_SUBMIT=true`. Never set `humanApproved`
without a real yes. With no authority it parks at review (`filled_pending_review`).
Close the run with `run_end`.
