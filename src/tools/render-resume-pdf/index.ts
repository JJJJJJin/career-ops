// render-resume-pdf — load output/<slug>/resume.json, fill resume.html
// template, write resume.pdf via Playwright.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { applicationSlug } from '../../shared/slug.js';
import { createLogger } from '../../shared/logger.js';
import { escapeHtml, inlineMd, renderTemplate } from '../../shared/render/template.js';
import { loadTemplate, renderHtmlToPdf } from '../../shared/render/pdf.js';
import type { TailoredResume } from '../generate-resume/types.js';

const log = createLogger('render-resume-pdf');

function buildContactRow(c: TailoredResume['contact']): string {
  const items: string[] = [];
  if (c.phone) items.push(`<span>${escapeHtml(c.phone)}</span>`);
  if (c.email) items.push(`<span>${escapeHtml(c.email)}</span>`);
  if (c.linkedinUrl) {
    const text = c.linkedinDisplay ?? c.linkedinUrl.replace(/^https?:\/\//, '');
    items.push(`<a href="${escapeHtml(c.linkedinUrl)}">${escapeHtml(text)}</a>`);
  }
  if (c.portfolioUrl) {
    const text = c.portfolioDisplay ?? c.portfolioUrl.replace(/^https?:\/\//, '');
    items.push(`<a href="${escapeHtml(c.portfolioUrl)}">${escapeHtml(text)}</a>`);
  }
  if (c.github) items.push(`<a href="${escapeHtml(c.github)}">${escapeHtml(c.github.replace(/^https?:\/\//, ''))}</a>`);
  if (c.location) items.push(`<span>${escapeHtml(c.location)}</span>`);
  return items.join('<span class="separator">|</span>');
}

function buildSummary(r: TailoredResume): string {
  if (!r.summary) return '';
  return `<div class="section avoid-break">
    <div class="section-title">Summary</div>
    <div class="summary-text">${inlineMd(r.summary)}</div>
  </div>`;
}

function buildCompetencies(r: TailoredResume): string {
  if (!r.competencies.length) return '';
  const tags = r.competencies.map((c) => `<span class="competency-tag">${escapeHtml(c)}</span>`).join('\n      ');
  return `<div class="section">
    <div class="section-title">Core Competencies</div>
    <div class="competencies-grid">
      ${tags}
    </div>
  </div>`;
}

function buildExperience(r: TailoredResume): string {
  if (!r.experience.length) return '';
  const items = r.experience
    .map((e) => {
      const bullets = e.highlights.map((h) => `<li>${inlineMd(h)}</li>`).join('\n        ');
      const sub = [e.location].filter(Boolean).map((s) => escapeHtml(s ?? '')).join(' ');
      return `<div class="job">
      <div class="job-header">
        <span class="job-company">${escapeHtml(e.company)}</span>
        <span class="job-period">${escapeHtml(e.period)}</span>
      </div>
      <div class="job-role">${escapeHtml(e.role)}${sub ? ` <span class="job-location">— ${sub}</span>` : ''}</div>
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
  const items = r.projects
    .map((p) => {
      const badge = p.badge ? `<span class="project-badge">${escapeHtml(p.badge)}</span>` : '';
      const bullets = p.highlights.length
        ? `<ul>${p.highlights.map((h) => `<li>${inlineMd(h)}</li>`).join('')}</ul>`
        : '';
      const tech = p.technologies.length ? `<div class="project-tech">${escapeHtml(p.technologies.join(' · '))}</div>` : '';
      return `<div class="project">
      <div><span class="project-title">${escapeHtml(p.name)}</span>${badge}</div>
      ${p.description ? `<div class="project-desc">${inlineMd(p.description)}</div>` : ''}
      ${bullets}
      ${tech}
    </div>`;
    })
    .join('\n    ');
  return `<div class="section avoid-break">
    <div class="section-title">Projects</div>
    ${items}
  </div>`;
}

function buildEducation(r: TailoredResume): string {
  if (!r.education.length) return '';
  const items = r.education
    .map(
      (ed) => `<div class="edu-item">
      <div class="edu-header">
        <span class="edu-title">${escapeHtml(ed.degree)} <span class="edu-org">— ${escapeHtml(ed.institution)}</span></span>
        <span class="edu-year">${escapeHtml(ed.period)}</span>
      </div>
      ${ed.details ? `<div class="edu-desc">${inlineMd(ed.details)}</div>` : ''}
    </div>`,
    )
    .join('\n    ');
  return `<div class="section avoid-break">
    <div class="section-title">Education</div>
    ${items}
  </div>`;
}

function buildCertifications(r: TailoredResume): string {
  if (!r.certifications.length) return '';
  const items = r.certifications.map((c) => `<div class="cert-item"><span class="cert-title">${inlineMd(c)}</span></div>`).join('\n    ');
  return `<div class="section avoid-break">
    <div class="section-title">Certifications</div>
    ${items}
  </div>`;
}

function buildSkills(r: TailoredResume): string {
  if (!r.skills.length) return '';
  const items = r.skills
    .map(
      (g) => `<div class="skill-item"><span class="skill-category">${escapeHtml(g.category)}:</span> ${escapeHtml(g.items.join(' · '))}</div>`,
    )
    .join('\n    ');
  return `<div class="section avoid-break">
    <div class="section-title">Skills</div>
    <div class="skills-grid">
      ${items}
    </div>
  </div>`;
}

export type RenderResumePdfOptions = {
  /** Override output path. By default writes resume.pdf next to resume.json. */
  outPath?: string;
};

export async function renderResumePdf(jobId: string, opts: RenderResumePdfOptions = {}): Promise<string> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`render-resume-pdf: ${jobId} not in DB.`);

  const outputDir = path.join(config.paths.applicationsDir, applicationSlug(job.company, job.title));
  const jsonPath = path.join(outputDir, 'resume.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`render-resume-pdf: ${jsonPath} not found. Run \`career-ops generate-resume ${jobId}\` first.`);
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

  const outPath = opts.outPath ?? path.join(outputDir, 'resume.pdf');
  await renderHtmlToPdf(html, { outPath });

  log.info({ jobId, outPath }, 'render-resume-pdf: complete');
  return outPath;
}
