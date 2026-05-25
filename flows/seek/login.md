# flow: seek login

Sign in to SEEK with the provided credentials. Behave like a careful human and
click only what is needed to log in. Do not navigate to jobs, do not apply.

When a step refers to {{email}} or {{password}}, use that exact placeholder
token as the value — the runner fills in the real value privately.

Special cases (edit this section when you hit a new one):
- SEEK sometimes asks for a one-time code emailed to you instead of a password.
  If you reach a "we've sent you a code" / verification-code screen and there is
  NO password field, automated login cannot continue — treat the remaining
  steps as done. A human will finish via `seek-login --manual`.

## accept the cookie banner if present

If a cookie or privacy consent banner is visible, click the button that
accepts all cookies. If there is no such banner, skip this step.

## open the sign in page

If a "Sign in" link or button is visible (usually top-right of the header),
click it to go to the sign-in page. If you are already on a sign-in / login
page that shows an email field, skip this step.

## enter the email address

Type {{email}} into the email-address field.

## continue past the email step

Click the button that advances from the email step — prefer one labelled
"Continue", "Next", or "Sign in with password". Do not pick "Sign in with a
code" or any passwordless option if a password choice exists.

## enter the password

If a password field is now visible, type {{password}} into it. If there is no
password field (SEEK is asking for an emailed code instead), skip this step.

## submit the login

Click the final "Sign in" / "Log in" submit button to complete the login. If no
such button is present (you are on a code screen), this step is done.

## finished

The login has been submitted (or it now needs a human-entered code). There is
nothing more for the agent to do — this step is done.
