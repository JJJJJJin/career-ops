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
import { journal } from '../agent/journal.js';
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
// Group by name="questionnaire.<QID>" — robust across control types (select,
// radio, checkbox, text/number, textarea), unlike scanning id="question-*"
// containers (which misses checkbox groups and container-is-the-control cases).
export async function extractQuestions(page: Page): Promise<SeekQuestion[]> {
  return page.evaluate(() => {
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const optLabel = (el: Element): string => {
      const id = (el as HTMLElement).id;
      const l = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return norm(l?.textContent) || norm(el.getAttribute('value'));
    };
    const prompt = (els: Element[], isGroup: boolean): string => {
      const first = els[0]!;
      // For single controls (select/text/textarea), the control's own label/aria
      // IS the question. For radio/checkbox GROUPS it would be an option label,
      // so skip control-level and use the group's legend/heading instead.
      if (!isGroup) {
        const lb = first.getAttribute('aria-labelledby');
        if (lb) { const t = norm(lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')); if (t) return t; }
        const id = first.getAttribute('id');
        if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (norm(l?.textContent)) return norm(l?.textContent); }
      }
      const grp = first.closest('[role="group"], [role="radiogroup"], fieldset');
      if (grp) {
        const lb = grp.getAttribute('aria-labelledby');
        if (lb) { const t = norm(lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')); if (t) return t; }
        const lg = grp.querySelector('legend');
        if (norm(lg?.textContent)) return norm(lg?.textContent);
      }
      let n: Element | null = first;
      for (let i = 0; i < 8 && n; i++) { n = n.parentElement; if (!n) break;
        const h = n.querySelector('legend, strong, h3, h4'); // not <label> — those are option labels
        if (norm(h?.textContent)) return norm(h?.textContent).slice(0, 160);
      }
      return '(unknown question)';
    };

    const controls = Array.from(document.querySelectorAll('[name^="questionnaire"]'));
    const groups = new Map<string, Element[]>();
    for (const c of controls) {
      const name = c.getAttribute('name') ?? '';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(c);
    }

    const out: { qid: string; name: string; text: string; type: string; options: string[]; currentValue: string }[] = [];
    for (const [name, els] of groups) {
      const qid = name.replace(/^questionnaire\./, '');
      const first = els[0]!;
      const tag = first.tagName.toLowerCase();
      const type = (first.getAttribute('type') ?? '').toLowerCase();
      if (tag === 'select') {
        const sel = first as HTMLSelectElement;
        out.push({ qid, name, text: prompt(els, false), type: 'select', options: Array.from(sel.options).map((o) => norm(o.textContent)).filter(Boolean), currentValue: norm(sel.options[sel.selectedIndex]?.textContent) });
      } else if (type === 'radio') {
        const checked = els.find((e) => (e as HTMLInputElement).checked);
        out.push({ qid, name, text: prompt(els, true), type: 'radio', options: els.map(optLabel), currentValue: checked ? optLabel(checked) : '' });
      } else if (type === 'checkbox') {
        const checked = els.filter((e) => (e as HTMLInputElement).checked).map(optLabel);
        out.push({ qid, name, text: prompt(els, true), type: 'checkbox', options: els.map(optLabel), currentValue: checked.join(' | ') });
      } else {
        const t = tag === 'textarea' ? 'textarea' : type === 'number' ? 'number' : 'text';
        out.push({ qid, name, text: prompt(els, false), type: t, options: [], currentValue: (first as HTMLInputElement).value });
      }
    }
    return out as SeekQuestion[];
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
  for (const q of newOnes) journal.note(`captured NEW question (needs your answer): "${q.text}"`, { qid: q.qid, type: q.type });
  return newOnes;
}

// ─── answering (guideline-driven, deterministic) ────────────────────────────
function matchOption(options: string[], answer: string): string | null {
  const a = answer.trim().toLowerCase();
  if (!a) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    options.find((o) => o.trim().toLowerCase() === a) ?? // exact
    options.find((o) => o.trim().toLowerCase().includes(a)) ?? // option contains the answer
    // answer contains the option AS A WHOLE WORD (so "Typescript" doesn't match
    // the option "C" via the stray 'c', but "1 year intern" still matches "1 year")
    options.find((o) => o.trim() && new RegExp(`\\b${esc(o.trim().toLowerCase())}\\b`).test(a)) ??
    null
  );
}

/**
 * Click the radio/checkbox in a name-group whose label matches `optLabel`.
 * Scoped by the control's name (the checkbox group has no question-<id> wrapper).
 * For checkboxes pass idempotent=true so an already-checked box isn't toggled off.
 */
async function clickChoiceByLabel(page: Page, name: string, optLabel: string, idempotent = false): Promise<boolean> {
  const found = await page.evaluate(
    ({ name, optLabel }) => {
      const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const inputs = Array.from(document.querySelectorAll(`input[name="${name}"]`)) as HTMLInputElement[];
      for (const inp of inputs) {
        const l = inp.id ? document.querySelector(`label[for="${CSS.escape(inp.id)}"]`) : null;
        const text = norm(l?.textContent) || norm(inp.getAttribute('value'));
        if (text.toLowerCase() === optLabel.toLowerCase()) return { id: inp.id, checked: inp.checked };
      }
      return null;
    },
    { name, optLabel },
  );
  if (!found?.id) return false;
  if (idempotent && found.checked) return true;
  await page.locator(`label[for="${found.id}"]`).first().click({ timeout: 6000 });
  return true;
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
      await clickChoiceByLabel(page, q.name, opt);
      answered.push({ question: q.text, answer: opt, kind: 'radio' });
    } else if (q.type === 'checkbox') {
      // Multi-select: the answer may list several options (| or , separated).
      const wanted = desired.split(/\s*[|,]\s*/).map((s) => s.trim()).filter(Boolean);
      const picked: string[] = [];
      for (const w of wanted) {
        const opt = matchOption(q.options, w);
        if (opt && !picked.includes(opt) && (await clickChoiceByLabel(page, q.name, opt, true))) picked.push(opt);
      }
      if (!picked.length) { unanswered.push(q); continue; }
      answered.push({ question: q.text, answer: picked.join(', '), kind: 'checkbox' });
    } else {
      // text / number / textarea
      await page.locator(`[name="${q.name}"]`).first().fill(desired);
      answered.push({ question: q.text, answer: desired, kind: q.type });
    }
    await page.waitForTimeout(250);
  }

  for (const a of answered) journal.note(`Q answered: "${a.question}" → "${a.answer}"`, { kind: a.kind });
  for (const u of unanswered) journal.fail(`Q has no usable guideline answer: "${u.text}"`, { qid: u.qid, type: u.type });
  return { answered, unanswered };
}

export function guidelineFile(): string {
  return guidelinePath();
}
