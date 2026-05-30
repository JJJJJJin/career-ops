// Playwright launcher with anti-bot hardening. Exports `withBrowser` so callers
// don't have to track lifecycle.
//
// Why the hardening: Cloudflare (Indeed etc.) fingerprints the *browser*, not
// the cursor. A vanilla Playwright Chromium leaks automation tells — most of
// all `navigator.webdriver === true`, the `--enable-automation` switch, the
// bundled (non-Google) Chromium build, and server-only flags like
// `--no-sandbox`. A real user's Chrome has none of these. So we:
//   1. drive REAL Google Chrome (channel:'chrome'), falling back to bundled
//      Chromium only if Chrome isn't installed;
//   2. strip the automation switches + spoof navigator.webdriver;
//   3. drop sandbox/GPU flags except on constrained Linux hosts;
//   4. optionally use a PERSISTENT user-data dir, so a cf_clearance cookie
//      earned by passing one human-check survives — the next launch sails
//      through without re-verifying (exactly how your everyday Chrome behaves).
import fs from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('browser');

export type BrowserSession = {
  /** null in persistent mode — the context owns the browser there. */
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
};

export type LaunchOptions = {
  headless?: boolean;
  slowMoMs?: number;
  userAgent?: string;
  /** Extra Chromium CLI flags (e.g. deterministic font rendering for PDF). */
  args?: string[];
  /**
   * Path to a Playwright storageState JSON (cookies + localStorage). Loaded
   * into a fresh context when the file exists. Ignored in persistent mode
   * (the user-data dir already carries cookies).
   */
  storageStatePath?: string;
  /**
   * Persist cookies + the whole profile across runs in this directory (uses
   * launchPersistentContext). Critical for anti-bot: a verified cf_clearance
   * cookie survives, so the human-check is paid once. Omit for a throwaway
   * profile (ephemeral context, optionally seeded from storageStatePath).
   */
  userDataDir?: string;
};

// Runs before any page script and survives navigation. Hides the automation
// tells Cloudflare fingerprints, and keeps the tsx/esbuild __name shim (its
// evaluate bodies are serialised into the page, where __name must exist).
const STEALTH_INIT = `
globalThis.__name = globalThis.__name || function (f) { return f; };
try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
try { if (!window.chrome) { window.chrome = { runtime: {} }; } } catch (e) {}
`;

function stealthArgs(extra: string[] = []): string[] {
  const args = ['--disable-blink-features=AutomationControlled', ...extra];
  // Sandbox/GPU flags are server/CI tells — only needed on constrained Linux
  // hosts (Raspberry Pi). On a desktop they make the browser look automated.
  if (process.platform === 'linux') {
    args.push('--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox');
  }
  return args;
}

function contextOptions(opts: LaunchOptions): Record<string, unknown> {
  return {
    viewport: { width: 1366, height: 900 },
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    // Let real Chrome send its own UA unless one is explicitly forced — a
    // hardcoded UA that disagrees with the engine is itself a bot signal.
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
  };
}

export async function launchSession(opts: LaunchOptions = {}): Promise<BrowserSession> {
  const headless = opts.headless ?? config.browser.headless;
  const slowMo = opts.slowMoMs ?? config.browser.slowMoMs;
  const args = stealthArgs(opts.args ?? []);
  // Drop the "Chrome is being controlled by automated test software" switch.
  const ignoreDefaultArgs = ['--enable-automation'];
  const persistent = opts.userDataDir ? { userDataDir: opts.userDataDir } : null;

  // Prefer real Google Chrome; fall back to the bundled Chromium if absent.
  const channels: Array<'chrome' | undefined> = ['chrome', undefined];
  let lastErr: unknown;
  for (const channel of channels) {
    try {
      if (persistent) {
        const context = await chromium.launchPersistentContext(persistent.userDataDir, {
          channel,
          headless,
          slowMo,
          args,
          ignoreDefaultArgs,
          ...contextOptions(opts),
        });
        await context.addInitScript(STEALTH_INIT);
        const page = context.pages()[0] ?? (await context.newPage());
        log.debug({ channel: channel ?? 'chromium', persistent: true }, 'browser: launched (persistent)');
        return { browser: context.browser(), context, page };
      }
      const browser = await chromium.launch({ channel, headless, slowMo, args, ignoreDefaultArgs });
      const hasState = !!opts.storageStatePath && fs.existsSync(opts.storageStatePath);
      const context = await browser.newContext({
        ...contextOptions(opts),
        ...(hasState ? { storageState: opts.storageStatePath } : {}),
      });
      await context.addInitScript(STEALTH_INIT);
      const page = await context.newPage();
      log.debug({ channel: channel ?? 'chromium', persistent: false, storageState: hasState }, 'browser: launched');
      return { browser, context, page };
    } catch (err) {
      lastErr = err;
      log.warn({ channel: channel ?? 'chromium', err: (err as Error).message }, 'browser: launch attempt failed');
    }
  }
  throw lastErr;
}

/** Persist the context's cookies + localStorage to disk for later reuse. */
export async function saveStorageState(session: BrowserSession, path: string): Promise<void> {
  await session.context.storageState({ path });
  log.debug({ path }, 'browser: storage state saved');
}

export async function closeSession(session: BrowserSession): Promise<void> {
  try {
    await session.context.close();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'browser: context close failed');
  }
  try {
    await session.browser?.close();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'browser: browser close failed');
  }
}

export async function withBrowser<T>(
  fn: (session: BrowserSession) => Promise<T>,
  opts: LaunchOptions = {},
): Promise<T> {
  const session = await launchSession(opts);
  try {
    return await fn(session);
  } finally {
    await closeSession(session);
  }
}
