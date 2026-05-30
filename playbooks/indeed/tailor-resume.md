# Playbook: Indeed — search, extract a JD, tailor a resume

Indeed is **read-only** here. Goal: find jobs on Indeed, pull a job's full description
through the live browser, then generate a tailored resume. There is **NO auto-apply** for
Indeed (unlike SEEK) — never drive an apply wizard or submit anything. You stop at
"resume (and optionally cover letter) generated".

Why a live browser: Indeed sits behind Cloudflare, which fingerprints the **browser**, not
the cursor. A cold/throwaway fetch is challenged ("Additional Verification Required"); the
MCP browser is hardened (real Chrome + stealth) so it loads like a normal incognito Chrome.
Always work through the live session — a bare HTTP fetch will not get past.

Preconditions: `profile/profile.json` exists (`distill_profile` once if not). No login
needed — Indeed search + JD viewing are public. Vars: `{{keywords}}`, `{{location}}`
(optional), or a direct `{{jobUrl}}` / `{{jk}}`.

## open the live browser
**Goal:** a watchable session that can hand off to the human on a verification wall.
**Do:** `session_open { headless: false }`. Ephemeral context (incognito-like) is the
default and is correct for Indeed.
**Verify:** `open: true`.

## search (prefer the URL)
**Goal:** load a results page deterministically.
**Do:** `browser_goto https://au.indeed.com/jobs?q=<keywords>&l=<location>` then
`browser_observe`. Spaces in `q=` are `+` (e.g. `full+stack+engineer`). `l=`: `Australia`
= all AU; `Sydney+NSW` = a city; omit = everywhere. Optional: `&fromage=7` (last N days),
`&radius=25` (km), `&sort=date` (newest). `au.indeed.com` is the AU site.
**Verify:** title reads `"<N> <keywords> Jobs ... | Indeed"` and the node list is long.
This is verified to load WITHOUT a wall on the hardened browser.
**If unexpected:** a verification wall → tell the user to clear it in the open window, then
re-`browser_goto`. If it still fails, use the homepage-box fallback below.

## search (fallback: homepage box)
**Goal:** the more human-looking path, for when URL loads keep getting challenged.
**Do:** `browser_goto https://au.indeed.com/` → `browser_observe` → `browser_type` keywords
into `#text-input-what` → set `#text-input-where` → click "Find jobs".
**If unexpected (the #1 trap here):** typing into either field pops an **autocomplete
dropdown that renumbers refs**. ALWAYS `browser_observe` again before each click; never
reuse a ref across a keystroke. Mis-clicks here come from stale refs.

## read the result list
**Goal:** list matches without clicking each card.
**Do:** from the results `browser_observe`, read each card's nodes: a
`full details of <title>` button at locator `#job_<jk>` (so `#job_b648f28a243666dc` → jk
`b648f28a243666dc`), a `<Company> jobs` link, and a `<City>` link.
**Verify:** present the top matches (title + company + location); let the user pick which to
tailor for, or proceed with the one(s) they named.

## extract the chosen job's JD
**Goal:** a full structured Job record in the DB.
**Do:** for each chosen jk, `page_extract { url: "https://au.indeed.com/viewjob?jk=<jk>" }`.
It navigates the live tab, returns {title, company, location, salary, description}, and
stores the job (jobId `indeed:<jk>`).
**Verify:** `description` is real JD text (hundreds of chars), not a challenge string.
**If unexpected:** `status: "needs_human_input"` + screenshot → ask the user to solve the
check in the open window, then call `page_extract` again for the SAME url. Never invent a jk
or swap URLs. The session stays open server-side.

## generate the tailored resume
**Goal:** the actual deliverable.
**Do:** `generate_resume { jobId }` → `render_resume_pdf { jobId }`. Optional only if asked:
`generate_cover_letter { jobId }` + `render_cover_letter_pdf { jobId }`. You may run
`evaluate_job { jobIdOrUrl: jobId }` first if the user wants a fit read — but don't gate on
it; the core ask is the resume.
**Hard rule:** do NOT call any `seek_apply_*` tool or any submit path. Indeed ends at
generated artefacts on disk.

## close out
**Do:** tell the user where artefacts are (`output/indeed/<company>-<role>/`); the job is in
the tracker. `session_close` when done (cookies are ephemeral; nothing is lost).

## anti-bot notes
- Passes Cloudflare via **real Chrome + stealth** (`navigator.webdriver` spoofed,
  `--enable-automation` dropped, no desktop `--no-sandbox`). Stored cookies are NOT the
  reason — a fresh/incognito context passes on fingerprint alone.
- NOT 100%: IP reputation + Cloudflare randomness still cause occasional walls. The design
  is stop → needs_human_input + screenshot → human clears it → retry. That's normal.
- **One action per turn.** Firing many browser actions at once — especially clicking
  unrelated links or `page_extract` with a made-up jk — looks bot-like and can itself
  trigger a wall. Observe → reason → ONE action → observe.
- Operator may set `BROWSER_PERSIST=true` to reuse a `cf_clearance` across runs; default
  ephemeral is the recommended mode for Indeed.
