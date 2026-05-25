// seek-login — establish / verify a reusable SEEK session.
//
//   (default)  ensure a session: reuse the cached one, else credential login
//   --manual   headful, human completes sign-in (code/captcha), then cache
//   --check    report whether the cached session is still valid (read-only)
import { closeSession, launchSession } from '../../shared/browser/session.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { ensureLoggedIn, isLoggedIn, manualLogin } from '../../shared/seek/auth.js';

const log = createLogger('seek-login');

export type SeekLoginMode = 'ensure' | 'manual' | 'check';

export type SeekLoginOptions = {
  mode: SeekLoginMode;
  /** Force a visible browser for ensure/check (manual is always headful). */
  headful?: boolean;
  noCache?: boolean;
  /** Supplied by the CLI for manual mode — resolves when the human is done. */
  waitForUser?: () => Promise<void>;
};

export type SeekLoginResult = {
  mode: SeekLoginMode;
  loggedIn: boolean;
  method?: 'reused' | 'credentials';
};

export async function seekLogin(opts: SeekLoginOptions): Promise<SeekLoginResult> {
  const headless = opts.mode === 'manual' ? false : opts.headful ? false : config.browser.headless;
  const session = await launchSession({ headless, storageStatePath: config.seek.authStatePath });
  try {
    if (opts.mode === 'check') {
      const loggedIn = await isLoggedIn(session.page);
      return { mode: 'check', loggedIn };
    }
    if (opts.mode === 'manual') {
      const { loggedIn } = await manualLogin(session, opts.waitForUser ?? (async () => {}));
      return { mode: 'manual', loggedIn };
    }
    const r = await ensureLoggedIn(session, { noCache: opts.noCache });
    log.info({ method: r.method }, 'session ready');
    return { mode: 'ensure', loggedIn: r.loggedIn, method: r.method };
  } finally {
    await closeSession(session);
  }
}
