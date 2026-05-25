// L4 — flow runner. Parses a Markdown narrative playbook and executes it step
// by step: perceive → (cache hit ? use it : resolve via LLM) → atomic action.
// The selector cache makes steady-state runs nearly LLM-free, which is what
// keeps this affordable on a Raspberry Pi.
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserSession } from '../browser/session.js';
import { launchSession, closeSession } from '../browser/session.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { slug } from '../slug.js';
import * as actions from './actions.js';
import { bumpHit, invalidate, isLocatorValid, readCache, writeCache } from './cache.js';
import { snapshotDom, screenshot } from './perception.js';
import { defaultResolver } from './resolver.js';
import type { ActionDecision, ActionType, ElementResolver, Flow, FlowStep } from './types.js';

const log = createLogger('agent:flow');

// ─── parsing ────────────────────────────────────────────────────────────
const HEADING_RE = /^(#{1,3})\s+(.*)$/;

export function parseFlow(id: string, markdown: string): Flow {
  const lines = markdown.split('\n');
  let title = id;
  const contextLines: string[] = [];
  const steps: FlowStep[] = [];
  const usedIds = new Map<string, number>();

  let current: { title: string; body: string[] } | null = null;
  let sawTitle = false;

  const pushStep = (): void => {
    if (!current) return;
    let base = slug(current.title) || `step-${steps.length + 1}`;
    const n = usedIds.get(base) ?? 0;
    usedIds.set(base, n + 1);
    if (n > 0) base = `${base}-${n + 1}`;
    const body = current.body.join('\n').trim();
    steps.push({
      id: base,
      index: steps.length,
      title: current.title,
      instruction: body ? `${current.title}\n${body}` : current.title,
    });
  };

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      const level = m[1]!.length;
      const text = m[2]!.trim();
      if (level === 1 && !sawTitle && steps.length === 0 && !current) {
        title = text.replace(/^flow:\s*/i, '');
        sawTitle = true;
        continue;
      }
      // Any ## / ### (or a second #) starts a step.
      pushStep();
      current = { title: text.replace(/^flow:\s*/i, ''), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else contextLines.push(line);
  }
  pushStep();

  return { id, title, context: contextLines.join('\n').trim(), steps };
}

function flowPath(id: string): string {
  return path.join(config.repoRoot, 'flows', `${id}.md`);
}

export function loadFlow(id: string): Flow {
  const p = flowPath(id);
  if (!fs.existsSync(p)) throw new Error(`flow not found: ${p}`);
  return parseFlow(id, fs.readFileSync(p, 'utf-8'));
}

// ─── execution ──────────────────────────────────────────────────────────
export type RunFlowOptions = {
  /** Navigate here before the first step. */
  startUrl?: string;
  /** {{key}} substitutions applied to each step's instruction. */
  context?: Record<string, string>;
  /** Reuse an existing session (batch runs share one login). */
  session?: BrowserSession;
  /** Skip the selector cache (force fresh LLM resolution). */
  noCache?: boolean;
  headless?: boolean;
  /** Per-action confidence floor below which we stop and screenshot. */
  minConfidence?: number;
  resolver?: ElementResolver;
  /** Hard cap on steps as a runaway guard. */
  maxSteps?: number;
};

export type StepOutcome = {
  step: string;
  action: string;
  ref: number | null;
  source: ActionDecision['source'];
  ok: boolean;
  note?: string;
};

export type RunFlowResult = {
  flowId: string;
  completed: boolean;
  outcomes: StepOutcome[];
  failedStep?: string;
  screenshotPath?: string;
};

function substitute(text: string, ctx?: Record<string, string>): string {
  if (!ctx) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => ctx[k] ?? `{{${k}}}`);
}

// Block heavy resources — big RAM/bandwidth saver on a Pi; SEEK SPA still needs JS+CSS.
async function blockHeavyResources(session: BrowserSession): Promise<void> {
  await session.context.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });
}

async function execute(session: BrowserSession, action: ActionType, locator: string, value: string): Promise<void> {
  const { page } = session;
  const loc = page.locator(locator).first();
  switch (action) {
    case 'click': await actions.click(loc); break;
    case 'type': await actions.type(loc, value); break;
    case 'select': await actions.selectOption(loc, value); break;
    case 'check': await actions.check(loc); break;
    case 'uncheck': await actions.uncheck(loc); break;
    case 'upload': await actions.uploadFile(loc, value); break;
    case 'press': await actions.press(page, value || 'Enter'); break;
    case 'goto': await actions.goto(page, value); break;
    case 'assert': {
      const ok = await actions.assertVisible(loc);
      if (!ok) throw new Error(`assert failed: ${locator} not visible`);
      break;
    }
    case 'skip':
    case 'done':
      break;
  }
}

export async function runFlow(flowId: string, opts: RunFlowOptions = {}): Promise<RunFlowResult> {
  const flow = loadFlow(flowId);
  const resolver = opts.resolver ?? defaultResolver();
  const minConfidence = opts.minConfidence ?? 0.35;
  const maxSteps = opts.maxSteps ?? flow.steps.length + 5;

  const ownSession = !opts.session;
  const session = opts.session ?? (await launchSession({ headless: opts.headless }));
  const outcomes: StepOutcome[] = [];
  const history: string[] = [];
  let completed = false;
  let failedStep: string | undefined;
  let screenshotPath: string | undefined;

  try {
    if (ownSession) await blockHeavyResources(session);
    if (opts.startUrl) await actions.goto(session.page, opts.startUrl);

    let i = 0;
    for (const step of flow.steps) {
      if (i++ >= maxSteps) break;
      // NB: we deliberately do NOT substitute {{tokens}} into the instruction.
      // The resolver sees (and may cache/log) only the token, never the secret.
      // Tokens are resolved into the real value at execution time only.
      let snap = await snapshotDom(session.page);
      // A near-empty snapshot means the page is mid-load (common right after a
      // navigation — the SPA form hasn't painted). Settle and re-snapshot once
      // so we don't ask the resolver to find a field that isn't there yet.
      if (snap.nodes.filter((n) => n.interactive).length < 4) {
        await session.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await actions.jitter(900, 1500);
        snap = await snapshotDom(session.page);
      }
      const pageSig = snap.signature;

      let decision: ActionDecision | null = null;
      let execLocator: string | null = null;

      // 1) Try the cache.
      if (!opts.noCache) {
        const cached = readCache(flow.id, step.id, pageSig);
        if (cached && (await isLocatorValid(session.page, cached.locator, cached.action))) {
          decision = {
            action: cached.action,
            ref: null,
            value: cached.value, // token form; substituted at execution only
            confidence: cached.confidence ?? 1,
            source: 'cache',
          };
          execLocator = cached.locator;
          bumpHit(flow.id, step.id, pageSig);
          log.info({ step: step.id, action: decision.action }, 'cache hit');
        }
      }

      // The stable selector to persist *iff* this fresh action succeeds.
      // undefined = nothing to cache (e.g. skip). null = cache an element-free
      // action (press/goto). We only write after execution succeeds, so a
      // broken action never poisons the cache.
      let cacheLocator: string | null | undefined;

      // 2) Cache miss → ask the resolver.
      if (!decision) {
        const fresh = await resolver.resolve({ flow, step, snapshot: snap, history });
        decision = fresh;
        if (fresh.action !== 'skip' && fresh.action !== 'done' && fresh.confidence < minConfidence) {
          screenshotPath = await dumpFailure(session, flow.id, step.id);
          failedStep = step.id;
          outcomes.push({ step: step.id, action: fresh.action, ref: fresh.ref, source: fresh.source, ok: false, note: `low confidence ${fresh.confidence}` });
          break;
        }
        if (fresh.ref !== null && fresh.ref >= 0 && fresh.ref < snap.nodes.length) {
          execLocator = `[data-agent-ref="${fresh.ref}"]`;
          cacheLocator = snap.nodes[fresh.ref]!.locator; // the *stable* selector
        } else if (fresh.action === 'press' || fresh.action === 'goto') {
          cacheLocator = null;
        }
      }

      // 3) Execute.
      try {
        if (decision.action === 'done') {
          outcomes.push({ step: step.id, action: 'done', ref: null, source: decision.source, ok: true });
          completed = true;
          break;
        }
        if (decision.action === 'skip') {
          outcomes.push({ step: step.id, action: 'skip', ref: decision.ref, source: decision.source, ok: true });
          history.push(`step "${step.title}" → skip`);
          continue;
        }
        // Resolve {{tokens}} into the real value here and nowhere else.
        const execValue = substitute(decision.value ?? '', opts.context);
        await execute(session, decision.action, execLocator ?? '', execValue);
        // Cache only what worked, and only when it came fresh from the resolver.
        if (decision.source !== 'cache' && cacheLocator !== undefined) {
          writeCache(flow.id, step.id, pageSig, decision, cacheLocator);
        }
        outcomes.push({ step: step.id, action: decision.action, ref: decision.ref, source: decision.source, ok: true });
        history.push(`step "${step.title}" → ${decision.action}${decision.value ? ` "${decision.value}"` : ''}`);
        // settle: let any navigation / SPA transition land before next snapshot.
        await session.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        await session.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await actions.jitter(300, 700);
      } catch (err) {
        screenshotPath = await dumpFailure(session, flow.id, step.id);
        failedStep = step.id;
        outcomes.push({ step: step.id, action: decision.action, ref: decision.ref, source: decision.source, ok: false, note: (err as Error).message });
        // A cached locator that broke at execution time is stale — drop it.
        if (decision.source === 'cache') invalidate(flow.id, step.id, pageSig);
        break;
      }
    }
    if (i >= flow.steps.length && !failedStep) completed = true;
  } finally {
    if (ownSession) await closeSession(session);
  }

  return { flowId: flow.id, completed, outcomes, failedStep, screenshotPath };
}

async function dumpFailure(session: BrowserSession, flowId: string, stepId: string): Promise<string> {
  const dir = path.join(config.paths.reportsDir, 'agent-debug');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${flowId.replace(/\//g, '_')}-${stepId}-${Date.now()}.jpg`);
  try {
    const buf = await screenshot(session.page);
    fs.writeFileSync(out, buf);
    log.warn({ stepId, screenshot: out }, 'flow: step failed — screenshot saved');
  } catch {
    /* best effort */
  }
  return out;
}
