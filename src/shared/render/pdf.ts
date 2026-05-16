// Render an HTML string to a PDF on disk via Playwright. The HTML may
// reference local fonts/assets — we serve it from a temp file in `cwd` so
// relative URLs (../fonts/...) resolve.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Page } from 'playwright';
import { withBrowser } from '../browser/session.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('pdf');

// Make headless-Chromium text rasterization deterministic across hosts.
// Without these, the Pi's FreeType build mis-computes variable-font glyph
// advances and injects phantom spaces inside words; macOS Chrome's CoreText
// path hides the same bug. These flags pin the simple, platform-stable path.
const FONT_RENDER_ARGS = [
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--disable-font-subpixel-positioning',
  '--force-color-profile=srgb',
];

export type PdfOptions = {
  /** Output path. Parent dir is created if missing. */
  outPath: string;
  /** Format. Defaults to A4. */
  format?: 'A4' | 'Letter';
  /** Top margin in mm. Defaults to 12. */
  marginMm?: number;
};

/**
 * Render `html` to a PDF. The HTML is written to a temp file inside the
 * repo's templates/ folder so its relative `../fonts/...` references load
 * during page rendering.
 */
export async function renderHtmlToPdf(html: string, opts: PdfOptions): Promise<string> {
  const margin = `${opts.marginMm ?? 12}mm`;
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });

  // Write HTML next to templates/ so font URLs (../fonts/*.woff2) resolve.
  const tmpName = `.render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  const tmpPath = path.join(config.paths.templatesDir, tmpName);
  fs.writeFileSync(tmpPath, html, 'utf-8');

  try {
    log.debug({ tmpPath, outPath: opts.outPath }, 'pdf: rendering');
    await withBrowser(async ({ page }) => {
      await page.goto('file://' + tmpPath, { waitUntil: 'networkidle' });
      // Switch to print media *before* forcing fonts so they load under
      // the same layout we snapshot.
      await page.emulateMedia({ media: 'print' });
      await waitForFontsReady(page, config.render.fontTimeoutMs);
      // Even after fonts report loaded, a slow host needs a beat to finish
      // the print-media reflow/paint before we capture.
      await page.waitForTimeout(config.render.settleMs);
      await page.pdf({
        path: opts.outPath,
        format: opts.format ?? 'A4',
        margin: { top: margin, right: margin, bottom: margin, left: margin },
        printBackground: true,
      });
    }, { args: FONT_RENDER_ARGS });
    log.info({ outPath: opts.outPath }, 'pdf: written');
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // If the OS denied us, leave it; tmpPath has a unique name.
      void os;
    }
  }
  return opts.outPath;
}

/**
 * Block until every declared webfont is genuinely loaded and the layout has
 * reflowed with the real glyph metrics.
 *
 * `document.fonts.ready` alone is unreliable on slow hosts: Chromium only
 * fetches an `@font-face` file when a glyph in its `unicode-range` is first
 * needed, so the promise can resolve before the variable woff2 is in and the
 * print reflow has run — leaving the PDF with cramped fallback metrics. Here
 * we force *every* face to fetch up front, wait for the set to truly report
 * loaded (bounded), then flush a reflow + two frames so the paint lands.
 */
async function waitForFontsReady(page: Page, timeoutMs: number): Promise<void> {
  const loaded = await page.evaluate(async (timeout) => {
    // load() ignores unicode-range and downloads the whole face, so this
    // guarantees both the latin and latin-ext woff2 are fetched now.
    const faces = Array.from(document.fonts);
    await Promise.all(
      faces.map((f) =>
        f.status === 'loaded' ? Promise.resolve() : f.load().then(() => undefined, () => undefined),
      ),
    );
    try {
      await document.fonts.load("400 11px 'DM Sans'");
    } catch {
      /* resolved stack may differ on hosts with system fonts; ignore */
    }
    await document.fonts.ready;

    const start = Date.now();
    while (document.fonts.status !== 'loaded') {
      if (Date.now() - start > timeout) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Force layout to pick up real metrics, then wait two frames so the
    // post-reflow paint has actually happened before the snapshot.
    void document.body.offsetHeight;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return true;
  }, timeoutMs);

  if (!loaded) {
    log.warn(
      { timeoutMs },
      'pdf: webfonts did not report loaded before timeout; PDF may use fallback metrics',
    );
  }
}

export function loadTemplate(name: 'resume.html' | 'cover-letter.html' | 'company-brief.html'): string {
  return fs.readFileSync(path.join(config.paths.templatesDir, name), 'utf-8');
}
