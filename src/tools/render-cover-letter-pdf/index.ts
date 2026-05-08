// render-cover-letter-pdf — load output/<slug>/cover_letter.json, fill
// cover-letter.html template, write cover_letter.pdf.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { applicationSlug } from '../../shared/slug.js';
import { createLogger } from '../../shared/logger.js';
import { escapeHtml, renderTemplate } from '../../shared/render/template.js';
import { loadTemplate, renderHtmlToPdf } from '../../shared/render/pdf.js';
import type { TailoredCoverLetter } from '../generate-cover-letter/types.js';

const log = createLogger('render-cover-letter-pdf');

function buildContactLine(c: TailoredCoverLetter['contact']): string {
  const parts = [c.email, c.phone, c.location, c.linkedinDisplay, c.portfolioDisplay]
    .filter(Boolean)
    .map((s) => escapeHtml(s ?? ''));
  return parts.join(' &nbsp;·&nbsp; ');
}

function buildRecipientBlock(text: string): string {
  return text
    .split('\n')
    .filter((s) => s.trim())
    .map((s) => `<div>${escapeHtml(s)}</div>`)
    .join('');
}

function buildBody(paragraphs: string[]): string {
  return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n  ');
}

export type RenderCoverLetterPdfOptions = {
  outPath?: string;
};

export async function renderCoverLetterPdf(jobId: string, opts: RenderCoverLetterPdfOptions = {}): Promise<string> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`render-cover-letter-pdf: ${jobId} not in DB.`);

  const outputDir = path.join(config.paths.applicationsDir, applicationSlug(job.company, job.title));
  const jsonPath = path.join(outputDir, 'cover_letter.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      `render-cover-letter-pdf: ${jsonPath} not found. Run \`career-ops generate-cover-letter ${jobId}\` first.`,
    );
  }
  const letter = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as TailoredCoverLetter;

  const template = loadTemplate('cover-letter.html');
  const html = renderTemplate(template, {
    NAME: escapeHtml(letter.name),
    COMPANY: escapeHtml(job.company ?? ''),
    CONTACT_LINE: buildContactLine(letter.contact),
    DATE: escapeHtml(letter.date),
    RECIPIENT_BLOCK: buildRecipientBlock(letter.recipientBlock),
    SALUTATION: escapeHtml(letter.salutation),
    BODY_PARAGRAPHS: buildBody(letter.bodyParagraphs),
    CLOSING: escapeHtml(letter.closing),
  });

  const outPath = opts.outPath ?? path.join(outputDir, 'cover_letter.pdf');
  await renderHtmlToPdf(html, { outPath });

  log.info({ jobId, outPath }, 'render-cover-letter-pdf: complete');
  return outPath;
}
