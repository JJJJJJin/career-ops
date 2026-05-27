# Playbook: SEEK batch apply

Apply to a LIST of job URLs in one go. Only **quick-apply** jobs are driven by the agent;
**external** jobs (those that redirect to the employer's own site) are recorded and reported
at the end for the user to apply by hand. Resume slots are managed so SEEK's 10-resume cap is
never hit mid-run.

Preconditions: logged in (run the login playbook first if needed) and the user's protected
default resume is uploaded (`SEEK_PROTECTED_RESUME`, e.g. `resume_default`). Submission is the
user's: each quick-apply stops at the review page for the user to submit manually.

Vars: `{{urls}}` (the list), `cleanupEvery` (from `seek_resume_list`, default 9 = cap 10 − 1
protected default).

## begin the run
**Goal:** durable bookkeeping for a resumable batch.
**Do:** `run_begin { workflow: "seek/batch-apply", goal, vars: { urls } }`. Keep two tallies in
your notes: `appliedSinceCleanup` (quick-applies since the last cleanup) and an `external[]`
list (jobs to report at the end). Confirm login with `seek_login_status`.

## clean up resumes first
**Goal:** start with empty slots so uploads never hit the cap.
**Do:** `seek_resume_delete_old` (keeps only the protected default → 1/10, 9 free). Read
`cleanupEvery` from `seek_resume_list` for the cadence below.
**If unexpected:** `defaultFound: false` → the default isn't uploaded; STOP and tell the user
to upload it before batch-applying (otherwise cleanup wipes everything).

## prepare + route each URL
For each URL, in order:
1. **Prep (reuse if already generated):** if the job already has its resume + cover-letter PDFs
   from a prior run (and isn't applied yet), DON'T regenerate — reuse them. Otherwise
   `apply_job { jobIdOrUrl: url }`. `apply_job` is idempotent: it reuses cached evaluate/summary/
   match (DB) and the generated resume/cover/brief (files), re-running NO LLM when they exist — it
   only re-renders PDFs. So calling it again is safe, just unnecessary when the PDFs are present.
2. **Route by outcome — only un-applied quick-apply jobs are driven:**
   - **Already applied** → `seek_apply_open` returns `alreadyApplied: true` (via `db` = our records
     show it applied/submitted; or via `page` = the wizard isn't shown and the page reads "Applied"
     where the apply button should be). Record it as skipped (already applied). Continue.
   - `skippedDueToEligibility: true` (NOT_FOR_YOU) → record it as skipped (reason: eligibility);
     do NOT apply. Continue.
   - **External apply** → `seek_apply_open` returns `external: true` (or check `show_job` →
     `applyType: "external"`). Do NOT drive the wizard. Add `{ title, company, url/externalUrl }`
     to your `external[]` list. Continue.
   - **Quick apply** (`applyType: "quick"`, `alreadyApplied: false`) → drive it (next step).
**Why:** the agent can only complete quick-apply in-page; external forms live on the employer's
site and must be done by the human.

## drive one quick-apply
**Goal:** fill + reach review for a quick-apply job, then hand off to the user.
**Do:** follow the **seek/quick-apply** playbook: `seek_apply_open { jobId }` →
`seek_apply_fill_documents { jobId }` (uploads BOTH PDFs) → `seek_apply_advance` →
`seek_apply_answer_questions` (ask the user for any unanswered) → advance past profile →
**review: STOP, summarize, let the user submit in the window** → on their "done",
`mark_job { jobId, status: "applied" }`. Increment `appliedSinceCleanup`. `run_note` each job.

## clean up every N applications
**Goal:** free slots before the cap is hit. Each quick-apply UPLOADED a resume (counts toward
the cap even though the user submits manually — the upload happens at the documents stage).
**Do:** when `appliedSinceCleanup` reaches `cleanupEvery` (default 9), run `seek_resume_delete_old`
(by now the user has submitted those jobs, so deleting their saved resumes is safe), then reset
`appliedSinceCleanup` to 0. As a safety check you may also read `seek_resume_list.slotsFree` and
clean up early if it hits 0.
**If unexpected:** never delete mid-apply (between a job's documents upload and the user's submit);
only clean up between jobs.

## final report
**Goal:** tell the user exactly what happened and what they must do by hand.
**Do:** `run_end`. Report a summary:
- **Submitted / parked at review** (quick-apply jobs the user acted on).
- **External — apply manually**: the `external[]` list with each title, company, and the URL.
- **Skipped**: eligibility-blocked (with the reason) and any errors.
Make the external list copy-pasteable so the user can open each and apply themselves.
