// Browser tools — the stateful core. session + tab lifecycle + perceive +
// atomic actions, all against the one live SessionManager browser. The external
// agent drives these one at a time: observe → reason → act → observe.
//
// Multi-tab: every browser_* action takes an optional `tab` (a tab id from
// tab_open / tab_list). Omit it to act on the ACTIVE tab — so existing
// single-tab playbooks keep working unchanged. All tabs share one context
// (one login), so e.g. a persistent resume tab and a job's apply tab coexist
// without clobbering each other.
import type { Page } from 'playwright';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as actions from '../../shared/agent/actions.js';
import { renderNodesForPrompt } from '../../shared/agent/perception.js';
import { createLogger } from '../../shared/logger.js';
import { sessions } from '../session.js';
import { guard, needsHumanInput, ok, withScreenshot } from '../result.js';
import { detectSource } from '../../shared/jobs/registry.js';
import { detectChallenge, readPageContent, textLooksLikeChallenge } from '../../shared/browser/antibot.js';

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
    { title: 'Session status', description: 'Report whether the live browser is open, the active tab, and every open tab (id/url/title/snapshot size).' },
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
    { title: 'Close browser session', description: 'Close the live browser (all tabs). Cookies are persisted first, so a logged-in session is restored on the next launch.' },
    async () => guard(async () => {
      await sessions.close('tool');
      return ok({ closed: true });
    }),
  );

  // ─── tab lifecycle ────────────────────────────────────────────────────────
  server.registerTool(
    'tab_open',
    {
      title: 'Open a tab',
      description:
        'Open a new tab in the SAME browser context (shared login/cookies). Optionally navigate to `url` and give it a stable `id` (reused if it already exists — handy for per-job apply tabs like "apply:<jobId>") and a human `label`. Becomes the active tab unless activate:false.',
      inputSchema: {
        url: z.string().url().optional().describe('Navigate the new tab here.'),
        id: z.string().optional().describe('Stable id; reused if a tab with this id is already open.'),
        label: z.string().optional().describe('Human label, e.g. the job title.'),
        activate: z.boolean().optional().describe('Default true. false = open in the background.'),
      },
    },
    async ({ url, id, label, activate }) =>
      guard(async () => ok((await sessions.openTab({ url, id, label, activate })) as unknown as Record<string, unknown>)),
  );

  server.registerTool(
    'tab_list',
    { title: 'List tabs', description: 'List every open tab: id, whether it is active, url, title, label, and how many nodes its last observe captured.' },
    async () => guard(async () => {
      const tabs = await sessions.listTabs();
      return ok({ count: tabs.length, tabs }, tabs.map((t) => `${t.active ? '*' : ' '} ${t.id} — ${t.title || t.url}`).join('\n') || 'no tabs');
    }),
  );

  server.registerTool(
    'tab_switch',
    { title: 'Switch tab', description: 'Make a tab the active one (subsequent browser_* calls without a `tab` act on it).', inputSchema: { tab: z.string().describe('Tab id from tab_list.') } },
    async ({ tab }) => guard(async () => ok(sessions.switchTab(tab) as unknown as Record<string, unknown>)),
  );

  server.registerTool(
    'tab_close',
    {
      title: 'Close tab',
      description: 'Close one tab (e.g. after a job is submitted) without touching the rest. The browser and other tabs stay open.',
      inputSchema: { tab: z.string().describe('Tab id from tab_list.') },
    },
    async ({ tab }) => guard(async () => ok((await sessions.closeTab(tab)) as unknown as Record<string, unknown>)),
  );

  // ─── perceive ─────────────────────────────────────────────────────────────
  const tabParam = { tab: z.string().optional().describe('Tab id (from tab_list/tab_open). Omit = the active tab.') };

  server.registerTool(
    'browser_observe',
    {
      title: 'Observe the page',
      description:
        'Snapshot the (active or given) tab into a numbered, ref-tagged list of interactive elements (+ headings for context). ALWAYS call this before any action: refs are valid only for the most recent observe ON THAT TAB, and a navigation invalidates them.',
      inputSchema: { ...tabParam },
    },
    async ({ tab }) => guard(async () => {
      const snap = await sessions.observe(tab);
      const text = `PAGE: ${snap.title}  <${snap.url}>\nsignature: ${snap.signature}\nELEMENTS:\n${renderNodesForPrompt(snap.nodes)}`;
      return ok(
        { tab: tab ?? 'active', url: snap.url, title: snap.title, signature: snap.signature, nodeCount: snap.nodes.length, nodes: snap.nodes },
        text,
      );
    }),
  );

  // ─── atomic actions ───────────────────────────────────────────────────────
  const refSchema = { ref: z.number().int().min(0).describe('Element number from the most recent browser_observe.'), ...tabParam };

  server.registerTool(
    'browser_click',
    { title: 'Click', description: 'Click the element at `ref` (button, link, label, radio/checkbox label, …).', inputSchema: refSchema },
    async ({ ref, tab }) => guard(async () => {
      const loc = await sessions.resolveLocator(ref, tab);
      await actions.click(loc);
      const where = await settle(await sessions.getPage(tab));
      log.info({ ref, tab }, 'click');
      return ok({ acted: 'click', ref, tab: tab ?? 'active', ...where });
    }),
  );

  server.registerTool(
    'browser_type',
    {
      title: 'Type text',
      description: 'Clear the field at `ref` and type `value` into it (per-character, human-like). For passwords/codes pass the value directly — it is used immediately and never logged.',
      inputSchema: { ...refSchema, value: z.string().describe('Text to type.') },
    },
    async ({ ref, value, tab }) => guard(async () => {
      const loc = await sessions.resolveLocator(ref, tab);
      await actions.type(loc, value);
      const where = await settle(await sessions.getPage(tab));
      log.info({ ref, tab, chars: value.length }, 'type');
      return ok({ acted: 'type', ref, tab: tab ?? 'active', chars: value.length, ...where });
    }),
  );

  server.registerTool(
    'browser_select',
    {
      title: 'Select option',
      description: 'Choose an <option> in the <select> at `ref`, matched by visible label then by value.',
      inputSchema: { ...refSchema, value: z.string().describe('Option label (preferred) or value.') },
    },
    async ({ ref, value, tab }) => guard(async () => {
      const loc = await sessions.resolveLocator(ref, tab);
      await actions.selectOption(loc, value);
      const where = await settle(await sessions.getPage(tab));
      return ok({ acted: 'select', ref, tab: tab ?? 'active', value, ...where });
    }),
  );

  server.registerTool(
    'browser_check',
    { title: 'Check', description: 'Tick the checkbox/radio at `ref` (idempotent).', inputSchema: refSchema },
    async ({ ref, tab }) => guard(async () => {
      await actions.check(await sessions.resolveLocator(ref, tab));
      return ok({ acted: 'check', ref, tab: tab ?? 'active', ...(await settle(await sessions.getPage(tab))) });
    }),
  );

  server.registerTool(
    'browser_uncheck',
    { title: 'Uncheck', description: 'Untick the checkbox at `ref` (idempotent).', inputSchema: refSchema },
    async ({ ref, tab }) => guard(async () => {
      await actions.uncheck(await sessions.resolveLocator(ref, tab));
      return ok({ acted: 'uncheck', ref, tab: tab ?? 'active', ...(await settle(await sessions.getPage(tab))) });
    }),
  );

  server.registerTool(
    'browser_upload',
    {
      title: 'Upload file',
      description: 'Set the file at absolute `path` on the file <input> at `ref` (uses setInputFiles — no native dialog).',
      inputSchema: { ...refSchema, path: z.string().describe('Absolute path to the file to upload.') },
    },
    async ({ ref, path, tab }) => guard(async () => {
      await actions.uploadFile(await sessions.resolveLocator(ref, tab), path);
      return ok({ acted: 'upload', ref, tab: tab ?? 'active', path, ...(await settle(await sessions.getPage(tab))) });
    }),
  );

  server.registerTool(
    'browser_press',
    {
      title: 'Press key',
      description: 'Press a keyboard key on the page (e.g. "Enter", "Escape", "Tab"). Useful to submit a focused field.',
      inputSchema: { key: z.string().default('Enter').describe('Key name, e.g. "Enter".'), ...tabParam },
    },
    async ({ key, tab }) => guard(async () => {
      const page = await sessions.getPage(tab);
      await actions.press(page, key);
      return ok({ acted: 'press', key, tab: tab ?? 'active', ...(await settle(page)) });
    }),
  );

  server.registerTool(
    'browser_goto',
    {
      title: 'Navigate',
      description: 'Navigate the (active or given) tab to an absolute URL.',
      inputSchema: { url: z.string().url().describe('Absolute URL to open.'), ...tabParam },
    },
    async ({ url, tab }) => guard(async () => {
      const page = await sessions.getPage(tab);
      await actions.goto(page, url);
      return ok({ acted: 'goto', tab: tab ?? 'active', ...(await settle(page)) });
    }),
  );

  server.registerTool(
    'browser_assert',
    {
      title: 'Assert visible',
      description: 'Check whether the element at `ref` is visible. Returns { visible: true|false } — does not throw.',
      inputSchema: refSchema,
    },
    async ({ ref, tab }) => guard(async () => {
      const visible = await actions.assertVisible(await sessions.resolveLocator(ref, tab));
      return ok({ acted: 'assert', ref, tab: tab ?? 'active', visible });
    }),
  );

  server.registerTool(
    'browser_read',
    { title: 'Read text', description: 'Return the visible inner text of the element at `ref`.', inputSchema: refSchema },
    async ({ ref, tab }) => guard(async () => {
      const text = await actions.readText(await sessions.resolveLocator(ref, tab));
      return ok({ ref, tab: tab ?? 'active', text }, text);
    }),
  );

  // ─── harvest (generic, source-aware) ──────────────────────────────────────
  server.registerTool(
    'page_extract',
    {
      title: 'Extract the current page',
      description:
        'Harvest the (active or given) tab (or navigate to `url` first). If the URL belongs to a known job source ' +
        '(seek/linkedin/indeed/builtin) it returns a structured Job record extracted THROUGH the live session ' +
        '(anti-bot resilient — works on Indeed where a cold fetch is blocked). Otherwise it returns generic ' +
        '{ url, title, text } for ANY page. On a verification wall it returns needs_human_input + a screenshot: ' +
        'solve it in the open window, then call again.',
      inputSchema: {
        url: z.string().url().optional().describe('Navigate here first. Omit to harvest the page already loaded.'),
        reextract: z.boolean().optional().describe('For job sources: re-parse even if a record is cached.'),
        ...tabParam,
      },
    },
    async ({ url, reextract, tab }) =>
      guard(async () => {
        const page = await sessions.getPage(tab);
        if (url) {
          await actions.goto(page, url);
          await settle(page);
        }
        const currentUrl = page.url();

        const handoff = async (signal: string, extra: Record<string, unknown>) => {
          const msg =
            `Anti-bot verification ("${signal}") on ${currentUrl}. The live browser window is open — ` +
            `solve the challenge there, then call page_extract again.`;
          const data = { status: 'needs_human_input', kind: 'text', url: currentUrl, tab: tab ?? 'active', signal, ...extra };
          const shot = await sessions.screenshot(tab).catch(() => null);
          return shot
            ? withScreenshot(shot.toString('base64'), `NEEDS HUMAN INPUT (text): ${msg}`, data)
            : needsHumanInput(msg, 'text', data);
        };

        const challenge = await detectChallenge(page);
        if (challenge.challenged) return handoff(challenge.signal ?? 'verification', {});

        const source = detectSource(currentUrl);
        if (source) {
          const job = await source.extract(currentUrl, { reextract, page });
          if (textLooksLikeChallenge(job.title)) return handoff(job.title, { source: source.name });
          return ok({ mode: 'job', source: source.name, job }, `extracted ${job.jobId}: ${job.title}`);
        }

        const content = await readPageContent(page);
        return ok({ mode: 'generic', ...content }, `${content.title}\n<${content.url}>\n\n${content.text}`);
      }),
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot',
      description: 'Capture a JPEG of the (active or given) tab viewport (for visual disambiguation or to show the user).',
      inputSchema: { ...tabParam },
    },
    async ({ tab }) => guard(async () => {
      const buf = await sessions.screenshot(tab);
      return withScreenshot(buf.toString('base64'), `screenshot captured (tab ${tab ?? 'active'})`);
    }),
  );
}
