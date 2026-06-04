// render-resume-pdf — load output/<source>/<slug>/<slug>-resume.json, fill
// the resume.html template, write <slug>-resume.pdf via Playwright.
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../../shared/db/store.js';
import { applicationDir, artefactBase } from '../../shared/slug.js';
import { createLogger } from '../../shared/logger.js';
import { escapeHtml, inlineMd, renderTemplate } from '../../shared/render/template.js';
import { loadTemplate, renderHtmlToPdf } from '../../shared/render/pdf.js';
import type { TailoredResume } from '../assemble-resume/types.js';

const log = createLogger('render-resume-pdf');

function buildContactRow(c: TailoredResume['contact']): string {
  // Left-aligned classic header: line 1 = location | email | phone,
  // line 2 = linkedin | github | portfolio, then a bold work-rights line.
  const link = (href: string, text: string) => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
  const line1 = [
    c.location ? escapeHtml(c.location) : null,
    c.email ? link(`mailto:${c.email}`, c.email) : null,
    c.phone ? escapeHtml(c.phone) : null,
  ].filter(Boolean).join('  |  ');
  const line2 = [
    c.linkedinUrl ? link(c.linkedinUrl, c.linkedinDisplay ?? c.linkedinUrl.replace(/^https?:\/\//, '')) : null,
    c.github ? link(c.github, c.github.replace(/^https?:\/\//, '')) : null,
    c.portfolioUrl ? link(c.portfolioUrl, c.portfolioDisplay ?? c.portfolioUrl.replace(/^https?:\/\//, '')) : null,
  ].filter(Boolean).join('  |  ');

  const parts: string[] = [];
  if (line1) parts.push(`<span class="contact-line">${line1}</span>`);
  if (line2) parts.push(`<span class="contact-line">${line2}</span>`);
  if (c.workRights) parts.push(`<span class="work-rights">${escapeHtml(c.workRights)}</span>`);
  return parts.join('');
}

function buildSummary(r: TailoredResume): string {
  if (!r.summary) return '';
  return `<div class="section">
    <div class="section-title">Summary</div>
    <div class="summary-text">${inlineMd(r.summary)}</div>
  </div>`;
}

function buildCompetencies(r: TailoredResume): string {
  if (!r.competencies.length) return '';
  // Classic-resume style: a single inline line of pipe-separated items, no
  // pills/tags. Matches the "Soft Skills: a | b | c" line in the reference.
  const text = r.competencies.map((c) => escapeHtml(c)).join(' | ');
  return `<div class="section">
    <div class="section-title">Core Competencies</div>
    <div class="competencies-text">${text}</div>
  </div>`;
}

function buildExperience(r: TailoredResume): string {
  if (!r.experience.length) return '';
  // Per entry: "<bold role>, company, location"  ……right…… "<period>", then bullets.
  const items = r.experience
    .map((e) => {
      const bullets = e.highlights.map((h) => `<li>${inlineMd(h)}</li>`).join('\n        ');
      const org = [e.company, e.location].filter(Boolean).map((s) => escapeHtml(s ?? '')).join(', ');
      return `<div class="entry">
      <div class="entry-header">
        <div class="entry-left"><span class="entry-title">${escapeHtml(e.role)}</span>${org ? `<span class="entry-org">, ${org}</span>` : ''}</div>
        <div class="entry-right">${escapeHtml(e.period)}</div>
      </div>
      <ul>
        ${bullets}
      </ul>
    </div>`;
    })
    .join('\n    ');
  return `<div class="section">
    <div class="section-title">Experience</div>
    ${items}
  </div>`;
}

function buildProjects(r: TailoredResume): string {
  if (!r.projects.length) return '';
  // Per entry: "<bold name>"  ……right…… "<tech stack>", italic role sub-line, bullets.
  const items = r.projects
    .map((p) => {
      const bullets = p.highlights.length
        ? `<ul>\n        ${p.highlights.map((h) => `<li>${inlineMd(h)}</li>`).join('\n        ')}\n      </ul>`
        : '';
      const tech = p.technologies.length ? `<div class="entry-right">${escapeHtml(p.technologies.join(', '))}</div>` : '';
      return `<div class="entry">
      <div class="entry-header">
        <div class="entry-left"><span class="entry-title">${escapeHtml(p.name)}</span></div>
        ${tech}
      </div>
      ${p.description ? `<div class="entry-sub">${inlineMd(p.description)}</div>` : ''}
      ${bullets}
    </div>`;
    })
    .join('\n    ');
  return `<div class="section">
    <div class="section-title">Projects</div>
    ${items}
  </div>`;
}

function buildEducation(r: TailoredResume): string {
  if (!r.education.length) return '';
  // Reference-PDF layout per entry:
  //   <bold degree>                                   <plain period>
  //   <institution>           ← plain sub-line
  //   <optional details>
  const items = r.education
    .map(
      (ed) => `<div class="entry">
      <div class="entry-header">
        <div class="entry-left"><span class="entry-title">${escapeHtml(ed.degree)}</span>${ed.institution ? `<span class="entry-org">, ${escapeHtml(ed.institution)}</span>` : ''}</div>
        <div class="entry-right">${escapeHtml(ed.period)}</div>
      </div>
      ${ed.details ? `<div class="entry-desc">${inlineMd(ed.details)}</div>` : ''}
    </div>`,
    )
    .join('\n    ');
  return `<div class="section">
    <div class="section-title">Education</div>
    ${items}
  </div>`;
}

function buildCertifications(r: TailoredResume): string {
  if (!r.certifications.length) return '';
  const items = r.certifications.map((c) => `<div class="cert-item"><span class="cert-title">${inlineMd(c)}</span></div>`).join('\n    ');
  return `<div class="section">
    <div class="section-title">Certifications</div>
    ${items}
  </div>`;
}

function buildSkills(r: TailoredResume): string {
  if (!r.skills.length) return '';
  // Classic-resume style: one "Category: item | item | item" line per group.
  // Category bolded, items pipe-separated, all plain text (no chips).
  const items = r.skills
    .map(
      (g) => `<div class="skill-item"><span class="skill-category">${escapeHtml(g.category)}:</span> ${escapeHtml(g.items.join(', '))}</div>`,
    )
    .join('\n    ');
  return `<div class="section">
    <div class="section-title">Skills</div>
    ${items}
  </div>`;
}

export type RenderResumePdfOptions = {
  /** Override output path. By default writes resume.pdf next to resume.json. */
  outPath?: string;
};

export async function renderResumePdf(jobId: string, opts: RenderResumePdfOptions = {}): Promise<string> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`render-resume-pdf: ${jobId} not in DB.`);

  const slug = artefactBase(job);
  const outputDir = applicationDir(job);
  const jsonPath = path.join(outputDir, `${slug}-resume.json`);
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`render-resume-pdf: ${jsonPath} not found. Run \`career-ops assemble-resume ${jobId}\` first.`);
  }
  const resume = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as TailoredResume;

  const template = loadTemplate('resume.html');
  const html = renderTemplate(template, {
    NAME: escapeHtml(resume.name),
    CONTACT_ROW: buildContactRow(resume.contact),
    SUMMARY_BLOCK: buildSummary(resume),
    COMPETENCIES_BLOCK: buildCompetencies(resume),
    EXPERIENCE_BLOCK: buildExperience(resume),
    PROJECTS_BLOCK: buildProjects(resume),
    EDUCATION_BLOCK: buildEducation(resume),
    CERTIFICATIONS_BLOCK: buildCertifications(resume),
    SKILLS_BLOCK: buildSkills(resume),
  });

  const outPath = opts.outPath ?? path.join(outputDir, `${slug}-resume.pdf`);
  await renderHtmlToPdf(html, { outPath });

  log.info({ jobId, outPath }, 'render-resume-pdf: complete');
  return outPath;
}
