// L2 — perception. Turns the live page into a small, ref-tagged list the
// resolver can reason over cheaply. Two jobs:
//   1. Prune the DOM to interactive + a little context (headings), capped, so
//      prompts stay tiny — the main token/RAM lever on a Raspberry Pi.
//   2. Tag each kept element with data-agent-ref="N" (bulletproof for *this*
//      tick) AND compute a *stable* selector to persist in the selector cache.
import type { Page } from 'playwright';
import { createLogger } from '../logger.js';
import type { NodeKind, Snapshot, SnapshotNode } from './types.js';

const log = createLogger('agent:perception');

export type SnapshotOptions = {
  /** Hard cap on nodes sent to the resolver. Interactive ones win ties. */
  maxNodes?: number;
  /** Truncate accessible names to keep the prompt small. */
  maxNameLen?: number;
};

// djb2 — tiny, stable string hash for the page signature.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Raw shape returned from the in-page evaluate (kept structurally serialisable). */
type RawNode = Omit<SnapshotNode, 'ref' | 'kind'> & { kind: string; dataAutomation: string | null };

export async function snapshotDom(page: Page, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const maxNodes = opts.maxNodes ?? 120;
  const maxNameLen = opts.maxNameLen ?? 120;

  // tsx/esbuild wraps named functions with a __name() helper; when this
  // evaluate's body is serialised into the page, that helper isn't defined.
  // A string-form evaluate (not transformed) shims it. Re-run each tick so it
  // survives navigations (each new document is a fresh global scope).
  await page
    .evaluate('globalThis.__name = globalThis.__name || function (f) { return f; };')
    .catch(() => {});

  const raw = await page.evaluate(
    ({ maxNodes, maxNameLen }) => {
      const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
      const INTERACTIVE_ROLES = new Set([
        'button', 'link', 'checkbox', 'radio', 'tab', 'option', 'menuitem', 'combobox', 'switch', 'textbox',
      ]);

      const isVisible = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      };

      const trunc = (s: string): string => {
        const t = s.replace(/\s+/g, ' ').trim();
        return t.length > maxNameLen ? t.slice(0, maxNameLen) + '…' : t;
      };

      const accessibleName = (el: Element): string => {
        const aria = el.getAttribute('aria-label');
        if (aria) return trunc(aria);
        const labelledby = el.getAttribute('aria-labelledby');
        if (labelledby) {
          const txt = labelledby
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ');
          if (txt.trim()) return trunc(txt);
        }
        const id = el.getAttribute('id');
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl?.textContent?.trim()) return trunc(lbl.textContent);
        }
        const wrapLabel = el.closest('label');
        if (wrapLabel?.textContent?.trim()) return trunc(wrapLabel.textContent);
        const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
        if (text.trim()) return trunc(text);
        const ph = el.getAttribute('placeholder');
        if (ph) return trunc(ph);
        const val = (el as HTMLInputElement).value;
        if (val) return trunc(val);
        const title = el.getAttribute('title');
        if (title) return trunc(title);
        return '';
      };

      const isUnique = (sel: string): boolean => {
        try {
          return document.querySelectorAll(sel).length === 1;
        } catch {
          return false;
        }
      };

      // Stable selector preference: data-automation → id → name → structural path.
      const stableSelector = (el: Element): string => {
        const da = el.getAttribute('data-automation');
        if (da) {
          const sel = `[data-automation="${da}"]`;
          if (isUnique(sel)) return sel;
        }
        const id = el.getAttribute('id');
        if (id && /^[A-Za-z][\w-]*$/.test(id)) {
          const sel = `#${CSS.escape(id)}`;
          if (isUnique(sel)) return sel;
        }
        const name = el.getAttribute('name');
        if (name) {
          const sel = `${el.tagName.toLowerCase()}[name="${name}"]`;
          if (isUnique(sel)) return sel;
        }
        // Fallback: nth-of-type path from the nearest id-anchored ancestor.
        const parts: string[] = [];
        let node: Element | null = el;
        while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
          const tag = node.tagName.toLowerCase();
          const parent: Element | null = node.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          const idx = sameTag.indexOf(node) + 1;
          parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
          const pid = parent.getAttribute('id');
          if (pid && /^[A-Za-z][\w-]*$/.test(pid)) {
            parts.unshift(`#${CSS.escape(pid)}`);
            break;
          }
          node = parent;
        }
        return parts.join(' > ');
      };

      const classify = (el: Element): { kind: string; interactive: boolean } => {
        const tag = el.tagName;
        const role = el.getAttribute('role');
        const type = (el.getAttribute('type') ?? '').toLowerCase();
        if (tag === 'BUTTON' || role === 'button') return { kind: 'button', interactive: true };
        if (tag === 'A' || role === 'link') return { kind: 'link', interactive: true };
        if (tag === 'SELECT' || role === 'combobox') return { kind: 'select', interactive: true };
        if (tag === 'TEXTAREA' || role === 'textbox') return { kind: 'textarea', interactive: true };
        if (tag === 'INPUT') {
          if (type === 'checkbox') return { kind: 'checkbox', interactive: true };
          if (type === 'radio') return { kind: 'radio', interactive: true };
          return { kind: 'input', interactive: true };
        }
        if (role === 'checkbox') return { kind: 'checkbox', interactive: true };
        if (role === 'radio') return { kind: 'radio', interactive: true };
        if (/^H[1-3]$/.test(tag)) return { kind: 'heading', interactive: false };
        return { kind: 'other', interactive: true };
      };

      const candidates = Array.from(
        document.querySelectorAll(
          'a, button, input, select, textarea, summary, h1, h2, h3, [role], [data-automation], [onclick], [tabindex]',
        ),
      );

      type Raw = {
        kind: string;
        tag: string;
        interactive: boolean;
        name: string;
        role: string | undefined;
        type: string | undefined;
        placeholder: string | undefined;
        value: string | undefined;
        locator: string;
        dataAutomation: string | null;
      };

      const seen = new Set<Element>();
      const out: Raw[] = [];
      for (const el of candidates) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isVisible(el)) continue;
        const role = el.getAttribute('role') ?? undefined;
        const tag = el.tagName;
        const isInteractiveTag =
          INTERACTIVE_TAGS.has(tag) ||
          (role ? INTERACTIVE_ROLES.has(role) : false) ||
          el.hasAttribute('onclick') ||
          el.hasAttribute('tabindex');
        const isHeading = /^H[1-3]$/.test(tag);
        const hasDataAutomation = el.hasAttribute('data-automation');
        if (!isInteractiveTag && !isHeading && !hasDataAutomation) continue;

        const name = accessibleName(el);
        // Drop nameless non-interactive context nodes — they add tokens, no value.
        const { kind, interactive } = classify(el);
        if (!interactive && !name) continue;

        out.push({
          kind,
          tag: tag.toLowerCase(),
          interactive,
          name,
          role,
          type: el.getAttribute('type') ?? undefined,
          placeholder: el.getAttribute('placeholder') ?? undefined,
          value: (el as HTMLInputElement).value || undefined,
          locator: stableSelector(el),
          dataAutomation: el.getAttribute('data-automation'),
        });
      }

      // Cap: keep all interactive, then fill remaining budget with headings/context.
      const interactive = out.filter((n) => n.interactive);
      const context = out.filter((n) => !n.interactive);
      const kept = interactive.slice(0, maxNodes);
      for (const n of context) {
        if (kept.length >= maxNodes) break;
        kept.push(n);
      }

      // Tag the kept elements so L1 can locate them this tick with certainty.
      // Re-resolve from the same selectors used to build the list.
      kept.forEach((n, i) => {
        const el = document.querySelector(n.locator);
        if (el) el.setAttribute('data-agent-ref', String(i));
      });

      return {
        url: location.href,
        title: document.title,
        nodes: kept,
        dataAutomations: kept.map((n) => n.dataAutomation).filter(Boolean) as string[],
      };
    },
    { maxNodes, maxNameLen },
  );

  const nodes: SnapshotNode[] = raw.nodes.map((n: RawNode, i: number) => ({
    ref: i,
    kind: n.kind as NodeKind,
    tag: n.tag,
    interactive: n.interactive,
    name: n.name,
    role: n.role,
    type: n.type,
    placeholder: n.placeholder,
    value: n.value,
    locator: n.locator,
  }));

  // Signature: normalized path (digits → '#') + sorted data-automation set + title.
  const normUrl = raw.url.replace(/\d+/g, '#').split('?')[0];
  const sig = hash(`${normUrl}|${[...raw.dataAutomations].sort().join(',')}|${raw.title}`);

  log.debug({ url: raw.url, nodes: nodes.length, sig }, 'snapshot');
  return { url: raw.url, title: raw.title, signature: sig, nodes };
}

/** A compact, ref-tagged element listing for the resolver prompt. */
export function renderNodesForPrompt(nodes: SnapshotNode[]): string {
  return nodes
    .map((n) => {
      const attrs = [
        n.role ? `role=${n.role}` : '',
        n.type ? `type=${n.type}` : '',
        n.interactive ? '' : 'context',
      ]
        .filter(Boolean)
        .join(' ');
      const name = n.name ? ` "${n.name}"` : '';
      return `[${n.ref}] ${n.tag}${attrs ? ` (${attrs})` : ''}${name}`;
    })
    .join('\n');
}

/** Downscaled screenshot for vision resolvers. Stubbed path uses it later. */
export async function screenshot(page: Page): Promise<Buffer> {
  return page.screenshot({ type: 'jpeg', quality: 60 });
}
