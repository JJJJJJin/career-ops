# flow: seek login

Start signing in to SEEK with the email address. SEEK's sign-in is passwordless
by default: you enter the email, request a one-time code by email, and a later
step (handled separately) enters that code. Behave like a careful human; click
only what is needed to sign in. Do NOT use "Continue with Google/Facebook/Apple".

When a step refers to {{email}}, use that exact placeholder token as the value.

## accept the cookie banner if present

If a cookie or privacy consent banner is visible, click the button that accepts
all cookies. If there is no such banner, skip this step.

## open the sign in page

If a "Sign in" link or button is visible (usually top-right of the header),
click it to go to the sign-in page. If you are already on a sign-in page that
shows an "Email address" field, skip this step.

## enter the email address

Type {{email}} into the "Email address" field (the plain email input below the
"or" divider, not the social-login buttons).

## request the sign-in code

Click the "Email me a sign in code" button to make SEEK send a one-time code to
the email address. If a password field is shown instead and there is a password
sign-in button, you may skip this step.

## finished

The sign-in code has been requested (SEEK is emailing it now). There is nothing
more for this flow to do — the code is entered by a separate step.
