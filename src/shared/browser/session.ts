// Lightweight Playwright launcher. Exports `withBrowser` so callers don't
// have to track lifecycle.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('browser');

export type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

export type LaunchOptions = {
  headless?: boolean;
  slowMoMs?: number;
  userAgent?: string;
};

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export async function launchSession(opts: LaunchOptions = {}): Promise<BrowserSession> {
  const headless = opts.headless ?? config.browser.headless;
  const slowMo = opts.slowMoMs ?? config.browser.slowMoMs;
  log.debug({ headless, slowMo }, 'browser: launching');
  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({
    userAgent: opts.userAgent ?? DEFAULT_UA,
    viewport: { width: 1366, height: 900 },
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function closeSession(session: BrowserSession): Promise<void> {
  try {
    await session.context.close();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'browser: context close failed');
  }
  try {
    await session.browser.close();
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
