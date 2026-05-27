// SessionManager — the heart of "the server keeps state".
//
// Holds ONE live Playwright session for the whole daemon. It is launched lazily
// (first browser tool call) and closed after an idle timeout to spare RAM on a
// Raspberry Pi; cookies are persisted to storageState on close, so a logged-in
// SEEK session survives the close and is restored on relaunch. The most recent
// perception snapshot is kept here so atomic action tools can resolve a `ref`
// (snapshot index) back to a live element.
import type { Locator, Page } from 'playwright';
import { closeSession, launchSession, saveStorageState, type BrowserSession } from '../shared/browser/session.js';
import { snapshotDom, screenshot as pageScreenshot } from '../shared/agent/perception.js';
import type { Snapshot, SnapshotNode } from '../shared/agent/types.js';
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('mcp:session');

function idleMs(): number {
  const n = parseInt(process.env.MCP_BROWSER_IDLE_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 600_000; // 10 min default
}

export type SessionStatus =
  | { open: false }
  | { open: true; headless: boolean; url: string; title: string; snapshotNodes: number; snapshotUrl?: string };

export class SessionManager {
  private session: BrowserSession | null = null;
  private snapshot: Snapshot | null = null;
  private launching: Promise<BrowserSession> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private headless: boolean = config.browser.headless;

  get isOpen(): boolean {
    return this.session !== null;
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

  /** Get (lazily launching) the live session. `headless` only applies on launch. */
  async ensure(opts: { headless?: boolean } = {}): Promise<BrowserSession> {
    if (opts.headless !== undefined) this.headless = opts.headless;
    this.armIdle();
    if (this.session) return this.session;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      log.info({ headless: this.headless }, 'launching browser session');
      return launchSession({ headless: this.headless, storageStatePath: config.seek.authStatePath });
    })();
    try {
      this.session = await this.launching;
      return this.session;
    } finally {
      this.launching = null;
    }
  }

  /** Explicit (re)launch — used by session_open to force e.g. a headful window. */
  async open(opts: { headless?: boolean } = {}): Promise<SessionStatus> {
    if (this.session && opts.headless !== undefined && opts.headless !== this.headless) {
      await this.close('reopen');
    }
    await this.ensure(opts);
    return this.status();
  }

  async getPage(): Promise<Page> {
    const s = await this.ensure();
    this.armIdle();
    return s.page;
  }

  /** Perceive: snapshot the live page, store it, return it (ref-tagged). */
  async observe(): Promise<Snapshot> {
    const page = await this.getPage();
    const snap = await snapshotDom(page);
    this.snapshot = snap;
    return snap;
  }

  /** The node behind a ref from the latest snapshot. */
  node(ref: number): SnapshotNode {
    if (!this.snapshot) throw new Error('no snapshot yet — call browser_observe first');
    const n = this.snapshot.nodes[ref];
    if (!n) {
      throw new Error(
        `ref ${ref} is not in the latest snapshot (it has ${this.snapshot.nodes.length} nodes) — call browser_observe again`,
      );
    }
    return n;
  }

  /**
   * Resolve a ref to a live Locator. data-agent-ref is bulletproof for the tick
   * it was set; if it's gone (the page navigated/re-rendered since the observe),
   * fall back to the node's stable selector. If neither resolves, the caller
   * should re-observe.
   */
  async resolveLocator(ref: number): Promise<Locator> {
    const page = await this.getPage();
    const node = this.node(ref);
    const tagged = page.locator(`[data-agent-ref="${ref}"]`).first();
    if ((await tagged.count()) > 0) return tagged;
    return page.locator(node.locator).first();
  }

  async screenshot(): Promise<Buffer> {
    const page = await this.getPage();
    return pageScreenshot(page);
  }

  async status(): Promise<SessionStatus> {
    if (!this.session) return { open: false };
    let url = '';
    let title = '';
    try {
      url = this.session.page.url();
      title = await this.session.page.title();
    } catch {
      /* page may be mid-navigation */
    }
    return {
      open: true,
      headless: this.headless,
      url,
      title,
      snapshotNodes: this.snapshot?.nodes.length ?? 0,
      snapshotUrl: this.snapshot?.url,
    };
  }

  async close(reason = 'explicit'): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const s = this.session;
    this.session = null;
    this.snapshot = null;
    if (!s) return;
    // Persist cookies so a logged-in session survives the close/relaunch.
    try {
      await saveStorageState(s, config.seek.authStatePath);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'storage-state save failed on close');
    }
    await closeSession(s);
    log.info({ reason }, 'browser session closed');
  }
}

/** Process-wide singleton — the live state the MCP daemon holds. */
export const sessions = new SessionManager();
