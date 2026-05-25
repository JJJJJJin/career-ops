// Selector cache — the performance core. A hit means the flow runner skips
// the LLM resolver entirely and acts on the stored locator directly. Backed by
// the selector_cache SQLite table (see db/schema). Keyed by (flow, step, page
// signature) so the same step on a differently-shaped page re-resolves.
import type { Page } from 'playwright';
import { db } from '../db/store.js';
import { createLogger } from '../logger.js';
import type { ActionDecision, ActionType } from './types.js';

const log = createLogger('agent:cache');

export type CachedAction = {
  action: ActionType;
  locator: string | null;
  value?: string;
  confidence: number | null;
};

export function readCache(flowId: string, stepId: string, pageSig: string): CachedAction | null {
  const row = db.getSelectorCache(flowId, stepId, pageSig);
  if (!row) return null;
  return {
    action: row.action as ActionType,
    locator: row.locator,
    value: row.valueTmpl ?? undefined,
    confidence: row.confidence,
  };
}

export function writeCache(
  flowId: string,
  stepId: string,
  pageSig: string,
  decision: ActionDecision,
  locator: string | null,
): void {
  db.putSelectorCache({
    flowId,
    stepId,
    pageSig,
    action: decision.action,
    locator,
    valueTmpl: decision.value ?? null,
    confidence: decision.confidence,
  });
  log.debug({ flowId, stepId, pageSig, action: decision.action }, 'cache write');
}

export function bumpHit(flowId: string, stepId: string, pageSig: string): void {
  db.bumpSelectorCacheHit(flowId, stepId, pageSig);
}

export function invalidate(flowId: string, stepId: string, pageSig: string): void {
  db.deleteSelectorCache(flowId, stepId, pageSig);
  log.debug({ flowId, stepId, pageSig }, 'cache invalidate');
}

/**
 * A cached locator is only trustworthy if it still resolves to exactly one
 * visible element. Element-free actions (skip/done/press) need no locator.
 */
export async function isLocatorValid(page: Page, locator: string | null, action: ActionType): Promise<boolean> {
  if (action === 'skip' || action === 'done' || action === 'press' || action === 'goto') return true;
  if (!locator) return false;
  try {
    const loc = page.locator(locator);
    const count = await loc.count();
    if (count !== 1) return false;
    // upload targets (file inputs) are often visually hidden — existence is enough.
    if (action === 'upload') return true;
    return await loc.first().isVisible();
  } catch {
    return false;
  }
}
