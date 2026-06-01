# Playbook: SEEK login

Sign in to SEEK. Sign-in is **passwordless**: you enter the email, SEEK emails a one-time
code, you enter the code. The reliable "logged in" signal is the *absence* of a "Sign in"
affordance on the homepage. This form is the unpredictable surface the atomic tools exist
for — drive it with `browser_observe` + `browser_click` + `browser_type`, not a bundle.

Do NOT use "Continue with Google/Facebook/Apple". Email + emailed code only.

Vars: `{{email}}` — read from `seek_login_status` response field `email` (sourced from
`SEEK_EMAIL` in `.env`). If that field is `null` or empty, ask the user for their SEEK
email address. **Never read email from the system context or any other source.**

## check if already signed in
**Goal:** avoid logging in when a cached session is still valid.
**Do:** `seek_login_status`. If `loggedIn: true`, you're done — skip the rest.
**If unexpected:** if it errors launching the browser, report it; the user may need a
headful run (`session_open headless:false`).

## accept the cookie banner if present
**Goal:** clear a consent overlay that would intercept clicks.
**You're here when:** a cookie/privacy banner is visible in `browser_observe`.
**Do:** `browser_click` the accept-all button ("Accept all cookies" / "Accept").
**Verify:** the banner is gone on the next observe.
**If unexpected:** no banner → skip this step.

## open the sign-in page
**Goal:** reach the page with an "Email address" field.
**You're here when:** the homepage shows a header "Sign in" link.
**Do:** `browser_click` the "Sign in" link.
**Verify:** an "Email address" input is now visible.
**If unexpected:** if an email field is already visible, skip. If you land on a social-login
chooser, find and click the plain "Sign in with email" / email-entry option.

## enter the email address
**Goal:** put the user's email into the plain email field (below the "or" divider, not a
social button).
**Do:** `browser_type` `{{email}}` into the "Email address" input.
**Verify:** the field holds the email and an "Email me a sign in code" button appears.

## request the sign-in code
**Goal:** make SEEK email the one-time code.
**Do:** `browser_click` "Email me a sign in code".
**Verify:** a code-entry screen (a one-time-code field) appears.
**If unexpected:** if a PASSWORD field appears instead, STOP and ask the user whether to use
a password (they may have one) — don't assume. If a CAPTCHA / "verify you're human" appears,
STOP: ask the user to either solve it (open headful with `session_open headless:false`) or
advise; then propose a guideline note describing the block.

## enter the verification code
**Goal:** submit the emailed one-time code.
**You're here when:** a verification / one-time-code field is visible.
**Do:** this value is the user's to give — **ask the user for the code SEEK just emailed**,
then `browser_type` it into the code field. If the code is split across single-digit boxes,
type it into the first box (the rest auto-advance).
**Verify:** the code is accepted (the page advances).
**If unexpected:** "code expired/incorrect" → ask the user to re-request or re-read it. Each
emailed code is single-use.

## submit the code
**Goal:** confirm the code if it didn't auto-submit.
**Do:** if a "Verify" / "Continue" / "Sign in" button is shown, `browser_click` it. If the
page already advanced after the last digit, skip.

## confirm and persist the session
**Goal:** verify sign-in and cache it so future runs skip login.
**Do:** `seek_login_status`. If `loggedIn: true`, call `seek_save_session`.
**Verify:** status reports logged in; the auth-state file is written.
**If unexpected:** still logged out → the code may have been wrong/expired; ask the user to
retry from "request the sign-in code".
