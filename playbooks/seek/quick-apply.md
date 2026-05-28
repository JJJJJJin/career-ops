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
**Dual check:** the tool checks **both our database** (`status === 'applied'` / `applyState ===
'submitted'`) AND the **live page** (for an "Applied" / "you've already applied" badge). If either
fires, `alreadyApplied: true` is returned — SKIP it, do not re-apply. The tool also writes an
application row (status `'new'`) for every job it opens, so external jobs appear in the tracker.
**Verify:** `step` is one of documents/questions/profile/review.
**If unexpected:**
- `alreadyApplied: true` (`step: "already_applied"`) → you already applied to this job (our
  DB records `status='applied'` / `applyState='submitted'`, or the page shows "Applied" where
  the apply button should be). SKIP it — do not re-apply.
- `external: true` / `step: "external"` → this job redirects to the employer's own site; do NOT
  drive the wizard. The tool has written an application row (`applyMethod='external'`,
  `applyState='external_pending'`) to the DB. Record `{ title, company, externalUrl }` for the
  user to apply manually (in a batch, add it to the `external[]` report).
- `step: "unknown"` → `browser_observe` + `browser_screenshot`. If you SEE an "Applied" badge /
  "you've already applied" (no apply button/wizard), treat it as already-applied and skip.
  Otherwise STOP, show the user, and propose a detection fix.

## choose documents
**Goal:** attach the tailored resume AND cover letter as PDFs (HR sees the filenames).
**You're here when:** `seek_apply_detect_step` → "documents".

**Resume-slot lifecycle (SEEK cap = 10):**

1. **Pre-batch (once, before the first job):** call `seek_resume_list`. Note `slotsFree`.
   - If `slotsFree == 0`: call `seek_resume_delete_old` immediately, then re-call
     `seek_resume_list` — you now have `cap - 1 = 9` free slots (the protected default
     takes one). Track `remainingSlots = slotsFree`.
   - If `slotsFree > 0`: track `remainingSlots = slotsFree`. Proceed.

2. **Before filling documents for each job:** if `remainingSlots == 0`, call
   `seek_resume_delete_old`, then re-call `seek_resume_list` and reset
   `remainingSlots = slotsFree`.

3. **Fill:** `seek_apply_fill_documents { jobId }` uploads the resume PDF.

4. **After a successful upload:** `remainingSlots = remainingSlots - 1`. If this
   reaches 0, the *next* job's pre-fill check will trigger cleanup (step 2).

Keep `remainingSlots` in the run-state `vars` so it survives across jobs within a batch.

**Verify uploaded files match on the review page:**

After reaching the review page, call `browser_observe` and check the filenames shown
for resume and cover letter. They MUST share the same base name — only the suffix differs
(e.g. `Jincheng_Deng-Software-Engineer-0452285117-resume.pdf` and
`Jincheng_Deng-Software-Engineer-0452285117-cover_letter.pdf`). If the base names differ,
the wrong resume was attached. In that case:
- **Abort this application** (do NOT submit — close the tab or navigate away).
- Call `seek_resume_delete_old` to purge all non-protected resumes.
- Re-call `seek_resume_list` and reset `remainingSlots = slotsFree`.
- Re-run `apply_job <jobId>` to regenerate fresh tailored PDFs.
- Re-apply from `seek_apply_open` for this same jobId.

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
has been sent" confirmation.

**Wait loop (MUST run until resolved):**
1. Call `seek_apply_wait_submitted { jobId }`.
2. **If `submitted: true`:** the job is recorded as applied. Run `run_note` with success.
   Then → proceed to the **next job**. (remainingSlots was already decremented at upload time; slot
   cleanup happens ONLY in **choose documents** pre-fill check, never here.)
3. **If `submitted: false` (timed out, ~45s):** the page may have changed. Call
   `seek_apply_detect_step`:
   - **Still `review`:** the user is still editing/reviewing. Tell the user to submit when ready
     and call `seek_apply_wait_submitted` AGAIN (go back to step 1). Keep waiting unless the user
     explicitly says skip.
   - **NOT `review` (any other stage / unknown):** the user navigated away — they chose NOT to
     submit this job. Do NOT mark it applied. Re-apply this same job: go back to
     **open the application** and re-drive the wizard from scratch. During re-apply, resume upload
     is idempotent (already on SEEK), so remainingSlots stays unchanged.

**Agent submit (only if authorized):** `seek_apply_submit { jobId, humanApproved: true }` after an
explicit per-job yes, or unattended only when `SEEK_ALLOW_SUBMIT=true`. Never set `humanApproved`
without a real yes. With no authority it parks at review (`filled_pending_review`).
Close the run with `run_end`.
