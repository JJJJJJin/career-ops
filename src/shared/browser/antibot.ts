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
 * Generic, source-agnostic read of the current live page: URL, title, and the
 * main visible text. This is the "open ANY page and harvest it" primitive —
 * used by the MCP page_extract tool when no platform adapter claims the URL.
 */
export async function readPageContent(page: Page, maxChars = 20_000): Promise<PageContent> {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const text = await page
    .evaluate((cap) => {
      const main =
        document.querySelector('main') ??
        document.querySelector('article') ??
        document.querySelector('[role="main"]') ??
        document.body;
      return (main as HTMLElement | null)?.innerText?.slice(0, cap) ?? '';
    }, maxChars)
    .catch(() => '');
  return { url, title, text };
}
