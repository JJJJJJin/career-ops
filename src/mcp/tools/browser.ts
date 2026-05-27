// Browser tools — the stateful core. session lifecycle + perceive + atomic
// actions, all against the one live SessionManager browser. The external agent
// drives these one at a time: observe → reason → act → observe.
import type { Page } from 'playwright';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as actions from '../../shared/agent/actions.js';
import { renderNodesForPrompt } from '../../shared/agent/perception.js';
import { createLogger } from '../../shared/logger.js';
import { sessions } from '../session.js';
import { guard, ok, withScreenshot } from '../result.js';

const log = createLogger('mcp:tools:browser');

/** Let any navigation / SPA transition land, then report where we ended up. */
async function settle(page: Page): Promise<{ url: string; title: string }> {
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  let title = '';
  try {
    title = await page.title();
  } catch {
    /* mid-navigation */
  }
  return { url: page.url(), title };
}

export function registerBrowserTools(server: McpServer): void {
  server.registerTool(
    'ping',
    { title: 'Ping', description: 'Liveness check. Returns ok plus whether a browser session is open.' },
    async () => ok({ ok: true, browserOpen: sessions.isOpen }, `pong (browser ${sessions.isOpen ? 'open' : 'closed'})`),
  );

  // ─── session lifecycle ────────────────────────────────────────────────────
  server.registerTool(
    'session_status',
    { title: 'Session status', description: 'Report whether the live browser is open, its URL/title, and how many nodes the last observe captured.' },
    async () => {
      const s = await sessions.status();
      return ok(s as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    'session_open',
    {
      title: 'Open browser session',
      description: 'Launch (or relaunch) the live browser session. Use headless:false to watch it. The session is otherwise launched lazily on the first browser action and is reused across tool calls and across the whole conversation.',
      inputSchema: { headless: z.boolean().optional().describe('false shows the browser window (headful). Default from config.') },
    },
    async ({ headless }) => guard(async () => ok((await sessions.open({ headless })) as unknown as Record<string, unknown>)),
  );

  server.registerTool(
    'session_close',
    { title: 'Close browser session', description: 'Close the live browser. Cookies are persisted first, so a logged-in session is restored on the next launch.' },
    async () => guard(async () => {
      await sessions.close('tool');
      return ok({ closed: true });
    }),
  );

  // ─── perceive ─────────────────────────────────────────────────────────────
  server.registerTool(
    'browser_observe',
    {
      title: 'Observe the page',
      description:
        'Snapshot the live page into a numbered, ref-tagged list of interactive elements (+ headings for context). ALWAYS call this before any action: refs are valid only for the most recent observe, and a navigation invalidates them.',
    },
    async () => guard(async () => {
      const snap = await sessions.observe();
      const text = `PAGE: ${snap.title}  <${snap.url}>\nsignature: ${snap.signature}\nELEMENTS:\n${renderNodesForPrompt(snap.nodes)}`;
      return ok(
        { url: snap.url, title: snap.title, signature: snap.signature, nodeCount: snap.nodes.length, nodes: snap.nodes },
        text,
      );
    }),
  );

  // ─── atomic actions ───────────────────────────────────────────────────────
  const refSchema = { ref: z.number().int().min(0).describe('Element number from the most recent browser_observe.') };

  server.registerTool(
    'browser_click',
    { title: 'Click', description: 'Click the element at `ref` (button, link, label, radio/checkbox label, …).', inputSchema: refSchema },
    async ({ ref }) => guard(async () => {
      const loc = await sessions.resolveLocator(ref);
      await actions.click(loc);
      const where = await settle(await sessions.getPage());
      log.info({ ref }, 'click');
      return ok({ acted: 'click', ref, ...where });
    }),
  );

  server.registerTool(
    'browser_type',
    {
      title: 'Type text',
      description: 'Clear the field at `ref` and type `value` into it (per-character, human-like). For passwords/codes pass the value directly — it is used immediately and never logged.',
      inputSchema: { ...refSchema, value: z.string().describe('Text to type.') },
    },
    async ({ ref, value }) => guard(async () => {
      const loc = await sessions.resolveLocator(ref);
      await actions.type(loc, value);
      const where = await settle(await sessions.getPage());
      log.info({ ref, chars: value.length }, 'type');
      return ok({ acted: 'type', ref, chars: value.length, ...where });
    }),
  );

  server.registerTool(
    'browser_select',
    {
      title: 'Select option',
      description: 'Choose an <option> in the <select> at `ref`, matched by visible label then by value.',
      inputSchema: { ...refSchema, value: z.string().describe('Option label (preferred) or value.') },
    },
    async ({ ref, value }) => guard(async () => {
      const loc = await sessions.resolveLocator(ref);
      await actions.selectOption(loc, value);
      const where = await settle(await sessions.getPage());
      return ok({ acted: 'select', ref, value, ...where });
    }),
  );

  server.registerTool(
    'browser_check',
    { title: 'Check', description: 'Tick the checkbox/radio at `ref` (idempotent).', inputSchema: refSchema },
    async ({ ref }) => guard(async () => {
      await actions.check(await sessions.resolveLocator(ref));
      return ok({ acted: 'check', ref, ...(await settle(await sessions.getPage())) });
    }),
  );

  server.registerTool(
    'browser_uncheck',
    { title: 'Uncheck', description: 'Untick the checkbox at `ref` (idempotent).', inputSchema: refSchema },
    async ({ ref }) => guard(async () => {
      await actions.uncheck(await sessions.resolveLocator(ref));
      return ok({ acted: 'uncheck', ref, ...(await settle(await sessions.getPage())) });
    }),
  );

  server.registerTool(
    'browser_upload',
    {
      title: 'Upload file',
      description: 'Set the file at absolute `path` on the file <input> at `ref` (uses setInputFiles — no native dialog).',
      inputSchema: { ...refSchema, path: z.string().describe('Absolute path to the file to upload.') },
    },
    async ({ ref, path }) => guard(async () => {
      await actions.uploadFile(await sessions.resolveLocator(ref), path);
      return ok({ acted: 'upload', ref, path, ...(await settle(await sessions.getPage())) });
    }),
  );

  server.registerTool(
    'browser_press',
    {
      title: 'Press key',
      description: 'Press a keyboard key on the page (e.g. "Enter", "Escape", "Tab"). Useful to submit a focused field.',
      inputSchema: { key: z.string().default('Enter').describe('Key name, e.g. "Enter".') },
    },
    async ({ key }) => guard(async () => {
      const page = await sessions.getPage();
      await actions.press(page, key);
      return ok({ acted: 'press', key, ...(await settle(page)) });
    }),
  );

  server.registerTool(
    'browser_goto',
    {
      title: 'Navigate',
      description: 'Navigate the live browser to an absolute URL.',
      inputSchema: { url: z.string().url().describe('Absolute URL to open.') },
    },
    async ({ url }) => guard(async () => {
      const page = await sessions.getPage();
      await actions.goto(page, url);
      return ok({ acted: 'goto', ...(await settle(page)) });
    }),
  );

  server.registerTool(
    'browser_assert',
    {
      title: 'Assert visible',
      description: 'Check whether the element at `ref` is visible. Returns { visible: true|false } — does not throw.',
      inputSchema: refSchema,
    },
    async ({ ref }) => guard(async () => {
      const visible = await actions.assertVisible(await sessions.resolveLocator(ref));
      return ok({ acted: 'assert', ref, visible });
    }),
  );

  server.registerTool(
    'browser_read',
    { title: 'Read text', description: 'Return the visible inner text of the element at `ref`.', inputSchema: refSchema },
    async ({ ref }) => guard(async () => {
      const text = await actions.readText(await sessions.resolveLocator(ref));
      return ok({ ref, text }, text);
    }),
  );

  server.registerTool(
    'browser_screenshot',
    { title: 'Screenshot', description: 'Capture a JPEG of the current viewport (for visual disambiguation or to show the user).' },
    async () => guard(async () => {
      const buf = await sessions.screenshot();
      return withScreenshot(buf.toString('base64'), 'screenshot captured');
    }),
  );
}
