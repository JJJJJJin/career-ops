// SessionManager — the heart of "the server keeps state".
//
// Holds ONE live Playwright browser + context for the whole daemon, and N tabs
// (pages) inside that one context. All tabs share cookies/localStorage, so a
// single SEEK login covers every tab. This is what lets the agent keep a
// persistent resume-manager tab open on /profile/me/resume while a *separate*
// tab drives a job's apply wizard — managing resumes never clobbers an
// in-progress application, and vice versa.
//
// Launched lazily (first browser tool call) and closed after an idle timeout to
// spare RAM on a Raspberry Pi; cookies are persisted to storageState on close,
// so a logged-in SEEK session survives the close and is restored on relaunch.
// Each tab keeps its OWN most-recent perception snapshot, so a `ref` (snapshot
// index) resolves against the tab it was observed on.
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { launchSession, type BrowserSession } from '../shared/browser/session.js';
import { snapshotDom, screenshot as pageScreenshot } from '../shared/agent/perception.js';
import type { Snapshot, SnapshotNode } from '../shared/agent/types.js';
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('mcp:session');

/** The dedicated, persistent tab id used for SEEK resume management. */
export const RESUME_TAB = 'resume';

function idleMs(): number {
  const n = parseInt(process.env.MCP_BROWSER_IDLE_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 600_000; // 10 min default
}

/** One open tab: its live page plus the latest perception snapshot taken on it. */
type Tab = { id: string; page: Page; snapshot: Snapshot | null; label?: string };

export type TabInfo = { id: string; active: boolean; url: string; title: string; snapshotNodes: number; label?: string };

export type SessionStatus =
  | { open: false }
  | {
      open: true;
      headless: boolean;
      activeTab: string | null;
      tabCount: number;
      tabs: TabInfo[];
      // Back-compat mirror of the active tab (older callers/tests read these).
      url: string;
      title: string;
      snapshotNodes: number;
    };

export class SessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tabs = new Map<string, Tab>();
  private activeId: string | null = null;
  private launching: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private headless: boolean = config.browser.headless;
  private tabSeq = 0;

  get isOpen(): boolean {
    return this.context !== null;
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.info('idle timeout reached — closing browser session');
      void this.close('idle');
    }, idleMs());
    // Don't let the idle timer keep the daemon process alive on its own.
    this.idleTimer.unref?.();
  }

  /** Launch the browser+context if needed, with at least one tab. */
  private async ensureContext(opts: { headless?: boolean } = {}): Promise<void> {
    if (opts.headless !== undefined) this.headless = opts.headless;
    this.armIdle();
    if (this.context) return;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      log.info({ headless: this.headless }, 'launching browser session');
      const session = await launchSession({ headless: this.headless, storageStatePath: config.seek.authStatePath });
      this.browser = session.browser;
      this.context = session.context;
      // The context's first page becomes our first tab.
      const id = this.freshId();
      this.tabs.set(id, { id, page: session.page, snapshot: null });
      this.activeId = id;
      // If anything ever closes a page out from under us, drop it from the map.
      this.context.on('page', (p) => this.adopt(p));
    })();
    try {
      await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private freshId(): string {
    this.tabSeq += 1;
    return `tab-${this.tabSeq}`;
  }

  /** Track a page Playwright created on its own (e.g. target=_blank popups). */
  private adopt(page: Page): void {
    for (const t of this.tabs.values()) if (t.page === page) return; // already tracked
    const id = this.freshId();
    this.tabs.set(id, { id, page, snapshot: null });
    page.on('close', () => {
      this.tabs.delete(id);
      if (this.activeId === id) this.activeId = this.tabs.keys().next().value ?? null;
    });
    log.debug({ id }, 'adopted a new page');
  }

  /**
   * Compatibility shim: the legacy `ensure()` returned a BrowserSession whose
   * `.page` callers used directly. Now it returns the ACTIVE tab's page wrapped
   * in the same shape, so src/shared/seek/* keeps working unchanged.
   */
  async ensure(opts: { headless?: boolean } = {}): Promise<BrowserSession> {
    await this.ensureContext(opts);
    const tab = this.activeTab();
    return { browser: this.browser!, context: this.context!, page: tab.page };
  }

  /** Explicit (re)launch — used by session_open to force e.g. a headful window. */
  async open(opts: { headless?: boolean } = {}): Promise<SessionStatus> {
    if (this.context && opts.headless !== undefined && opts.headless !== this.headless) {
      await this.close('reopen');
    }
    await this.ensureContext(opts);
    return this.status();
  }

  private activeTab(): Tab {
    if (!this.activeId) throw new Error('no active tab — open the browser first');
    const t = this.tabs.get(this.activeId);
    if (!t) throw new Error(`active tab ${this.activeId} is gone — call tab_list`);
    return t;
  }

  /** Resolve a tab by id, defaulting to the active one. */
  private tab(tabId?: string): Tab {
    if (!tabId) return this.activeTab();
    const t = this.tabs.get(tabId);
    if (!t) throw new Error(`no tab "${tabId}" — call tab_list (open tabs: ${[...this.tabs.keys()].join(', ') || 'none'})`);
    return t;
  }

  /** The active (or given) tab's live page. Lazily launches the browser. */
  async getPage(tabId?: string): Promise<Page> {
    await this.ensureContext();
    this.armIdle();
    return this.tab(tabId).page;
  }

  // ─── tab lifecycle ────────────────────────────────────────────────────────

  /**
   * Open a new tab in the SAME context (shared login). If `id` is given and a
   * tab with that id already exists it is reused (idempotent — useful for the
   * persistent resume tab and per-job apply tabs). Optionally navigates to `url`
   * and makes the new tab active.
   */
  async openTab(opts: { id?: string; url?: string; label?: string; activate?: boolean } = {}): Promise<TabInfo> {
    await this.ensureContext();
    let tab: Tab;
    if (opts.id && this.tabs.has(opts.id)) {
      tab = this.tabs.get(opts.id)!;
      if (opts.label) tab.label = opts.label;
    } else {
      const page = await this.context!.newPage();
      const id = opts.id ?? this.freshId();
      tab = { id, page, snapshot: null, label: opts.label };
      this.tabs.set(id, tab);
      page.on('close', () => {
        this.tabs.delete(id);
        if (this.activeId === id) this.activeId = this.tabs.keys().next().value ?? null;
      });
    }
    if (opts.url) await tab.page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    if (opts.activate !== false) this.activeId = tab.id;
    this.armIdle();
    return this.tabInfo(tab);
  }

  /** Get-or-create the persistent resume-management tab. Never activated by default. */
  async ensureResumeTab(): Promise<BrowserSession> {
    await this.openTab({ id: RESUME_TAB, label: 'resume manager', activate: false });
    return { browser: this.browser!, context: this.context!, page: this.tabs.get(RESUME_TAB)!.page };
  }

  switchTab(tabId: string): TabInfo {
    const t = this.tab(tabId);
    this.activeId = t.id;
    this.armIdle();
    return this.tabInfo(t);
  }

  async closeTab(tabId: string): Promise<{ closed: string; activeTab: string | null }> {
    const t = this.tab(tabId);
    this.tabs.delete(t.id);
    if (this.activeId === t.id) this.activeId = this.tabs.keys().next().value ?? null;
    await t.page.close().catch(() => {});
    return { closed: t.id, activeTab: this.activeId };
  }

  private tabInfo(t: Tab): TabInfo {
    let url = '';
    let title = '';
    try {
      url = t.page.url();
    } catch {
      /* mid-navigation */
    }
    return { id: t.id, active: t.id === this.activeId, url, title, snapshotNodes: t.snapshot?.nodes.length ?? 0, label: t.label };
  }

  async listTabs(): Promise<TabInfo[]> {
    const out: TabInfo[] = [];
    for (const t of this.tabs.values()) {
      const info = this.tabInfo(t);
      try {
        info.title = await t.page.title();
      } catch {
        /* mid-navigation */
      }
      out.push(info);
    }
    return out;
  }

  // ─── perceive / act (per-tab) ─────────────────────────────────────────────

  /** Perceive: snapshot the (active or given) tab, store it on that tab, return it. */
  async observe(tabId?: string): Promise<Snapshot> {
    const tab = this.tab(tabId);
    await this.ensureContext();
    this.armIdle();
    const snap = await snapshotDom(tab.page);
    tab.snapshot = snap;
    return snap;
  }

  /** The node behind a ref from the (active or given) tab's latest snapshot. */
  node(ref: number, tabId?: string): SnapshotNode {
    const tab = this.tab(tabId);
    if (!tab.snapshot) throw new Error(`no snapshot yet on tab "${tab.id}" — call browser_observe first`);
    const n = tab.snapshot.nodes[ref];
    if (!n) {
      throw new Error(
        `ref ${ref} is not in tab "${tab.id}"'s latest snapshot (it has ${tab.snapshot.nodes.length} nodes) — call browser_observe again`,
      );
    }
    return n;
  }

  /**
   * Resolve a ref to a live Locator on the right tab. data-agent-ref is
   * bulletproof for the tick it was set; if it's gone (the page re-rendered
   * since the observe), fall back to the node's stable selector.
   */
  async resolveLocator(ref: number, tabId?: string): Promise<Locator> {
    const tab = this.tab(tabId);
    const node = this.node(ref, tabId);
    const tagged = tab.page.locator(`[data-agent-ref="${ref}"]`).first();
    if ((await tagged.count()) > 0) return tagged;
    return tab.page.locator(node.locator).first();
  }

  async screenshot(tabId?: string): Promise<Buffer> {
    const tab = this.tab(tabId);
    await this.ensureContext();
    return pageScreenshot(tab.page);
  }

  async status(): Promise<SessionStatus> {
    if (!this.context) return { open: false };
    const tabs = await this.listTabs();
    const active = tabs.find((t) => t.active);
    return {
      open: true,
      headless: this.headless,
      activeTab: this.activeId,
      tabCount: tabs.length,
      tabs,
      url: active?.url ?? '',
      title: active?.title ?? '',
      snapshotNodes: active?.snapshotNodes ?? 0,
    };
  }

  async close(reason = 'explicit'): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const browser = this.browser;
    const context = this.context;
    this.tabs.clear();
    this.activeId = null;
    this.browser = null;
    this.context = null;
    if (!context || !browser) return;
    // Persist cookies so a logged-in session survives the close/relaunch.
    try {
      await context.storageState({ path: config.seek.authStatePath });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'storage-state save failed on close');
    }
    try {
      await context.close();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'context close failed');
    }
    try {
      await browser.close();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'browser close failed');
    }
    log.info({ reason }, 'browser session closed');
  }
}

/** Process-wide singleton — the live state the MCP daemon holds. */
export const sessions = new SessionManager();
