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
**Goal:** load the wizard and learn the starting stage.
**Do:** `seek_apply_open { jobId }`. Read the returned `step`.
**Verify:** `step` is one of documents/questions/profile/review.
**If unexpected:** `step: "unknown"` → `browser_observe` + `browser_screenshot`, STOP, show the
user, and propose a detection fix. If it's not a quick-apply (external apply), STOP and tell
the user to apply on the employer site.

## make sure the resume is uploaded
**Goal:** the tailored resume must be selectable in the documents dropdown.
**Do:** if you're unsure it's uploaded, `seek_resume_list`; if `{{resumeFilename}}` isn't
listed, `seek_resume_rotate { pdfPath }` (it deletes the oldest non-default resume when the
list of 10 is full, then uploads). It's idempotent.
**Verify:** the filename appears in `seek_resume_list`.

## choose documents
**Goal:** select the tailored resume and paste the cover letter.
**You're here when:** `seek_apply_detect_step` → "documents".
**Do:** `seek_apply_fill_documents { resumeFilename, coverLetterText }` (omit coverLetterText
to skip the cover letter). Then `seek_apply_advance`.
**Verify:** advance returns the next stage (questions / profile / review).
**If unexpected:** if fill reports the resume isn't in the dropdown, go back to "make sure the
resume is uploaded". If the radios don't respond, drop to atomic tools: observe, then
`browser_click` the option's *label*.

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

## submit (gated)
**Goal:** submit ONLY with authority.
**Default:** do nothing — leave the filled application on the review page and tell the user it's
ready. Record `apply_state: filled_pending_review` by calling `seek_apply_submit { jobId }`
(with no `humanApproved`), which refuses to submit and parks it.
**With the user's explicit yes for THIS job:** `seek_apply_submit { jobId, humanApproved: true }`.
**Unattended:** only when `SEEK_ALLOW_SUBMIT=true` is configured.
**Never** set `humanApproved: true` without an actual user yes. Close the run with `run_end`.
