// render-company-brief-pdf — load output/<slug>/company_brief.json, fill
// company-brief.html template, write company_brief.pdf via Playwright.
//
// Same shape as render-resume-pdf / render-cover-letter-pdf so apply-job
// can chain them uniformly.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { applicationSlug } from '../../shared/slug.js';
import { createLogger } from '../../shared/logger.js';
import { escapeHtml, inlineMd, renderTemplate } from '../../shared/render/template.js';
import { loadTemplate, renderHtmlToPdf } from '../../shared/render/pdf.js';

const log = createLogger('render-company-brief-pdf');

type CompanyBrief = {
  companyOneLiner: string;
  whatTheyDo: string;
  productsOrServices: string[];
  industryAndMarket: string;
  cultureAndValues: string;
  positionContext: string;
  thingsToVerify: string[];
};

function paragraphBlock(title: string, text: string): string {
  if (!text || !text.trim()) return '';
  return `<div class="section">
    <div class="section-title">${escapeHtml(title)}</div>
    <p>${inlineMd(text)}</p>
  </div>`;
}

function listBlock(title: string, items: string[], extraClass = ''): string {
  if (!items.length) return '';
  const lis = items.map((i) => `<li>${inlineMd(i)}</li>`).join('\n      ');
  return `<div class="section">
    <div class="section-title">${escapeHtml(title)}</div>
    <ul class="${extraClass}">
      ${lis}
    </ul>
  </div>`;
}

function buildOneLiner(text: string): string {
  if (!text || !text.trim()) return '';
  return `<div class="oneliner">${inlineMd(text)}</div>`;
}

export type RenderCompanyBriefPdfOptions = {
  /** Override output path. By default writes company_brief.pdf next to company_brief.json. */
  outPath?: string;
};

export async function renderCompanyBriefPdf(jobId: string, opts: RenderCompanyBriefPdfOptions = {}): Promise<string> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`render-company-brief-pdf: ${jobId} not in DB.`);

  const outputDir = path.join(config.paths.applicationsDir, applicationSlug(job.company, job.title));
  const jsonPath = path.join(outputDir, 'company_brief.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      `render-company-brief-pdf: ${jsonPath} not found. Run \`career-ops generate-company-brief ${jobId}\` first.`,
    );
  }
  const brief = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as CompanyBrief;

  const template = loadTemplate('company-brief.html');
  const html = renderTemplate(template, {
    COMPANY: escapeHtml(job.company ?? 'Company brief'),
    ROLE: escapeHtml(job.title),
    ONELINER_BLOCK: buildOneLiner(brief.companyOneLiner),
    WHAT_BLOCK: paragraphBlock('What they do', brief.whatTheyDo),
    PRODUCTS_BLOCK: listBlock('Products / services', brief.productsOrServices),
    INDUSTRY_BLOCK: paragraphBlock('Industry & market', brief.industryAndMarket),
    CULTURE_BLOCK: paragraphBlock('Culture & values', brief.cultureAndValues),
    POSITION_BLOCK: paragraphBlock('This role in context', brief.positionContext),
    VERIFY_BLOCK: listBlock('Things to verify', brief.thingsToVerify, 'verify'),
  });

  const outPath = opts.outPath ?? path.join(outputDir, 'company_brief.pdf');
  await renderHtmlToPdf(html, { outPath });

  log.info({ jobId, outPath }, 'render-company-brief-pdf: complete');
  return outPath;
}
