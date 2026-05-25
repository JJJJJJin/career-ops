// L1 — atomic actions. Pure Playwright primitives that operate on an
// already-resolved Locator. Deterministic, individually testable, no LLM.
// Light human-like jitter keeps behaviour from looking robotic; nothing here
// decides *what* to act on — that is the resolver's job (L3).
import type { Locator, Page } from 'playwright';
import { createLogger } from '../logger.js';

const log = createLogger('agent:actions');

/** Sleep a random duration in [min, max] ms — the unit of "human" timing. */
export function jitter(min = 120, max = 420): Promise<void> {
  const ms = Math.round(min + Math.random() * Math.max(0, max - min));
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_TIMEOUT = 12_000;

async function ensureReady(locator: Locator, timeout = DEFAULT_TIMEOUT): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
}

export async function click(locator: Locator): Promise<void> {
  await ensureReady(locator);
  await jitter();
  await locator.click({ timeout: DEFAULT_TIMEOUT });
  log.debug('click');
}

export async function type(locator: Locator, text: string): Promise<void> {
  await ensureReady(locator);
  await jitter();
  await locator.click({ timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await locator.fill('');
  // pressSequentially gives per-character delay → looks typed, not pasted.
  await locator.pressSequentially(text, { delay: 18 + Math.random() * 40 });
  log.debug({ chars: text.length }, 'type');
}

export async function selectOption(locator: Locator, value: string): Promise<void> {
  await ensureReady(locator);
  await jitter();
  // Try by value, then by visible label — whichever the <option> matches.
  await locator.selectOption({ label: value }).catch(async () => {
    await locator.selectOption(value);
  });
  log.debug({ value }, 'select');
}

export async function check(locator: Locator): Promise<void> {
  await ensureReady(locator);
  await jitter();
  await locator.check({ timeout: DEFAULT_TIMEOUT });
  log.debug('check');
}

export async function uncheck(locator: Locator): Promise<void> {
  await ensureReady(locator);
  await jitter();
  await locator.uncheck({ timeout: DEFAULT_TIMEOUT });
  log.debug('uncheck');
}

export async function uploadFile(locator: Locator, filePath: string): Promise<void> {
  // File inputs are often visually hidden; don't wait for visibility.
  await locator.setInputFiles(filePath, { timeout: DEFAULT_TIMEOUT });
  log.debug({ filePath }, 'upload');
}

export async function press(page: Page, key: string): Promise<void> {
  await jitter();
  await page.keyboard.press(key);
  log.debug({ key }, 'press');
}

export async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  log.debug({ url }, 'goto');
}

export async function readText(locator: Locator): Promise<string> {
  await ensureReady(locator);
  return (await locator.innerText({ timeout: DEFAULT_TIMEOUT })).trim();
}

/** Assertion: resolves true if the located element is visible within timeout. */
export async function assertVisible(locator: Locator, timeout = DEFAULT_TIMEOUT): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}
