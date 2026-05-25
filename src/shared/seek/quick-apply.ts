// (D) Quick-apply driver — the SEEK application wizard.
//
// Stages: Choose documents → Answer employer questions → Update SEEK Profile →
// Review and submit. The documents step is structured (stable name= hooks), so
// it's driven deterministically: pick the pre-uploaded resume from the saved
// list and write the cover letter into the textarea. Employer questions
// (Phase 5) and submission (Phase 6) come later. This phase fills documents,
// advances, and stops — never submits.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { BrowserSession } from '../browser/session.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import type { ApplyAnswer } from '../db/types.js';
import { journal } from '../agent/journal.js';
import { awaitHumanInput } from '../agent/human-input.js';
import { answerQuestions, captureNewQuestions, extractQuestions, guidelineFile, loadGuideline } from './questions.js';

const log = createLogger('seek:quick-apply');

export type QuickApplyStep = 'documents' | 'questions' | 'profile' | 'review' | 'submitted' | 'unknown';

/**
 * What to do at the review page:
 *   'dry'     — stop, never submit (default / test mode)
 *   'confirm' — pause and ask the human (yes/no) before submitting
 *   'auto'    — submit without asking (requires SEEK_ALLOW_SUBMIT)
 */
export type SubmitMode = 'dry' | 'confirm' | 'auto';

export type QuickApplyOptions = {
  resumeFilename: string;
  coverLetterText?: string;
  submitMode?: SubmitMode;
  /** Job title, used in the confirm prompt so you know which job you're approving. */
  jobTitle?: string;
};

export type QuickApplyResult = {
  stoppedAt: QuickApplyStep;
  steps: string[];
  screenshotPath?: string;
  /** Employer-question answers filled from the guideline (audit trail). */
  answered?: ApplyAnswer[];
  /** Question prompts with no usable guideline answer (run stopped). */
  unanswered?: string[];
  /** QIDs of questions newly captured into the guideline this run. */
  newQuestions?: string[];
  /** Path to the guideline file the user edits. */
  guidelinePath?: string;
};

function applyUrl(jobId: string): string {
  return `${config.seek.baseUrl}/job/${jobId}/apply`;
}

/**
 * Select a custom radio by its visible label. SEEK wraps the label text in a
 * <span> inside a <label>; the <label> is the real click target (it intercepts
 * pointer events), so click the label element, not the inner span.
 */
async function chooseOption(page: Page, labelRe: RegExp): Promise<void> {
  const label = page.locator('label', { hasText: labelRe }).first();
  await label.click({ timeout: 8000 });
  await page.waitForTimeout(500);
}

async function fillDocuments(page: Page, opts: QuickApplyOptions): Promise<void> {
  // Resume: "Select a resumé" → choose the pre-uploaded one from the dropdown.
  await chooseOption(page, /select a resum/i);
  const select = page.locator('select').first();
  await select.waitFor({ state: 'visible', timeout: 8000 });
  const value = await select.evaluate((sel: HTMLSelectElement, sub: string) => {
    const opt = Array.from(sel.options).find((o) => (o.textContent ?? '').toLowerCase().includes(sub.toLowerCase()));
    return opt ? opt.value : '';
  }, opts.resumeFilename);
  if (!value) throw new Error(`resume "${opts.resumeFilename}" not found in the apply dropdown`);
  await select.selectOption(value);
  log.info({ resume: opts.resumeFilename }, 'selected saved resume');
  journal.note('documents: selected resume', { resume: opts.resumeFilename });

  // Cover letter: "Write a cover letter" → paste text (no document slot used).
  if (opts.coverLetterText && opts.coverLetterText.trim()) {
    await chooseOption(page, /write a cover letter/i);
    const ta = page.locator('textarea').first();
    await ta.waitFor({ state: 'visible', timeout: 8000 });
    await ta.fill(opts.coverLetterText.trim());
    log.info({ chars: opts.coverLetterText.trim().length }, 'wrote cover letter');
    journal.note('documents: wrote cover letter', { chars: opts.coverLetterText.trim().length });
  } else {
    await chooseOption(page, /don.?t include a cover letter/i);
    journal.note('documents: no cover letter (none selected)');
  }
}

async function clickContinue(page: Page): Promise<void> {
  await page.getByRole('button', { name: /continue/i }).first().click({ timeout: 10_000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

/**
 * Which stage are we on? Detected by step-specific content, NOT the progress
 * nav (which always shows every stage label). 'documents' has the resume-method
 * radios; 'review' has a "Submit application" action button.
 */
async function detectStep(page: Page): Promise<QuickApplyStep> {
  return page.evaluate(() => {
    if (document.querySelector('input[name="resume-method"]')) return 'documents';
    const btns = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase());
    if (btns.some((t) => t.includes('submit application') || t === 'submit')) return 'review';
    const txt = (document.body.innerText ?? '').toLowerCase();
    // SEEK-profile step: body says "Your SEEK Profile is part of your
    // application" and offers "Add to Profile" buttons (the nav label
    // "Update SEEK Profile" is always present, so don't rely on it).
    if (/seek profile is part of your application/.test(txt) || btns.some((t) => t.includes('add to profile'))) return 'profile';
    // Employer-questions step: the main content holds question fields
    // (selects / radio groups / free-text), none of which appear on the other
    // non-documents stages.
    if (document.querySelector('select, input[type="radio"], input[type="number"], textarea')) return 'questions';
    return 'unknown';
  });
}

async function snap(page: Page, jobId: string, label: string): Promise<string> {
  const dir = path.join(config.paths.reportsDir, 'seek-apply');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${jobId}-${label}-${Date.now()}.jpg`);
  await page.screenshot({ path: out, type: 'jpeg', quality: 70 }).catch(() => {});
  return out;
}

export async function runQuickApply(session: BrowserSession, jobId: string, opts: QuickApplyOptions): Promise<QuickApplyResult> {
  const page = session.page;
  const steps: string[] = [];

  await page.goto(applyUrl(jobId), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Walk the wizard. Documents handled deterministically; profile skipped;
  // questions deferred to Phase 5; review is where dry-run stops.
  const maxStages = 6;
  let lastAnswered: ApplyAnswer[] = [];
  for (let i = 0; i < maxStages; i++) {
    const step = await detectStep(page);
    steps.push(step);
    log.info({ jobId, step, i }, 'quick-apply: stage');
    journal.note(`stage → ${step}`, { jobId });

    if (step === 'documents') {
      await fillDocuments(page, opts);
      await clickContinue(page);
      continue;
    }
    if (step === 'profile') {
      await clickContinue(page); // skip profile updates
      continue;
    }
    if (step === 'questions') {
      const questions = await extractQuestions(page);
      const captured = captureNewQuestions(questions); // accumulate for the user to answer
      const { answered, unanswered } = await answerQuestions(page, questions, loadGuideline());
      log.info({ jobId, total: questions.length, answered: answered.length, unanswered: unanswered.length, captured: captured.length }, 'employer questions processed');
      if (unanswered.length > 0) {
        // Don't guess. Capture + stop so the user can fill the guideline.
        const screenshotPath = await snap(page, jobId, 'questions');
        return {
          stoppedAt: 'questions', steps, screenshotPath, answered,
          unanswered: unanswered.map((q) => q.text),
          newQuestions: captured.map((q) => q.qid),
          guidelinePath: guidelineFile(),
        };
      }
      // All answered from the guideline — advance.
      await clickContinue(page);
      // Carry the audit forward by stashing on the page-less result via closure.
      lastAnswered = answered;
      continue;
    }
    if (step === 'review') {
      const reviewShot = await snap(page, jobId, 'review');
      const mode = opts.submitMode ?? 'dry';
      const reviewResult: QuickApplyResult = { stoppedAt: 'review', steps, screenshotPath: reviewShot, answered: lastAnswered };

      // 'dry' — never submit.
      if (mode === 'dry') return reviewResult;

      // 'auto' — submit unattended, but only if the master switch is on.
      if (mode === 'auto') {
        if (!config.seek.allowSubmit) {
          journal.note('review → NOT submitting (auto mode but SEEK_ALLOW_SUBMIT is off)', { jobId });
          return reviewResult;
        }
      }

      // 'confirm' — pause for the human. The headful browser is parked on the
      // review page so they can eyeball the resume/cover/answers, then reply.
      if (mode === 'confirm') {
        const answer = await awaitHumanInput({
          label: `Review "${opts.jobTitle ?? jobId}" (job ${jobId}) — resume, cover letter and answers are filled in. Reply "yes" to SUBMIT, anything else to skip. Review screenshot: ${reviewShot}`,
          kind: 'text',
        });
        if (!/^\s*(y|yes)\s*$/i.test(answer)) {
          journal.note('review → human declined submit; left filled, not submitted', { jobId, answer });
          return reviewResult;
        }
        journal.note('review → human confirmed submit', { jobId });
      }

      log.warn({ jobId, mode }, 'quick-apply: SUBMITTING application');
      journal.note(`review → SUBMITTING application (${mode})`, { jobId });
      await page.getByRole('button', { name: /submit application/i }).first().click({ timeout: 12_000 });
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const submittedShot = await snap(page, jobId, 'submitted');
      return { stoppedAt: 'submitted', steps, screenshotPath: submittedShot, answered: lastAnswered };
    }
    // unknown — capture for diagnosis and stop.
    const screenshotPath = await snap(page, jobId, 'unknown');
    return { stoppedAt: 'unknown', steps, screenshotPath, answered: lastAnswered };
  }
  const screenshotPath = await snap(page, jobId, 'maxstages');
  return { stoppedAt: 'unknown', steps, screenshotPath, answered: lastAnswered };
}
