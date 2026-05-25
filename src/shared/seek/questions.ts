// Employer-question handling — capture-first, guideline-driven.
//
// SEEK renders each question in a container id="question-<QID>" with a stable
// question id (e.g. AU_Q_6_V_10) and name="questionnaire.<QID>". We:
//   1. extract every question (text, type, options, current value);
//   2. capture any unseen one into profile/seek-answers.md (blank answer);
//   3. answer ONLY from the user's guideline — never guess. Unanswered
//      questions are reported and the run stops (no submission).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import type { ApplyAnswer } from '../db/types.js';

const log = createLogger('seek:questions');

export type QuestionType = 'select' | 'radio' | 'text' | 'number' | 'textarea' | 'checkbox' | 'unknown';

export type SeekQuestion = {
  qid: string;
  name: string;
  text: string;
  type: QuestionType;
  options: string[];
  currentValue: string;
};

function guidelinePath(): string {
  return path.join(config.paths.profileDir, 'seek-answers.md');
}

// ─── extraction ───────────────────────────────────────────────────────────
export async function extractQuestions(page: Page): Promise<SeekQuestion[]> {
  return page.evaluate(() => {
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const containers = Array.from(document.querySelectorAll('[id^="question-"]'));
    const byQid = new Map<string, SeekQuestionRaw>();

    type SeekQuestionRaw = { qid: string; name: string; text: string; type: string; options: string[]; currentValue: string };

    const promptText = (container: Element, control: Element): string => {
      for (const el of [control, container]) {
        const lb = el.getAttribute('aria-labelledby');
        if (lb) {
          const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
          if (norm(t)) return norm(t);
        }
      }
      const cid = control.getAttribute('id');
      if (cid) {
        const lab = document.querySelector(`label[for="${CSS.escape(cid)}"]`);
        if (norm(lab?.textContent)) return norm(lab?.textContent);
      }
      const fs = control.closest('fieldset');
      if (fs) { const lg = fs.querySelector('legend'); if (norm(lg?.textContent)) return norm(lg?.textContent); }
      const h = container.querySelector('legend, strong, h3, h4, label');
      if (norm(h?.textContent)) return norm(h?.textContent);
      return '(unknown question)';
    };

    for (const c of containers) {
      const id = c.getAttribute('id') ?? '';
      const qid = id.slice('question-'.length);
      if (!qid || byQid.has(qid)) continue;

      const select = (c.tagName === 'SELECT' ? c : c.querySelector('select')) as HTMLSelectElement | null;
      const radios = Array.from(c.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
      const textInput = c.querySelector('input[type="text"], input[type="number"], textarea') as HTMLInputElement | null;

      if (select) {
        byQid.set(qid, {
          qid, name: select.getAttribute('name') ?? `questionnaire.${qid}`, text: promptText(c, select), type: 'select',
          options: Array.from(select.options).map((o) => norm(o.textContent)).filter(Boolean),
          currentValue: norm(select.options[select.selectedIndex]?.textContent),
        });
      } else if (radios.length) {
        const optLabel = (r: HTMLInputElement) => { const l = r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null; return norm(l?.textContent) || norm(r.value); };
        byQid.set(qid, {
          qid, name: radios[0]!.getAttribute('name') ?? `questionnaire.${qid}`, text: promptText(c, radios[0]!), type: 'radio',
          options: radios.map(optLabel), currentValue: norm(optLabel(radios.find((r) => r.checked) ?? ({} as HTMLInputElement))),
        });
      } else if (textInput) {
        const t = textInput.tagName === 'TEXTAREA' ? 'textarea' : (textInput.getAttribute('type') === 'number' ? 'number' : 'text');
        byQid.set(qid, { qid, name: textInput.getAttribute('name') ?? `questionnaire.${qid}`, text: promptText(c, textInput), type: t, options: [], currentValue: textInput.value });
      }
    }
    return Array.from(byQid.values()) as SeekQuestion[];
  });
}

// ─── guideline file (capture + answers) ─────────────────────────────────────
type GuidelineEntry = { qid: string; text: string; answer: string };

export function loadGuideline(): Map<string, GuidelineEntry> {
  const p = guidelinePath();
  const map = new Map<string, GuidelineEntry>();
  if (!fs.existsSync(p)) return map;
  const blocks = fs.readFileSync(p, 'utf-8').split(/^##\s+/m).slice(1);
  for (const b of blocks) {
    const lines = b.split('\n');
    const heading = lines[0] ?? '';
    const qid = heading.split(/\s+/)[0] ?? '';
    const text = heading.replace(qid, '').replace(/^\s*[—-]\s*/, '').trim();
    const answerLine = lines.find((l) => /^answer:/i.test(l.trim()));
    const answer = answerLine ? answerLine.replace(/^\s*answer:/i, '').trim() : '';
    if (qid) map.set(qid, { qid, text, answer });
  }
  return map;
}

/** Append questions not yet in the guideline (blank answer). Returns the new ones. */
export function captureNewQuestions(questions: SeekQuestion[]): SeekQuestion[] {
  const existing = loadGuideline();
  const newOnes = questions.filter((q) => !existing.has(q.qid));
  if (!newOnes.length) return [];
  const p = guidelinePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) {
    fs.writeFileSync(
      p,
      '# SEEK employer-question answers\n' +
        '#\n' +
        '# The agent appends each new question it meets (keyed by SEEK question id).\n' +
        '# Write your standard answer on the `answer:` line — for choice questions use\n' +
        '# one of the listed options (case-insensitive; a substring is fine). Leave it\n' +
        '# blank and the agent will capture it and stop rather than guess.\n',
    );
  }
  const blocks = newOnes
    .map((q) => {
      const opts = q.options.length ? `options: ${q.options.join(' | ')}\n` : '';
      return `\n## ${q.qid} — ${q.text}\ntype: ${q.type}\n${opts}answer: \n`;
    })
    .join('');
  fs.appendFileSync(p, blocks);
  log.info({ added: newOnes.length, file: p }, 'captured new employer questions');
  return newOnes;
}

// ─── answering (guideline-driven, deterministic) ────────────────────────────
function matchOption(options: string[], answer: string): string | null {
  const a = answer.trim().toLowerCase();
  if (!a) return null;
  return (
    options.find((o) => o.trim().toLowerCase() === a) ??
    options.find((o) => o.trim().toLowerCase().includes(a)) ??
    options.find((o) => o.trim() && a.includes(o.trim().toLowerCase())) ??
    null
  );
}

export type AnswerOutcome = {
  answered: ApplyAnswer[];
  /** Questions with no usable answer in the guideline. */
  unanswered: SeekQuestion[];
};

export async function answerQuestions(page: Page, questions: SeekQuestion[], guideline: Map<string, GuidelineEntry>): Promise<AnswerOutcome> {
  const answered: ApplyAnswer[] = [];
  const unanswered: SeekQuestion[] = [];

  for (const q of questions) {
    const entry = guideline.get(q.qid);
    const desired = entry?.answer?.trim() ?? '';
    if (!desired) {
      // No guideline answer. If SEEK already pre-filled it, accept that; else unanswered.
      if (q.currentValue && q.type !== 'text' && q.type !== 'textarea' && q.type !== 'number') {
        answered.push({ question: q.text, answer: q.currentValue, kind: `${q.type} (prefilled)` });
      } else {
        unanswered.push(q);
      }
      continue;
    }

    if (q.type === 'select') {
      const opt = matchOption(q.options, desired);
      if (!opt) { unanswered.push(q); continue; }
      await page.locator(`select[name="${q.name}"]`).selectOption({ label: opt });
      answered.push({ question: q.text, answer: opt, kind: 'select' });
    } else if (q.type === 'radio') {
      const opt = matchOption(q.options, desired);
      if (!opt) { unanswered.push(q); continue; }
      // Click the matching option's label within the group.
      await page.locator(`[id="question-${q.qid}"] label`, { hasText: opt }).first().click({ timeout: 8000 });
      answered.push({ question: q.text, answer: opt, kind: 'radio' });
    } else {
      // text / number / textarea
      await page.locator(`[name="${q.name}"]`).first().fill(desired);
      answered.push({ question: q.text, answer: desired, kind: q.type });
    }
    await page.waitForTimeout(250);
  }

  return { answered, unanswered };
}

export function guidelineFile(): string {
  return guidelinePath();
}
