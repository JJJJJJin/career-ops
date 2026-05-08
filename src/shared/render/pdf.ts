// Render an HTML string to a PDF on disk via Playwright. The HTML may
// reference local fonts/assets — we serve it from a temp file in `cwd` so
// relative URLs (../fonts/...) resolve.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withBrowser } from '../browser/session.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('pdf');

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
      await page.emulateMedia({ media: 'print' });
      await page.pdf({
        path: opts.outPath,
        format: opts.format ?? 'A4',
        margin: { top: margin, right: margin, bottom: margin, left: margin },
        printBackground: true,
      });
    });
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

export function loadTemplate(name: 'resume.html' | 'cover-letter.html'): string {
  return fs.readFileSync(path.join(config.paths.templatesDir, name), 'utf-8');
}
