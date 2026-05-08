// web-distill — fetch any URL, run Mozilla Readability + sanitize-html,
// return clean markdown. Used for company-brief grounding so we don't burn
// tokens on chrome/nav/footer DOM.
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import sanitizeHtml from 'sanitize-html';
import { withBrowser } from '../../shared/browser/session.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('web-distill');

export type DistillResult = {
  url: string;
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  /** Plain text (no HTML, no markdown formatting). Suitable for raw token-count optimization. */
  text: string;
  /** Markdown with headings/lists preserved where possible. */
  markdown: string;
  /** Whether Readability succeeded. If false, we fell back to body text. */
  isReaderable: boolean;
};

export type DistillOptions = {
  /** If true, render with Playwright (handles SPAs). Otherwise use plain fetch. */
  jsRender?: boolean;
  /** Timeout in ms for the fetch/navigation. Default 30s. */
  timeoutMs?: number;
};

const SAFE_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr',
  'ul', 'ol', 'li',
  'strong', 'em', 'b', 'i', 'u',
  'blockquote', 'pre', 'code',
  'a',
] as const;

function htmlToMarkdown(html: string): string {
  const cleaned = sanitizeHtml(html, {
    allowedTags: [...SAFE_TAGS],
    allowedAttributes: { a: ['href'] },
  });

  return cleaned
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n')
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n')
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, '*$2*')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<\/?(p|div|br|hr)[^>]*>/gi, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchHtml(url: string, opts: DistillOptions): Promise<string> {
  if (opts.jsRender) {
    return withBrowser(async ({ page }) => {
      await page.goto(url, { waitUntil: 'networkidle', timeout: opts.timeoutMs ?? 30_000 });
      return page.content();
    });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function webDistill(url: string, opts: DistillOptions = {}): Promise<DistillResult> {
  log.info({ url, jsRender: !!opts.jsRender }, 'web-distill: fetching');
  const html = await fetchHtml(url, opts);

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (article && article.content) {
    log.info(
      { url, title: article.title, textChars: article.textContent?.length ?? 0 },
      'web-distill: readability success',
    );
    return {
      url,
      title: article.title ?? null,
      byline: article.byline ?? null,
      excerpt: article.excerpt ?? null,
      text: (article.textContent ?? '').trim(),
      markdown: htmlToMarkdown(article.content),
      isReaderable: true,
    };
  }

  // Fallback: strip whole-page HTML.
  log.warn({ url }, 'web-distill: readability empty, using body fallback');
  const body = dom.window.document.body?.innerHTML ?? '';
  const markdown = htmlToMarkdown(body);
  const text = dom.window.document.body?.textContent?.trim() ?? '';
  const titleEl = dom.window.document.querySelector('title');

  return {
    url,
    title: titleEl?.textContent?.trim() ?? null,
    byline: null,
    excerpt: null,
    text,
    markdown,
    isReaderable: false,
  };
}
