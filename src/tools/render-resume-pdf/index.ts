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
  // Classic-resume layout: each contact item on its own centered line. Email
  // and URLs render as hyperlinks (blue + underline via .contact-line CSS);
  // phone, location render as plain spans.
  const lines: string[] = [];
  if (c.email) {
    lines.push(`<a class="contact-line" href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>`);
  }
  if (c.phone) lines.push(`<span class="contact-line">${escapeHtml(c.phone)}</span>`);
  if (c.linkedinUrl) {
    const text = c.linkedinDisplay ?? c.linkedinUrl.replace(/^https?:\/\//, '');
    lines.push(`<a class="contact-line" href="${escapeHtml(c.linkedinUrl)}">${escapeHtml(text)}</a>`);
  }
  if (c.portfolioUrl) {
    const text = c.portfolioDisplay ?? c.portfolioUrl.replace(/^https?:\/\//, '');
    lines.push(`<a class="contact-line" href="${escapeHtml(c.portfolioUrl)}">${escapeHtml(text)}</a>`);
  }
  if (c.github) {
    lines.push(`<a class="contact-line" href="${escapeHtml(c.github)}">${escapeHtml(c.github.replace(/^https?:\/\//, ''))}</a>`);
  }
  if (c.location) lines.push(`<span class="contact-line">${escapeHtml(c.location)}</span>`);
  return lines.join('');
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
  // Reference-PDF layout per entry:
  //   <bold role>                                     <plain period>
  //   <company>, <location?>          ← plain sub-line
  //   • highlight bullets…
  const items = r.experience
    .map((e) => {
      const bullets = e.highlights.map((h) => `<li>${inlineMd(h)}</li>`).join('\n        ');
      const sub = [e.company, e.location].filter(Boolean).map((s) => escapeHtml(s ?? '')).join(', ');
      return `<div class="job">
      <div class="job-header">
        <span class="job-role">${escapeHtml(e.role)}</span>
        <span class="job-period">${escapeHtml(e.period)}</span>
      </div>
      ${sub ? `<div class="job-sub">${sub}</div>` : ''}
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
      const tech = p.technologies.length ? `<div class="project-tech">${escapeHtml(p.technologies.join(' | '))}</div>` : '';
      return `<div class="project">
      <div><span class="project-title">${escapeHtml(p.name)}</span>${badge}</div>
      ${p.description ? `<div class="project-desc">${inlineMd(p.description)}</div>` : ''}
      ${bullets}
      ${tech}
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
      (ed) => `<div class="edu-item">
      <div class="edu-header">
        <span class="edu-degree">${escapeHtml(ed.degree)}</span>
        <span class="edu-year">${escapeHtml(ed.period)}</span>
      </div>
      <div class="edu-sub">${escapeHtml(ed.institution)}</div>
      ${ed.details ? `<ul class="edu-details"><li>${inlineMd(ed.details)}</li></ul>` : ''}
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
      (g) => `<div class="skill-item"><span class="skill-category">${escapeHtml(g.category)}:</span> ${escapeHtml(g.items.join(' | '))}</div>`,
    )
    .join('\n    ');
  return `<div class="section">
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
