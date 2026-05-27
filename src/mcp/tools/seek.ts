// SEEK semantic tools — deterministic bundles for the STRUCTURED, stable parts
// of SEEK (resume manager, the apply wizard's documents/questions stages),
// reusing the battle-tested src/shared/seek/* modules. The UNPREDICTABLE parts
// (the login form, captchas, page variations) are left to the agent + the
// atomic browser_* tools following a playbook. Login here is just the
// deterministic state check + session persistence.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { saveStorageState } from '../../shared/browser/session.js';
import { journal } from '../../shared/agent/journal.js';
import { isLoggedIn, looksLoggedInHere } from '../../shared/seek/auth.js';
import { getSavedResumes, rotateUploadResume } from '../../shared/seek/documents.js';
import { clickContinue, clickSubmit, detectStep, fillDocuments } from '../../shared/seek/quick-apply.js';
import { answerQuestions, captureNewQuestions, extractQuestions, guidelineFile, loadGuideline } from '../../shared/seek/questions.js';
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
    { title: 'List saved resumes', description: 'Open the SEEK resume manager and list saved resumes (newest first; Default pinned). SEEK caps the list at 10.' },
    async () =>
      guard(async () => {
        const resumes = await getSavedResumes(await sessions.ensure());
        return ok({ count: resumes.length, limit: 10, resumes });
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
        const page = await sessions.getPage();
        const url = `${config.seek.baseUrl}/job/${jobId}/apply`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1000);
        return ok({ jobId, url, step: await detectStep(page) });
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
        'On the documents stage: select the pre-uploaded resume by filename substring, and paste the cover letter (or choose "don\'t include a cover letter" when omitted). Does NOT advance — call seek_apply_advance next.',
      inputSchema: {
        resumeFilename: z.string().describe('Filename (or substring) of the saved resume to select; upload it first with seek_resume_rotate if missing.'),
        coverLetterText: z.string().optional().describe('Cover-letter body to paste. Omit to skip the cover letter.'),
      },
    },
    async ({ resumeFilename, coverLetterText }) =>
      guard(async () => {
        await fillDocuments(await sessions.getPage(), { resumeFilename, coverLetterText });
        return ok({ filled: 'documents', resumeFilename, coverLetter: Boolean(coverLetterText) });
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
