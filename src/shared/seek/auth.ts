// (A) Login / session management for SEEK.
//
// Strategy, in order of preference:
//   1. Reuse a persisted session (storageState file) — no login at all.
//   2. Credential login via the `seek/login` agent flow (best effort).
//   3. Manual headful login (human handles email-code / captcha), then cache.
//
// The deterministic parts (state file, logged-in detection) live here; the
// actual form interaction is delegated to the flow engine, since a login page
// is exactly the kind of unpredictable surface the engine exists for.
import type { Page } from 'playwright';
import { saveStorageState, type BrowserSession } from '../browser/session.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { runFlow } from '../agent/flow.js';
import { awaitHumanInput } from '../agent/human-input.js';
import { COOKIE_ACCEPT, SIGNED_IN_SIGNALS, SIGNED_OUT_SIGNALS } from './selectors.js';

const log = createLogger('seek:auth');

async function anyVisible(page: Page, selectors: string[], perTimeout = 500): Promise<boolean> {
  for (const sel of selectors) {
    try {
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: perTimeout });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

export async function acceptCookies(page: Page): Promise<void> {
  for (const sel of COOKIE_ACCEPT) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ timeout: 1500 });
        await page.waitForTimeout(300);
        return;
      }
    } catch {
      /* try next */
    }
  }
}

/** Check the CURRENT page for a signed-in signal — does not navigate. */
export async function looksLoggedInHere(page: Page): Promise<boolean> {
  if (await anyVisible(page, SIGNED_OUT_SIGNALS)) return false;
  if (await anyVisible(page, SIGNED_IN_SIGNALS)) return true;
  return false;
}

/**
 * Navigate to SEEK and determine whether a session is active. The reliable
 * signal is the "Sign in" affordance: the logged-out homepage always shows it,
 * a logged-in one never does. So its ABSENCE means we're signed in — more
 * robust than matching a positive account selector (those drift). A positive
 * account signal is treated as a fast-path confirmation.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto(config.seek.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await acceptCookies(page);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  if (await anyVisible(page, SIGNED_IN_SIGNALS, 700)) return true;
  // No sign-in affordance on the homepage ⇒ signed in.
  const signedOut = await anyVisible(page, SIGNED_OUT_SIGNALS, 900);
  return !signedOut;
}

export type EnsureLoginResult = { loggedIn: boolean; method: 'reused' | 'credentials' };

/**
 * Guarantee an active session on `session`, which MUST have been launched with
 * storageStatePath = config.seek.authStatePath so any cached cookies load.
 * Throws with actionable guidance when only a manual login can proceed.
 */
export async function ensureLoggedIn(session: BrowserSession, opts: { noCache?: boolean } = {}): Promise<EnsureLoginResult> {
  if (await isLoggedIn(session.page)) {
    log.info('reusing persisted SEEK session');
    return { loggedIn: true, method: 'reused' };
  }

  const { email } = config.seek;
  if (!email) {
    throw new Error(
      'Not logged in and SEEK_EMAIL is not set in .env. Set it, or run ' +
        '`career-ops seek-login --manual` once to sign in by hand.',
    );
  }

  // SEEK is passwordless: enter the email and request a one-time code.
  log.info('no session — starting passwordless login (seek/login flow)');
  const loginRes = await runFlow('seek/login', {
    session,
    startUrl: config.seek.baseUrl,
    context: { email },
    noCache: opts.noCache,
  });
  if (!loginRes.completed) {
    throw new Error(
      `Login flow stalled at step "${loginRes.failedStep}". Screenshot: ${loginRes.screenshotPath ?? 'n/a'}. ` +
        'Improve flows/seek/login.md for that step, or run `career-ops seek-login --manual`.',
    );
  }

  // We're now on the code-entry screen. Do NOT call isLoggedIn here — it would
  // navigate away. Pause for the emailed code via the broker (the supervising
  // agent relays it with `agent-provide`; reply "skip" for a captcha/other block).
  const code = await awaitHumanInput({
    label: `SEEK sign-in code emailed to ${email} (reply "skip" if there's a captcha or other block)`,
    kind: 'code',
  });
  if (!code || code.trim().toLowerCase() === 'skip') {
    throw new Error(
      'No code provided. Run `career-ops seek-login --manual` once (headful) to finish login by hand; ' +
        'the session will then be cached and reused.',
    );
  }

  const codeRes = await runFlow('seek/login-code', { session, context: { code: code.trim() }, noCache: opts.noCache });
  if (!codeRes.completed) {
    throw new Error(`Code-entry flow stalled at step "${codeRes.failedStep}". Screenshot: ${codeRes.screenshotPath ?? 'n/a'}.`);
  }

  if (await isLoggedIn(session.page)) {
    await saveStorageState(session, config.seek.authStatePath);
    log.info({ authStatePath: config.seek.authStatePath }, 'login completed with emailed code — session cached');
    return { loggedIn: true, method: 'credentials' };
  }

  throw new Error(
    'Entered the code but still not signed in (it may have been wrong or expired). ' +
      'Re-run `career-ops seek-login`, or use `--manual`.',
  );
}

/**
 * Headful manual login. Opens SEEK, lets the human complete sign-in (including
 * an emailed code or captcha), then persists the session. `waitForUser` is
 * supplied by the CLI (e.g. "press Enter when done") so this module stays free
 * of stdin concerns.
 */
export async function manualLogin(session: BrowserSession, waitForUser: () => Promise<void>): Promise<{ loggedIn: boolean }> {
  await session.page.goto(config.seek.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await acceptCookies(session.page);

  if (await looksLoggedInHere(session.page)) {
    await saveStorageState(session, config.seek.authStatePath);
    log.info('already logged in — session cached');
    return { loggedIn: true };
  }

  await waitForUser();

  // Persist whatever cookies now exist, then verify.
  await saveStorageState(session, config.seek.authStatePath);
  const loggedIn = await isLoggedIn(session.page);
  if (loggedIn) log.info({ authStatePath: config.seek.authStatePath }, 'manual login confirmed — session cached');
  else log.warn('session saved but it still looks logged out — you may need to retry `seek-login --manual`');
  return { loggedIn };
}
