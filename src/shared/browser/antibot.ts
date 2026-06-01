// Anti-bot / verification interstitials + generic page reading.
//
// Strict HTTP scraping and cold headless launches trip Cloudflare / "verify you
// are human" walls (this is exactly why Indeed extraction fails from a throwaway
// browser but succeeds on the warmed-up live MCP session). These helpers let the
// agent-driven layer DETECT such a wall and hand off to the human — the live
// browser stays open server-side while the user clicks through the challenge,
// then the same call is retried.
import type { Page } from 'playwright';

/** Phrases that betray an anti-bot / verification interstitial rather than content. */
const CHALLENGE_RE =
  /additional verification required|verify(?:ing)? (?:you are|that you are|you're) (?:a )?human|are you a (?:human|robot)|just a moment|checking your browser|attention required|cloudflare|press (?:and|&) hold|complete the (?:security )?check|enable javascript and cookies|unusual traffic|access denied|/i;

/** Does this text look like a bot-challenge wall? (Title + a slice of body text.) */
export function textLooksLikeChallenge(text: string): boolean {
  // The trailing empty alternative in CHALLENGE_RE would match everything, so
  // guard against it: require a non-empty, reasonably short hostile signal.
  const m = text.match(CHALLENGE_RE);
  return Boolean(m && m[0] && m[0].length > 2);
}

export type ChallengeCheck = { challenged: boolean; signal?: string };

/**
 * Inspect the LIVE page for a verification interstitial. Cheap + best-effort:
 * reads the title and the first ~3k chars of body text. Never throws.
 */
export async function detectChallenge(page: Page): Promise<ChallengeCheck> {
  try {
    const title = await page.title().catch(() => '');
    const bodyText = await page
      .evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '')
      .catch(() => '');
    const hay = `${title}\n${bodyText}`;
    const m = hay.match(CHALLENGE_RE);
    if (m && m[0] && m[0].length > 2) return { challenged: true, signal: m[0] };
    return { challenged: false };
  } catch {
    return { challenged: false };
  }
}

export type PageContent = { url: string; title: string; text: string };

/**
 * Generic, source-agnostic read of the current live page: URL, title, and a
 * distilled semantic outline. Produces a compact heading + excerpt structure
 * (~2-4 K chars) instead of raw innerText, keeping the model prompt small.
 * Falls back to truncated raw text if distillation yields too little content.
 */
export async function readPageContent(page: Page, maxChars = 6_000): Promise<PageContent> {
  const url = page.url();
  const title = await page.title().catch(() => '');

  const text = await page
    .evaluate((cap) => {
      const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'NAV', 'FOOTER']);
      const HEADING = /^H[1-4]$/;
      const BLOCK = new Set(['P', 'LI', 'BLOCKQUOTE', 'DT', 'DD', 'FIGCAPTION', 'CAPTION', 'TD', 'TH']);

      const isVisible = (el: Element): boolean => {
        const s = (el as HTMLElement).style;
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const root =
        document.querySelector('main') ??
        document.querySelector('[role="main"]') ??
        document.querySelector('article') ??
        document.body;

      const parts: string[] = [];
      let chars = 0;
      const visited = new Set<Element>();

      const visit = (el: Element): void => {
        if (chars >= cap || visited.has(el) || !isVisible(el)) return;
        visited.add(el);
        const tag = (el as HTMLElement).tagName;
        if (SKIP.has(tag)) return;

        if (HEADING.test(tag)) {
          const text = (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '';
          if (text) {
            const level = parseInt(tag[1], 10);
            const line = '#'.repeat(level) + ' ' + text.slice(0, 140);
            parts.push(line);
            chars += line.length + 1;
          }
          return;
        }

        if (BLOCK.has(tag)) {
          const text = (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '';
          if (text.length > 8) {
            const excerpt = text.slice(0, 280);
            parts.push(excerpt);
            chars += excerpt.length + 1;
          }
          return;
        }

        for (const child of Array.from(el.children)) {
          if (chars >= cap) break;
          visit(child as Element);
        }
      };

      visit(root as Element);
      return parts.join('\n');
    }, maxChars)
    .catch(() => '');

  // Distillation can return empty on JS-heavy SPAs; fall back to raw text.
  if (text.length < 100) {
    const raw = await page
      .evaluate(() => {
        const el =
          document.querySelector('main') ??
          document.querySelector('[role="main"]') ??
          document.querySelector('article') ??
          document.body;
        return (el as HTMLElement | null)?.innerText?.slice(0, 6_000) ?? '';
      })
      .catch(() => '');
    return { url, title, text: raw };
  }

  return { url, title, text };
}
