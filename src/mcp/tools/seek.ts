// SEEK semantic tools — deterministic bundles for the STRUCTURED, stable parts
// of SEEK (resume manager, the apply wizard's documents/questions stages),
// reusing the battle-tested src/shared/seek/* modules. The UNPREDICTABLE parts
// (the login form, captchas, page variations) are left to the agent + the
// atomic browser_* tools following a playbook. Login here is just the
// deterministic state check + session persistence.
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { saveStorageState } from '../../shared/browser/session.js';
import { journal } from '../../shared/agent/journal.js';
import { applicationDir, artefactBase } from '../../shared/slug.js';
import { isLoggedIn, looksLoggedInHere } from '../../shared/seek/auth.js';
import { deleteOldResumes, getSavedResumes, rotateUploadResume } from '../../shared/seek/documents.js';
import { clickContinue, clickSubmit, detectStep, fillDocuments, waitForSubmitted, type DocumentsInput } from '../../shared/seek/quick-apply.js';
import { answerQuestions, captureNewQuestions, extractQuestions, guidelineFile, loadGuideline } from '../../shared/seek/questions.js';
import { RESUME } from '../../shared/seek/selectors.js';
import { sessions } from '../session.js';
import { fail, guard, needsHumanInput, ok } from '../result.js';

export function registerSeekTools(server: McpServer): void {
  // ─── login / session ──────────────────────────────────────────────────────
  server.registerTool(
    'seek_login_status',
    {
      title: 'SEEK login status',
      description:
        'Whether a SEEK session is active. By default navigates to the SEEK homepage for the reliable check (absence of a "Sign in" affordance). Pass navigate:false to check the CURRENT page without leaving it (use mid-flow).',
      inputSchema: { navigate: z.boolean().optional().describe('Default true. false = check the current page only.') },
    },
    async ({ navigate }) =>
      guard(async () => {
        const page = await sessions.getPage();
        const loggedIn = navigate === false ? await looksLoggedInHere(page) : await isLoggedIn(page);
        return ok({ loggedIn, authStatePath: config.seek.authStatePath }, loggedIn ? 'logged in' : 'NOT logged in');
      }),
  );

  server.registerTool(
    'seek_save_session',
    {
      title: 'Persist SEEK session',
      description: 'Save the current browser cookies/localStorage to the auth-state file so the logged-in session is reused on the next launch. Call this right after confirming login.',
    },
    async () =>
      guard(async () => {
        const session = await sessions.ensure();
        await saveStorageState(session, config.seek.authStatePath);
        return ok({ saved: true, authStatePath: config.seek.authStatePath });
      }),
  );

  // ─── resume manager (rolling-window slot) ──────────────────────────────────
  server.registerTool(
    'seek_resume_list',
    {
      title: 'List saved resumes',
      description:
        'Open the SEEK resume manager and list saved resumes (newest first; Default pinned). Also returns cap (10), slotsFree, the protected-default presence, and cleanupEvery (run seek_resume_delete_old at batch start and after this many applications).',
    },
    async () =>
      guard(async () => {
        const resumes = await getSavedResumes(await sessions.ensure());
        const cap = RESUME.limit;
        const sub = config.seek.protectedResume.trim().toLowerCase();
        const protectedPresent = sub ? resumes.some((r) => r.filename.toLowerCase().includes(sub)) : false;
        return ok({
          count: resumes.length,
          cap,
          slotsFree: Math.max(0, cap - resumes.length),
          cleanupEvery: config.seek.applyCleanupEvery,
          protectedPresent,
          resumes,
        });
      }),
  );

  server.registerTool(
    'seek_resume_rotate',
    {
      title: 'Rotate-upload a resume',
      description:
        'Ensure a resume PDF is saved on SEEK, deleting the OLDEST non-default/non-protected resume first if the list is full. Idempotent (skips if already uploaded). Returns the saved filename to select in the apply wizard.',
      inputSchema: { pdfPath: z.string().describe('Absolute path to the tailored resume PDF.') },
    },
    async ({ pdfPath }) =>
      guard(async () => ok((await rotateUploadResume(await sessions.ensure(), pdfPath)) as unknown as Record<string, unknown>)),
  );

  server.registerTool(
    'seek_resume_delete_old',
    {
      title: 'Delete old resumes',
      description:
        'Open the SEEK resume manager and delete EVERY saved resume except your protected default (the one whose filename contains SEEK_PROTECTED_RESUME). Destructive and immediate — no preview. If the default is not found, deletes all and reports that you must upload it manually. Refuses to run if SEEK_PROTECTED_RESUME is unset.',
    },
    async () => guard(async () => {
      const r = await deleteOldResumes(await sessions.ensure());
      return ok(r as unknown as Record<string, unknown>, r.message);
    }),
  );

  // ─── apply wizard (one tool per stage; the agent orchestrates transitions) ──
  server.registerTool(
    'seek_apply_open',
    {
      title: 'Open SEEK application',
      description: 'Navigate the live browser to a job\'s quick-apply wizard (/job/<id>/apply) and report the current stage. Requires you to be logged in.',
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) =>
      guard(async () => {
        const job = db.getJob(jobId);

        // 1) Already applied per our records → skip (deterministic).
        const app = db.getApplication(jobId);
        if (app && (app.status === 'applied' || app.applyState === 'submitted')) {
          return ok(
            { jobId, alreadyApplied: true, via: 'db', step: 'already_applied', applyState: app.applyState ?? undefined },
            'Already applied per our records — skip this job.',
          );
        }

        // 2) Only quick-apply gets driven. External ("Apply on company site") is
        // NOT navigated — it's reported so the human applies manually.
        if (job?.applyType === 'external') {
          return ok(
            { jobId, external: true, step: 'external', externalUrl: job.externalApplyUrl ?? job.url, title: job.title ?? undefined, company: job.company ?? undefined },
            `EXTERNAL apply — do NOT drive the wizard. Record for the user to apply manually: ${job.externalApplyUrl ?? job.url}`,
          );
        }

        const page = await sessions.getPage();
        const url = `${config.seek.baseUrl}/job/${jobId}/apply`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1000);
        const step = await detectStep(page);

        // 3) Fallback when the DB didn't know: the wizard isn't showing (no
        // documents/questions/review controls) AND the page says "applied" —
        // i.e. where the apply button should be there's an "Applied" marker.
        if (step === 'unknown') {
          const appliedSignal = await page
            .evaluate(() => /you'?ve already applied|you have already applied|already applied|you applied|application (submitted|received|complete)/i.test(document.body.innerText || ''))
            .catch(() => false);
          if (appliedSignal) {
            return ok({ jobId, url, alreadyApplied: true, via: 'page', step: 'already_applied' }, 'Page shows this job is already applied — skip.');
          }
        }

        return ok({ jobId, url, external: false, alreadyApplied: false, step });
      }),
  );

  server.registerTool(
    'seek_apply_detect_step',
    { title: 'Detect apply stage', description: 'Classify the current apply-wizard stage: documents | questions | profile | review | submitted | unknown.' },
    async () => guard(async () => ok({ step: await detectStep(await sessions.getPage()) })),
  );

  server.registerTool(
    'seek_apply_fill_documents',
    {
      title: 'Fill the documents stage',
      description:
        'Attach the resume and cover letter on the documents stage. DEFAULT (just pass jobId): UPLOAD both as PDFs resolved from output/seek/<dir>/<base>-resume.pdf and -cover_letter.pdf — the HR-facing filenames apply_job generated. Fallbacks: resume "select" (pick a SEEK-saved resume by filename); cover letter "write" (paste text) or "omit". Does NOT advance — call seek_apply_advance next.',
      inputSchema: {
        jobId: z.string().optional().describe('Resolve the tailored resume + cover-letter PDFs for this job (upload mode). Run apply_job first to generate them.'),
        resume: z.enum(['upload', 'select']).optional().describe('Default "upload" (needs jobId or resumePath).'),
        coverLetter: z.enum(['upload', 'write', 'omit']).optional().describe('Default "upload" (needs jobId or coverLetterPath).'),
        resumeFilename: z.string().optional().describe('For resume="select": substring of a SEEK-saved resume.'),
        coverLetterText: z.string().optional().describe('For coverLetter="write": the cover-letter body.'),
        resumePath: z.string().optional().describe('Explicit resume PDF path (overrides jobId resolution).'),
        coverLetterPath: z.string().optional().describe('Explicit cover-letter PDF path (overrides jobId resolution).'),
      },
    },
    async ({ jobId, resume, coverLetter, resumeFilename, coverLetterText, resumePath, coverLetterPath }) =>
      guard(async () => {
        // Resolve the standard HR-facing artefact paths from the jobId.
        let resolvedResume: string | undefined;
        let resolvedCover: string | undefined;
        if (jobId) {
          const job = db.getJob(jobId);
          if (!job) throw new Error(`${jobId} not in DB — run apply_job ${jobId} first to generate the documents.`);
          const base = artefactBase(job);
          const dir = applicationDir(job);
          resolvedResume = path.join(dir, `${base}-resume.pdf`);
          resolvedCover = path.join(dir, `${base}-cover_letter.pdf`);
        }

        const input: DocumentsInput = {};

        // Resume: upload (default) or select-from-saved.
        const resumeMode = resume ?? (resumeFilename ? 'select' : 'upload');
        if (resumeMode === 'select') {
          if (!resumeFilename) throw new Error('resume="select" needs resumeFilename.');
          input.resumeFilename = resumeFilename;
        } else {
          const p = resumePath ?? resolvedResume;
          if (!p) throw new Error('resume="upload" needs a jobId or an explicit resumePath.');
          if (!fs.existsSync(p)) throw new Error(`resume PDF not found: ${p} — run apply_job first.`);
          input.resumePath = p;
        }

        // Cover letter: upload (default), write text, or omit.
        const coverMode = coverLetter ?? (coverLetterText ? 'write' : 'upload');
        if (coverMode === 'write') {
          input.coverLetterText = coverLetterText ?? '';
        } else if (coverMode === 'upload') {
          const p = coverLetterPath ?? resolvedCover;
          if (!p) throw new Error('coverLetter="upload" needs a jobId or an explicit coverLetterPath.');
          if (!fs.existsSync(p)) throw new Error(`cover letter PDF not found: ${p} — run apply_job first.`);
          input.coverLetterPath = p;
        } // 'omit' → leave unset → "Don't include a cover letter"

        await fillDocuments(await sessions.getPage(), input);
        return ok({
          filled: 'documents',
          resume: input.resumePath ? `upload:${path.basename(input.resumePath)}` : `select:${input.resumeFilename}`,
          coverLetter: input.coverLetterPath ? `upload:${path.basename(input.coverLetterPath)}` : input.coverLetterText ? 'write' : 'omit',
        });
      }),
  );

  server.registerTool(
    'seek_apply_advance',
    { title: 'Advance the wizard', description: 'Click "Continue" to move to the next apply stage, then report the new stage.' },
    async () =>
      guard(async () => {
        const page = await sessions.getPage();
        await clickContinue(page);
        return ok({ advanced: true, step: await detectStep(page) });
      }),
  );

  server.registerTool(
    'seek_apply_extract_questions',
    {
      title: 'Extract employer questions',
      description:
        'Read the employer-question stage into structured questions (keyed by SEEK QID). Auto-captures any unseen question into the answers guideline (blank answer) for the user to fill. Read-only on the page.',
    },
    async () =>
      guard(async () => {
        const questions = await extractQuestions(await sessions.getPage());
        const captured = captureNewQuestions(questions);
        return ok({
          count: questions.length,
          questions,
          newlyCaptured: captured.map((q) => q.qid),
          guidelinePath: guidelineFile(),
        });
      }),
  );

  server.registerTool(
    'seek_apply_answer_questions',
    {
      title: 'Answer employer questions',
      description:
        'Fill the employer questions ONLY from the user\'s guideline (profile/seek-answers.md); SEEK-prefilled choices are accepted. NEVER guesses. If any question has no usable answer, returns needs_human_input listing them — ask the user, save the answers, then retry. Does NOT advance.',
    },
    async () =>
      guard(async () => {
        const page = await sessions.getPage();
        const questions = await extractQuestions(page);
        const captured = captureNewQuestions(questions);
        const { answered, unanswered } = await answerQuestions(page, questions, loadGuideline());
        if (unanswered.length > 0) {
          return needsHumanInput(
            `${unanswered.length} of ${questions.length} employer question(s) have no answer in the guideline. Ask the user, then add the answers (heading "## <qid> — <text>", line "answer: <value>") to the guideline file and call this tool again. Do NOT guess.`,
            'text',
            {
              answered,
              unanswered: unanswered.map((q) => ({ qid: q.qid, text: q.text, type: q.type, options: q.options })),
              newlyCaptured: captured.map((q) => q.qid),
              guidelinePath: guidelineFile(),
            },
          );
        }
        return ok({ allAnswered: true, total: questions.length, answered });
      }),
  );

  server.registerTool(
    'seek_apply_wait_submitted',
    {
      title: 'Wait for manual submission',
      description:
        'Poll the review page until SEEK\'s "Your application has been sent" confirmation appears — i.e. the USER clicked Submit themselves. Robust: editing answers or clicking Back never triggers it (only the real success page does). On detection, records the job as applied (when jobId given) so the next run skips it. Bounded wait (default ~45s) to stay under client timeouts: if it returns submitted:false/timedOut, call it AGAIN to keep waiting (the user may still be reviewing), or treat a deliberate non-submit as skip.',
      inputSchema: {
        jobId: z.string().optional().describe('Record this job as applied on detection.'),
        maxWaitMs: z.number().int().optional().describe('Max poll time for THIS call (default 45000). Re-call to keep waiting.'),
      },
    },
    async ({ jobId, maxWaitMs }) =>
      guard(async () => {
        const page = await sessions.getPage();
        const r = await waitForSubmitted(page, { maxWaitMs });
        if (r.submitted && jobId) {
          db.updateApplicationFields(jobId, { applyState: 'submitted', appliedAt: new Date().toISOString(), applyMethod: 'quick' });
          db.setStatus(jobId, 'applied', 'submitted manually via SEEK quick apply (detected by seek_apply_wait_submitted)');
          journal.note('submission detected + recorded applied', { jobId, signal: r.signal });
        }
        return ok(
          { ...r, jobId, recorded: r.submitted && Boolean(jobId) },
          r.submitted
            ? `Submission detected ("${r.signal}")${jobId ? ' — recorded as applied' : ''}. Proceed to the next job.`
            : `No submission yet after ${Math.round(r.waitedMs / 1000)}s — call again to keep waiting, or treat as skip if the user decided not to apply.`,
        );
      }),
  );

  server.registerTool(
    'seek_apply_submit',
    {
      title: 'Submit SEEK application (gated)',
      description:
        'Click the real "Submit application" button. DOUBLE-GATED: submits only when humanApproved:true (an explicit per-job yes you obtained from the user) OR SEEK_ALLOW_SUBMIT=true (unattended). Otherwise it refuses and stays on the review page. Only callable from the review stage. NEVER set humanApproved:true without an actual user yes.',
      inputSchema: {
        humanApproved: z.boolean().optional().describe('Set true ONLY after the user explicitly approved submitting THIS job.'),
        jobId: z.string().optional().describe('If given, the outcome is recorded against this job in the DB.'),
      },
    },
    async ({ humanApproved, jobId }) =>
      guard(async () => {
        const page = await sessions.getPage();
        const step = await detectStep(page);
        if (step !== 'review') return fail(`not on the review stage (currently "${step}") — only submit from review.`);

        const allowAuto = config.seek.allowSubmit;
        if (humanApproved !== true && !allowAuto) {
          if (jobId) db.updateApplicationFields(jobId, { applyState: 'filled_pending_review' });
          return ok(
            { submitted: false, reason: 'gated', allowSubmit: allowAuto },
            'NOT submitted — gated. Get an explicit user yes and call again with humanApproved:true, or set SEEK_ALLOW_SUBMIT=true for unattended submit. The filled application is parked on the review page.',
          );
        }

        journal.note('seek_apply_submit → SUBMITTING application', { jobId, humanApproved: humanApproved === true, allowSubmit: allowAuto });
        await clickSubmit(page);
        if (jobId) {
          db.updateApplicationFields(jobId, { applyState: 'submitted', appliedAt: new Date().toISOString(), applyMethod: 'quick' });
          db.setStatus(jobId, 'applied', 'submitted via SEEK quick apply (MCP)');
        }
        return ok({ submitted: true, via: humanApproved === true ? 'human_approved' : 'allow_submit', jobId }, 'application submitted');
      }),
  );
}
