# Playbook: SEEK batch apply (CSV-driven)

Apply to a batch of jobs from a CSV. Each row is `company, title, url, score` (a header row may be
present — skip it). Route by **score** (threshold default **4** = the system's STRONG cutoff):

- **score < 4 → AUTO-APPLY** (drive quick-apply, stop at review; the user clicks Submit, auto-detected).
- **score ≥ 4 → GOOD FIT → SKIP entirely** (no apply, no draft, no generation). Just collect them and
  remind the user in the final summary to apply to these themselves, carefully.

Within the auto-apply (<4) set: only **quick-apply** jobs are driven; **external** (employer-site)
jobs are recorded for manual apply; **already-applied** and **eligibility-blocked** jobs are skipped.
Resume slots are managed by SEEK's real count so the 10-cap is never hit.

Preconditions: logged in (login playbook); protected default resume uploaded (`SEEK_PROTECTED_RESUME`).
Submission stays the user's — each <4 quick-apply stops at review.

Vars: `{{csv}}` (rows of company,title,url,score), `scoreThreshold` (default 4).

## begin the run
**Do:** parse the CSV into rows `{ company, title, url, score:number }` (skip a header row; parse
score as a number). `run_begin { workflow: "seek/batch-apply", goal, vars: { count } }`. Keep three
lists in your notes: `goodJobs[]` (score ≥ threshold), `external[]` (apply manually), and `skipped[]`
(already-applied / eligibility / errors). You do NOT count applications — slot management reads
SEEK's real count. Confirm login with `seek_login_status`.

## set aside the good jobs (score ≥ threshold)
**Goal:** good-fit jobs are the user's to apply by hand — SKIP them entirely here.
**Do:** for each row with `score >= scoreThreshold`: do NOTHING (no `apply_job`, no generation, no
wizard). Just add `{ company, title, url, score }` to `goodJobs[]` for the final report.
**Why:** the user applies these from scratch; generating drafts wastes LLM and isn't wanted — just
remind them in the summary.

## clean up resumes first (for the auto-apply set)
**Do:** `seek_resume_delete_old` (keeps only the protected default → 1/10).
**If unexpected:** `defaultFound: false` → STOP, tell the user to upload their default first.

## auto-apply each job with score < threshold
For each row with `score < scoreThreshold`, in order:
1. **Prep (reuse if present):** if the resume + cover PDFs already exist (and not applied), reuse;
   else `apply_job { jobIdOrUrl: url }` (idempotent — no LLM when cached, just re-renders PDFs).
2. **Slot check:** `seek_resume_list`; if `slotsFree == 0`, `seek_resume_delete_old` first.
3. **Open + route:** `seek_apply_open { jobId }` —
   - `alreadyApplied: true` → `skipped[]` (already applied). Next.
   - apply_job returned `skippedDueToEligibility` → `skipped[]` (eligibility). Next.
   - `external: true` → `external[]`. Next.
   - else (quick, not applied) → drive it.
4. **Drive (seek/quick-apply):** `seek_apply_fill_documents { jobId }` (uploads BOTH PDFs) →
   `seek_apply_advance` → `seek_apply_answer_questions` (ask the user for any unanswered; save to the
   guideline; retry) → advance past profile → **review: summarize → `seek_apply_wait_submitted { jobId }`**
   (the user clicks Submit; auto-detected → recorded applied; re-call while `submitted: false`; if the
   user says skip → `skipped[]`). `run_note` each job.
**Never** delete resumes mid-apply (between a job's upload and the user's submit) — only between jobs.

## final report
**Do:** `run_end`. Report, clearly separated:
- **✅ Submitted** — the <4 jobs the user submitted.
- **★ GOOD JOBS — apply to these yourself (score ≥ threshold)** — `goodJobs[]`: company, title,
  **clickable URL**, score. The agent skipped these on purpose; remind the user to apply by hand.
- **External — apply manually** — `external[]`: title, company, URL.
- **Skipped** — already-applied; eligibility-blocked (with reason); errors.
Make every URL copy-pasteable.
