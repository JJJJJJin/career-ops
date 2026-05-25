// (C) Resume document management — the rolling-window slot.
//
// SEEK caps saved resumes at 10. Auto-apply uploads a fresh tailored PDF per
// job, so when the list is full we delete the OLDEST non-default resume to make
// room, then upload the new one. The "Default" resume is never deleted.
//
// Split of concerns: list-reading and the file upload are deterministic (the
// manage UI has stable data-automation selectors, and a file <input> can only
// be driven by setInputFiles — an LLM can't click a native file dialog). Only
// the per-item delete (open ⋮ menu → Delete → confirm) goes through the agent
// flow, since menus/confirm dialogs vary. The delete flow is never cached
// (it's destructive and filename-specific).
import path from 'node:path';
import fs from 'node:fs';
import type { Page } from 'playwright';
import type { BrowserSession } from '../browser/session.js';
import { createLogger } from '../logger.js';
import { RESUME } from './selectors.js';

const log = createLogger('seek:documents');

export type SavedResume = { id: string; filename: string; isDefault: boolean };

async function openManager(page: Page): Promise<void> {
  if (!page.url().includes('/profile/me/resume')) {
    await page.goto(RESUME.managerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForSelector(RESUME.list, { timeout: 15_000 });
}

/** Open the manager and return the saved-resume list (read-only). */
export async function getSavedResumes(session: BrowserSession): Promise<SavedResume[]> {
  await openManager(session.page);
  return listResumes(session.page);
}

/** Read the saved-resume list in display order (newest first; Default pinned). */
export async function listResumes(page: Page): Promise<SavedResume[]> {
  return page.evaluate(
    ({ itemPrefix, defaultPrefix, listSel }) => {
      // Scope to the manager's list container. The profile page underneath the
      // manager drawer ALSO has a resume-item for the default resume, which
      // would otherwise be double-counted.
      const root = document.querySelector(listSel) ?? document;
      const items = Array.from(root.querySelectorAll(`[data-automation^="${itemPrefix}"]`)).filter((el) => {
        const da = el.getAttribute('data-automation') ?? '';
        // resume-item-<uuid> only — exclude resume-item-list.
        return new RegExp(`^${itemPrefix}[0-9a-f-]{8,}$`).test(da);
      });
      return items.map((el) => {
        const da = el.getAttribute('data-automation') ?? '';
        const id = da.slice(itemPrefix.length);
        let t = (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
        // Strip any leading badges ("New", "Default", "New Default") and the
        // trailing "Added … ago" so what's left is exactly the filename.
        t = t.replace(/^(?:(?:New|Default)\s+)+/i, '').replace(/\s*Added .*$/i, '').trim();
        const isDefault = !!el.querySelector(`[data-automation^="${defaultPrefix}"]`);
        return { id, filename: t, isDefault };
      });
    },
    { itemPrefix: RESUME.itemPrefix, defaultPrefix: RESUME.defaultPrefix, listSel: RESUME.list },
  );
}

/**
 * Delete one saved resume. Deterministic (not LLM-driven): destructive actions
 * shouldn't depend on the resolver, and the manager's data-automation hooks are
 * stable. Opens the resume's ⋮ menu by filename, clicks Delete by id, confirms.
 */
async function deleteResume(page: Page, resume: SavedResume): Promise<void> {
  log.info({ filename: resume.filename, id: resume.id }, 'deleting saved resume to free a slot');
  await page.locator(RESUME.optionsFor(resume.filename)).first().click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await page.locator(RESUME.deleteButton(resume.id)).first().click({ timeout: 8000 });
  // A confirm dialog may follow — click its confirm button if present.
  const confirm = page.locator(
    '[role="dialog"] button:has-text("Delete"), [role="alertdialog"] button:has-text("Delete"), button:has-text("Yes, delete")',
  );
  if (await confirm.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await confirm.first().click({ timeout: 5000 });
  }
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

/** Upload a PDF via the hidden file input (setInputFiles — no native dialog). */
async function uploadResume(page: Page, pdfPath: string): Promise<void> {
  const input = page.locator(RESUME.fileInput).first();
  await input.setInputFiles(pdfPath, { timeout: 15_000 });
  // Wait for the new item to register in the list.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

export type RotateResult = {
  /** Filename now saved on SEEK (basename of the uploaded PDF). */
  filename: string;
  /** Filename deleted to make room, if any. */
  deleted?: string;
  /** Saved-resume count after the operation. */
  count: number;
};

/**
 * Ensure `pdfPath` is uploaded as a saved resume, deleting the oldest
 * non-default resume first if the list is full. Returns the saved filename so
 * the quick-apply step can select it.
 */
export async function rotateUploadResume(session: BrowserSession, pdfPath: string): Promise<RotateResult> {
  if (!fs.existsSync(pdfPath)) throw new Error(`resume PDF not found: ${pdfPath}`);
  const page = session.page;
  const wanted = path.basename(pdfPath);

  await openManager(page);
  let resumes = await listResumes(page);

  // Already uploaded under this name? (idempotent re-runs)
  if (resumes.some((r) => r.filename === wanted)) {
    log.info({ wanted }, 'resume already saved — skipping upload');
    return { filename: wanted, count: resumes.length };
  }

  let deleted: string | undefined;
  if (resumes.length >= RESUME.limit) {
    const nonDefault = resumes.filter((r) => !r.isDefault);
    const victim = nonDefault[nonDefault.length - 1]; // oldest in display order
    if (!victim) {
      throw new Error('resume list is full but only the Default remains — refusing to delete it. Free a slot manually.');
    }
    await deleteResume(page, victim);
    deleted = victim.filename;
    await openManager(page);
  }

  await uploadResume(page, pdfPath);
  resumes = await listResumes(page);
  if (!resumes.some((r) => r.filename === wanted)) {
    log.warn({ wanted, have: resumes.map((r) => r.filename) }, 'uploaded resume not found in list after upload');
  }
  log.info({ filename: wanted, deleted, count: resumes.length }, 'resume rotation complete');
  return { filename: wanted, deleted, count: resumes.length };
}
