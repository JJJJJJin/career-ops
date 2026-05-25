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

/** Navigate to SEEK and determine whether a session is active. */
export async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto(config.seek.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await acceptCookies(page);
  if (await anyVisible(page, SIGNED_OUT_SIGNALS)) return false;
  if (await anyVisible(page, SIGNED_IN_SIGNALS)) return true;
  log.warn('login state ambiguous (no sign-in or account signal matched) — treating as logged out; selectors may have drifted');
  return false;
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

  const { email, password } = config.seek;
  if (!email || !password) {
    throw new Error(
      'Not logged in and SEEK_EMAIL / SEEK_PASSWORD are not set in .env. ' +
        'Run `career-ops seek-login --manual` once to sign in by hand — the session is then cached and reused.',
    );
  }

  log.info('no session — attempting credential login via seek/login flow');
  await runFlow('seek/login', {
    session,
    startUrl: config.seek.baseUrl,
    context: { email, password },
    noCache: opts.noCache,
  });

  if (await isLoggedIn(session.page)) {
    await saveStorageState(session, config.seek.authStatePath);
    log.info({ authStatePath: config.seek.authStatePath }, 'credential login succeeded — session cached');
    return { loggedIn: true, method: 'credentials' };
  }

  throw new Error(
    'Credential login did not establish a session (SEEK likely required an emailed code or captcha). ' +
      'Run `career-ops seek-login --manual` once (headful) to finish login by hand; the session will be cached and reused.',
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
