// Catalog tools — thin MCP wrappers over the existing pure pipeline functions
// (src/tools/*/index.ts + src/workflows/*). Stateless request/response: scan,
// extract, evaluate, tailor, render, track. No browser session involved.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { guard, needsHumanInput, ok, withScreenshot } from '../result.js';
import { sessions } from '../session.js';
import { detectChallenge, textLooksLikeChallenge } from '../../shared/browser/antibot.js';
import { seekSearch } from '../../tools/seek-search/index.js';
import { linkedinSearch } from '../../tools/linkedin-search/index.js';
import { indeedSearch } from '../../tools/indeed-search/index.js';
import { builtinSearch } from '../../tools/builtin-search/index.js';
import { detectSource } from '../../shared/jobs/registry.js';
import { evaluateJob } from '../../tools/evaluate-job/index.js';
import { assembleResume } from '../../tools/assemble-resume/index.js';
import { goNoGo } from '../../tools/go-no-go/index.js';
import { aggregateGaps } from '../../tools/gap-report/index.js';
import { ensureLibrary } from '../../shared/library/parse.js';
import * as tracker from '../../shared/tracker/index.js';
import { generateCoverLetter } from '../../tools/generate-cover-letter/index.js';
import { generateCompanyBrief } from '../../tools/generate-company-brief/index.js';
import { renderResumePdf } from '../../tools/render-resume-pdf/index.js';
import { renderCoverLetterPdf } from '../../tools/render-cover-letter-pdf/index.js';
import { renderCompanyBriefPdf } from '../../tools/render-company-brief-pdf/index.js';
import { queryJobs } from '../../tools/query-jobs/index.js';
import { showJob } from '../../tools/show-job/index.js';
import { markJob } from '../../tools/mark-job/index.js';
import { jobStats } from '../../tools/job-stats/index.js';
import { sendFiles } from '../../tools/send-files/index.js';
import { writeTracker } from '../../shared/db/view.js';
import { applyJob } from '../../workflows/apply-job.js';
import { runDailyPipeline } from '../../workflows/daily-pipeline.js';

const SOURCE = z.enum(['seek', 'linkedin', 'indeed', 'builtin']);
const SEARCHERS = { seek: seekSearch, linkedin: linkedinSearch, indeed: indeedSearch, builtin: builtinSearch };

export function registerCatalogTools(server: McpServer): void {
  // ─── discovery & ingestion ────────────────────────────────────────────────
  server.registerTool(
    'job_search',
    {
      title: 'Search a job board',
      description: 'Scan a source (seek/linkedin/indeed/builtin) for jobs by keyword. Upserts thin job rows + a scan_run. Returns [{jobId,url,title,company,isNew}].',
      inputSchema: {
        source: SOURCE.describe('Which board to scan.'),
        keywords: z.array(z.string()).optional().describe('Search phrases; one search per keyword. Defaults to config SEARCH_KEYWORDS.'),
        location: z.string().optional(),
        days: z.number().int().optional().describe('Recency window in days.'),
        maxJobsPerKeyword: z.number().int().optional(),
      },
    },
    async ({ source, keywords, location, days, maxJobsPerKeyword }) =>
      guard(async () => {
        const results = await SEARCHERS[source]({ keywords, location, days, maxJobsPerKeyword });
        // Register discoveries in the shared tracker (dedup via ON CONFLICT; queues if offline).
        if (tracker.isEnabled()) {
          await tracker.flushOutbox();
          for (const r of results) {
            await tracker.discover({ source, sourceId: r.jobId, company: r.company, title: r.title, url: r.url });
          }
        }
        return ok({ source, count: results.length, results, trackerPending: tracker.pendingCount() }, `${source}: found ${results.length} job(s)`);
      }),
  );

  server.registerTool(
    'job_extract',
    {
      title: 'Extract a job posting',
      description:
        'Fetch + parse a job posting URL into a full Job record (auto-detects the source from the URL) and store it. ' +
        'When a live browser session is open it extracts THROUGH that session — a warmed-up, cookie-bearing session ' +
        'gets past anti-bot walls (e.g. Indeed/Cloudflare) that block a cold launch. If a verification wall is hit, ' +
        'returns needs_human_input + a screenshot: solve it in the open window, then call again.',
      inputSchema: { url: z.string().url(), reextract: z.boolean().optional() },
    },
    async ({ url, reextract }) =>
      guard(async () => {
        const source = detectSource(url);
        if (!source) throw new Error(`no job source matches URL "${url}" (seek/linkedin/indeed/builtin).`);

        // Reuse the live session when open (anti-bot resilience); otherwise the
        // source falls back to its own throwaway browser as before.
        const page = sessions.isOpen ? await sessions.getPage() : undefined;
        const job = await source.extract(url, { reextract, page });

        // If we drove the live page and it's sitting on a verification wall, the
        // record we just "parsed" is really the challenge text. Hand off to the
        // human — the browser stays open server-side for them to click through.
        if (page) {
          const challenge = await detectChallenge(page);
          if (challenge.challenged || textLooksLikeChallenge(job.title)) {
            const signal = challenge.signal ?? job.title;
            const msg =
              `Anti-bot verification on ${source.name} ("${signal}"). The live browser window is open — ` +
              `solve the challenge there, then call job_extract again for this URL.`;
            const data = { status: 'needs_human_input', kind: 'text', url, source: source.name, signal };
            const shot = await sessions.screenshot().catch(() => null);
            return shot
              ? withScreenshot(shot.toString('base64'), `NEEDS HUMAN INPUT (text): ${msg}`, data)
              : needsHumanInput(msg, 'text', { url, source: source.name, signal });
          }
        }
        return ok({ source: source.name, job }, `extracted ${job.jobId}: ${job.title}`);
      }),
  );

  // ─── evaluation ───────────────────────────────────────────────────────────
  server.registerTool(
    'evaluate_job',
    {
      title: 'Evaluate a job',
      description: 'Score fit + eligibility for a job (url or jobId). Returns {eligibility, summary, match} with fitScore and recommendation (STRONG/BORDERLINE/SKIP/NOT_FOR_YOU). Extracts first if given a URL.',
      inputSchema: { jobIdOrUrl: z.string(), reextract: z.boolean().optional(), force: z.boolean().optional() },
    },
    async ({ jobIdOrUrl, reextract, force }) =>
      guard(async () => {
        const r = await evaluateJob(jobIdOrUrl, { reextract, force });
        return ok(
          { jobId: r.job.jobId, recommendation: r.match.recommendation, scoreOutOf5: r.match.scoreOutOf5, eligibility: r.eligibility, summary: r.summary, match: r.match },
          `${r.job.jobId}: ${r.match.scoreOutOf5}/5 ${r.match.recommendation}`,
        );
      }),
  );

  // ─── generation ───────────────────────────────────────────────────────────
  const jobIdInput = { jobId: z.string(), force: z.boolean().optional() };
  server.registerTool(
    'assemble_resume',
    { title: 'Assemble tailored resume (deterministic)', description: 'Assemble a job-tailored resume by SELECTING pre-vetted bullets from the content library (profile_v3.md). No content is generated; every line is validated to trace back to the library. Preferred over generate_resume.', inputSchema: jobIdInput },
    async ({ jobId, force }) => guard(async () => {
      const r = await assembleResume(jobId, { force });
      return ok({ jobId, outputDir: r.outputDir, resumeJsonPath: r.resumeJsonPath, resumeMdPath: r.resumeMdPath, report: r.report });
    }),
  );
  server.registerTool(
    'go_no_go',
    { title: 'Go / no-go gate', description: 'Compare a JD\'s hard must-haves (years, PR/citizenship, clearance, pervasive stack) against the real profile. Returns go | low-yield with reasons.', inputSchema: { jobId: z.string() } },
    async ({ jobId }) => guard(async () => ok(await goNoGo(jobId))),
  );
  server.registerTool(
    'gap_report',
    { title: 'Cumulative gap report', description: 'JD requirements not in the content library, ranked by how many postings asked for them — the candidate\'s learning roadmap.', inputSchema: {} },
    async () => guard(async () => ok({ gaps: aggregateGaps() })),
  );
  server.registerTool(
    'generate_cover_letter',
    { title: 'Generate cover letter', description: 'Generate a tailored cover letter (.json + .md) for a jobId.', inputSchema: jobIdInput },
    async ({ jobId, force }) => guard(async () => {
      const r = await generateCoverLetter(jobId, { force });
      return ok({ jobId: r.jobId, outputDir: r.outputDir, jsonPath: r.jsonPath, mdPath: r.mdPath });
    }),
  );
  server.registerTool(
    'generate_company_brief',
    {
      title: 'Generate company brief',
      description: 'Generate a company brief (.md) for a jobId, optionally grounded by a company website URL.',
      inputSchema: { jobId: z.string(), companyWebsite: z.string().url().optional(), force: z.boolean().optional() },
    },
    async ({ jobId, companyWebsite, force }) => guard(async () => {
      const r = await generateCompanyBrief(jobId, { companyWebsite, force });
      return ok({ jobId, outputDir: r.outputDir, mdPath: r.mdPath, groundedBy: r.groundedBy });
    }),
  );

  // ─── rendering ────────────────────────────────────────────────────────────
  const renderers: Array<[string, (jobId: string) => Promise<string>, string]> = [
    ['render_resume_pdf', (id) => renderResumePdf(id), 'resume'],
    ['render_cover_letter_pdf', (id) => renderCoverLetterPdf(id), 'cover letter'],
    ['render_company_brief_pdf', (id) => renderCompanyBriefPdf(id), 'company brief'],
  ];
  for (const [name, fn, label] of renderers) {
    server.registerTool(
      name,
      { title: `Render ${label} PDF`, description: `Render the ${label} to PDF for a jobId (the .json/.md must already exist).`, inputSchema: { jobId: z.string() } },
      async ({ jobId }) => guard(async () => ok({ jobId, pdfPath: await fn(jobId) }, `rendered ${label} PDF`)),
    );
  }

  // ─── workflows ────────────────────────────────────────────────────────────
  server.registerTool(
    'apply_job',
    {
      title: 'Prepare an application bundle',
      description: 'Full prep pipeline for a job (url or jobId): evaluate → generate resume/cover/brief → render PDFs → update tracker (optionally email the bundle). Does NOT submit to SEEK — use the seek_apply_* tools for that.',
      inputSchema: {
        jobIdOrUrl: z.string(),
        skipBrief: z.boolean().optional(),
        skipPdf: z.boolean().optional(),
        companyWebsite: z.string().url().optional(),
        email: z.boolean().optional().describe('Email the PDF bundle to EMAIL_TO. Default: on when email is configured.'),
        reextract: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ jobIdOrUrl, skipBrief, skipPdf, companyWebsite, email, reextract, force }) =>
      guard(async () => {
        const r = await applyJob(jobIdOrUrl, { skipBrief, skipPdf, companyWebsite, email, reextract, force });
        return ok(r as unknown as Record<string, unknown>, `${r.jobId}: ${r.recommendation} ${r.scoreOutOf5}/5 → ${r.outputDir ?? '(eligibility blocked)'}`);
      }),
  );

  server.registerTool(
    'daily_pipeline',
    {
      title: 'Daily pipeline',
      description: 'Scan configured sources → extract+evaluate new jobs → optionally auto-prepare the top N STRONG matches.',
      inputSchema: {
        keywords: z.array(z.string()).optional(),
        sources: z.array(SOURCE).optional().describe('Default ["seek"].'),
        autoApplyTopN: z.number().int().min(0).optional().describe('0 = evaluate only.'),
        force: z.boolean().optional(),
      },
    },
    async ({ keywords, sources, autoApplyTopN, force }) =>
      guard(async () => ok((await runDailyPipeline({ keywords, sources, autoApplyTopN, force })) as unknown as Record<string, unknown>)),
  );

  // ─── tracking ─────────────────────────────────────────────────────────────
  server.registerTool(
    'query_jobs',
    {
      title: 'Query jobs',
      description: 'List jobs from the DB with filters. Returns rows of {job, application}.',
      inputSchema: {
        sinceDays: z.number().int().optional(),
        eligibleOnly: z.boolean().optional(),
        ineligibleOnly: z.boolean().optional(),
        keyword: z.string().optional(),
        company: z.string().optional(),
        minScore: z.number().optional(),
        status: z.enum(['new', 'interested', 'applied', 'interview', 'rejected', 'offer', 'skip']).optional(),
        limit: z.number().int().optional(),
      },
    },
    async (filters) => guard(async () => {
      const rows = queryJobs(filters);
      return ok({ count: rows.length, rows }, `${rows.length} job(s)`);
    }),
  );

  server.registerTool(
    'show_job',
    { title: 'Show job', description: 'Full record + application state for one jobId.', inputSchema: { jobId: z.string() } },
    async ({ jobId }) => guard(async () => ok(showJob(jobId) as unknown as Record<string, unknown>)),
  );

  server.registerTool(
    'mark_job',
    {
      title: 'Mark job status',
      description: 'Set the application status for a jobId (lifecycle: new → interested → applied → interview → rejected | offer | skip).',
      inputSchema: {
        jobId: z.string(),
        status: z.enum(['new', 'interested', 'applied', 'interview', 'rejected', 'offer', 'skip']),
        notes: z.string().optional(),
      },
    },
    async ({ jobId, status, notes }) => guard(async () => ok(await markJob(jobId, status, notes) as unknown as Record<string, unknown>, `${jobId} → ${status}`)),
  );

  server.registerTool(
    'job_stats',
    { title: 'Job stats', description: 'Counts by status / recommendation / eligibility.' },
    async () => guard(async () => ok(jobStats() as unknown as Record<string, unknown>)),
  );

  server.registerTool(
    'render_tracker',
    { title: 'Render tracker', description: 'Regenerate data/applications.md from the DB. Returns the path.' },
    async () => guard(async () => ok({ trackerPath: writeTracker() })),
  );

  // ─── content library & delivery ───────────────────────────────────────────
  server.registerTool(
    'parse_library',
    { title: 'Parse content library', description: 'Parse + validate profile_v3.md (the résumé content library) and self-test that each archetype assembles into a fully traceable résumé.', inputSchema: {} },
    async () => guard(async () => {
      const { library } = ensureLibrary();
      return ok({
        sourceHash: library.sourceHash,
        experience: library.experience.length,
        projects: library.projects.length,
        summaryVariants: Object.keys(library.summaryVariants).filter((k) => library.summaryVariants[k as keyof typeof library.summaryVariants]),
        synonymGroups: library.synonyms.length,
      });
    }),
  );

  server.registerTool(
    'send_files',
    {
      title: 'Send files to chat',
      description: 'Push files to the configured webhook chat. Either explicit paths, or all PDFs for a jobId.',
      inputSchema: {
        paths: z.array(z.string()).optional(),
        jobId: z.string().optional(),
        text: z.string().optional(),
        markdown: z.boolean().optional(),
      },
    },
    async ({ paths, jobId, text, markdown }) => guard(async () => ok((await sendFiles({ paths, jobId, text, markdown })) as unknown as Record<string, unknown>)),
  );
}
