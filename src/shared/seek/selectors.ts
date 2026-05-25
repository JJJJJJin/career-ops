// Centralized SEEK selectors — the one place to update when SEEK churns
// (mirrors the convention at the top of seek-search). Deterministic checks
// (cookie banner, login state) use these; the agent flows resolve their own
// targets via the LLM and don't need entries here.

/** Cookie / privacy consent accept buttons, best-first. */
export const COOKIE_ACCEPT = [
  '#onetrust-accept-btn-handler',
  'button:has-text("Accept all cookies")',
  'button:has-text("Accept All")',
  'button:has-text("Accept")',
];

/**
 * "Sign in" affordances shown only when logged OUT. Presence of any of these
 * (visible) is our signal that no session is active — the most stable signal
 * across SEEK redesigns, since a logged-out header always offers sign-in.
 */
export const SIGNED_OUT_SIGNALS = [
  '[data-automation="sign in"]',
  '[data-automation="signInLink"]',
  'a[href*="/sign-in"]',
  'a[href*="/oauth/login"]',
  'header a:has-text("Sign in")',
  'a:has-text("Sign in"):visible',
];

/**
 * Account / signed-in affordances shown only when logged IN. A positive
 * fallback when the signed-out signal is ambiguous.
 */
export const SIGNED_IN_SIGNALS = [
  '[data-automation="account name"]',
  '[data-automation="accountMenu"]',
  '[data-automation="account dropdown"]',
  'a[href*="/sign-out"]',
  'button:has-text("Sign out")',
];
