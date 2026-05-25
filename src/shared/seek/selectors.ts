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

// ─── Resume document management (SEEK profile, /profile/me/resume?mode=edit) ──
export const RESUME = {
  managerUrl: 'https://www.seek.com.au/profile/me/resume?mode=edit',
  /** Max saved resumes SEEK allows. */
  limit: 10,
  /** The manager drawer — scope queries here to avoid the profile page underneath. */
  drawer: '[data-automation="resume-form-drawer"]',
  /** Container that confirms the manager has rendered. */
  list: '[data-automation="resume-item-list"]',
  /** Each saved resume: data-automation="resume-item-<uuid>". */
  itemPrefix: 'resume-item-',
  /** Default-badge marker inside the default resume's item. */
  defaultPrefix: 'resume-is-default-',
  /**
   * Hidden <input type=file> for upload (setInputFiles, not a click). Scoped to
   * the drawer so we never hit the profile avatar's file input.
   */
  fileInput: '[data-automation="resume-form-drawer"] input[type="file"]',
  /** Per-resume ⋮ menu trigger (label carries the filename). */
  optionsFor: (filename: string) => `[aria-label="Options for ${filename}"]`,
  /** "Delete" item inside an opened ⋮ menu, by resume id. */
  deleteButton: (id: string) => `[data-automation="delete-resume-button-${id}"]`,
  /** "Make default" item inside an opened ⋮ menu, by resume id. */
  makeDefaultButton: (id: string) => `[data-automation="resume-make-default-${id}"]`,
  /** "Done" closes the manager. */
  done: '[data-automation="manage-resume-done"]',
} as const;
