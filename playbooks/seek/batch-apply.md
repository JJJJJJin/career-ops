# Playbook: SEEK batch apply (multi-tab)

Prepare several SEEK applications in one logged-in browser, **one tab per job**,
leaving each parked at its own review page so the user can go tab-by-tab and
click Submit. Resume-slot management runs on its own dedicated tab and never
disturbs an in-progress application. Drive each job with the **quick-apply**
playbook; this one is the multi-tab loop around it.

## Why multi-tab

All tabs share one browser context (one login). Each tab keeps its own
perception snapshot, so refs never cross between jobs. A job parked at review in
`apply:<jobId>` stays put while you prepare the next one in a fresh tab — and
while the `resume` tab deletes/uploads resumes. This is what lets the user
submit 10 prepared applications by visiting 10 tabs in turn.

## Preconditions

- Logged in (run **seek/login** first; verify with `seek_login_status`).
- The caller gives you a list of jobIds (or you query the DB for candidates).
- For each job, `apply_job <jobId>` has been run so the tailored resume +
  cover-letter PDFs exist on disk (the documents stage uploads them).

## Step 1 — Resolve the candidate list

Decide which jobs to apply to:
- If the user gave jobIds, use those in order.
- Otherwise query the tracker for STRONG matches not yet applied: call
  `query_jobs` (e.g. recommendation STRONG, status new) and take the top N the
  user asked for.

Confirm the final list with the user before driving the browser. Start a run
with `run_begin` (workflow "seek/batch-apply", vars `{ jobIds }`) so the batch
is resumable.

## Step 2 — Prepare the resume tab + cleanup slots

Call `seek_resume_delete_old` once at the start. It runs on the dedicated
`resume` tab (created automatically, not activated) and deletes every saved
resume except your protected default, so the rolling window has room. The
`resume` tab now stays open for the whole batch.

## Step 3 — For each job: open a tab and drive quick-apply to review

For each jobId, in order:

1. `tab_open` with `id: "apply:<jobId>"` and `label: "<company> — <role>"`.
   This opens a fresh tab and makes it active. (Re-running with the same id
   reuses the tab — safe for resumes.)
2. Drive the **seek/quick-apply** playbook on this now-active tab:
   `seek_apply_open <jobId>` → documents → questions → review. The
   `seek_apply_*` tools act on the active tab, so no `tab` argument is needed —
   just make sure this job's tab is active (it is, right after `tab_open`).
3. If `seek_apply_open` reports `already_applied`, `tab_close` this tab and skip.
   If it reports `external`, record it for manual handling, `tab_close`, skip.
4. **STOP at review. Do NOT submit. Do NOT close the tab** — leave it parked so
   the user can submit it later.
5. `run_note` the outcome for this job (parked at review / skipped / errored).

Resume rotation (`seek_resume_rotate`, called inside quick-apply) runs on the
`resume` tab, so it never navigates the apply tab you just filled.

If a job errors twice on the same step, STOP and tell the user; leave its tab
open on the failing page so they can see it, and move on to the next job only
with their go-ahead.

## Step 4 — Hand off for submission

When every job is prepared, call `tab_list` and show the user the parked tabs:
each `apply:<jobId>` tab sitting at its review page. Tell them: review each tab
and click Submit yourself (submission stays human-gated).

For each tab the user submits, confirm with `seek_apply_wait_submitted <jobId>`
(it detects the real success page and records the job as applied), then
`tab_close` that tab. If the user authorized unattended submit for a specific
job, you may `seek_apply_submit` with `humanApproved:true` on that job's active
tab instead — never otherwise.

## Step 5 — Close out

When all tabs are resolved, summarise: how many reached review, how many were
submitted, how many skipped/errored. Render the tracker if useful
(`render_tracker`), then `run_end`. You may leave the `resume` tab open for the
next batch or `tab_close` it.
