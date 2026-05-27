# Playbook: search & triage

Find jobs and decide what's worth applying to. This is mostly the stateless catalog tools —
no live browser session needed (the search/extract tools use their own transient fetches).

Vars: `{{keywords}}`, `{{source}}` (seek/linkedin/indeed/builtin).

## scan a board
**Goal:** pull recent postings into the DB.
**Do:** `job_search { source, keywords }` (optionally `location`, `days`).
**Verify:** the result lists jobs with `isNew` flags. New jobs are worth evaluating.

## evaluate the promising ones
**Goal:** score fit + eligibility so the user sees STRONG matches.
**Do:** for each job of interest, `evaluate_job { jobIdOrUrl }`. It short-circuits on
eligibility blocks (NOT_FOR_YOU) before spending LLM calls.
**Verify:** each returns a recommendation (STRONG/BORDERLINE/SKIP/NOT_FOR_YOU) and score.
**If unexpected:** extraction failure → try `job_extract` directly and report the error.

## present and triage
**Goal:** give the user a ranked shortlist and capture decisions.
**Do:** summarize the STRONG/eligible matches. Use `query_jobs` (filters) / `job_stats` to
frame the pipeline. When the user decides, `mark_job { jobId, status }`
(interested/applied/skip) and `render_tracker` to refresh data/applications.md.
**Next:** for jobs to apply to, run `apply_job` to generate artefacts, then the quick-apply
playbook.
