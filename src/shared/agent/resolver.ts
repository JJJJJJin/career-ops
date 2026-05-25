// L3 — resolver. Maps a step's natural-language intent + the current snapshot
// to a single ActionDecision. Two strategies behind one interface:
//   • DomResolver    — LLM reads the pruned element list (default; cheap)
//   • VisionResolver  — VLM reads a screenshot (stubbed; DOM-only phase)
import { callJson } from '../llm/client.js';
import { createLogger } from '../logger.js';
import { renderNodesForPrompt } from './perception.js';
import type { ActionDecision, ActionType, ElementResolver, ResolveInput } from './types.js';

const log = createLogger('agent:resolver');

const VALID_ACTIONS: ActionType[] = [
  'click', 'type', 'select', 'check', 'uncheck', 'upload', 'press', 'goto', 'assert', 'skip', 'done',
];

const SYSTEM_PROMPT = `You are a careful browser-automation agent that behaves like a deliberate human.
You are given a PLAYBOOK (the overall flow), the CURRENT STEP to perform, and a
numbered list of ELEMENTS currently visible on the page. Decide the SINGLE next
atomic action that best accomplishes the CURRENT STEP — not the whole playbook.

Rules:
- Pick "ref" ONLY from the listed element numbers. Never invent a ref.
- If the current step clearly does not apply to this page (e.g. an optional
  banner that is not present), return action "skip".
- If the current step is already satisfied, or the flow's goal is reached,
  return action "done".
- For "type"/"select" include "value" (the text to enter / option to choose).
- For "press" set "value" to the key (e.g. "Enter"); for "goto" set "value" to the URL.
- For "click"/"check"/"uncheck"/"upload"/"assert" set "ref" and omit "value".
- Prefer elements whose name matches the step's intent. Be conservative:
  one safe action per call.
- Respond with STRICT JSON: {"action","ref","value","confidence","reasoning"}.
  "ref" is a number or null. "confidence" is 0..1. "reasoning" is one short sentence.`;

function buildUserPrompt(input: ResolveInput): string {
  const { flow, step, snapshot, history } = input;
  const hist = history && history.length ? `\nRECENT ACTIONS:\n${history.slice(-6).join('\n')}\n` : '';
  return `PLAYBOOK: ${flow.title}
${flow.context ? `${flow.context}\n` : ''}
CURRENT STEP (#${step.index + 1}): ${step.instruction}
${hist}
PAGE: ${snapshot.title}  <${snapshot.url}>
ELEMENTS:
${renderNodesForPrompt(snapshot.nodes)}

Return the JSON for the single next action.`;
}

type RawDecision = {
  action?: string;
  ref?: number | null;
  value?: string | null;
  confidence?: number;
  reasoning?: string;
};

function sanitize(raw: RawDecision, nodeCount: number): ActionDecision {
  const action = (VALID_ACTIONS as string[]).includes(raw.action ?? '')
    ? (raw.action as ActionType)
    : 'skip';
  let ref: number | null = typeof raw.ref === 'number' ? raw.ref : null;
  // A ref is only meaningful for element-targeting actions.
  const needsRef = ['click', 'type', 'select', 'check', 'uncheck', 'upload', 'assert'].includes(action);
  if (ref !== null && (ref < 0 || ref >= nodeCount)) ref = null;
  if (!needsRef) ref = action === 'skip' || action === 'done' ? null : ref;
  const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
  return {
    action,
    ref,
    value: raw.value ?? undefined,
    confidence,
    reasoning: raw.reasoning,
    source: 'dom',
  };
}

export class DomResolver implements ElementResolver {
  readonly mode = 'dom' as const;

  async resolve(input: ResolveInput): Promise<ActionDecision> {
    const raw = await callJson<RawDecision>({
      step: `agent-resolve:${input.flow.id}:${input.step.id}`,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(input),
      temperature: 0,
      maxTokens: 400,
    });
    const decision = sanitize(raw, input.snapshot.nodes.length);
    log.info(
      { flow: input.flow.id, step: input.step.id, action: decision.action, ref: decision.ref, conf: decision.confidence },
      'resolved (dom)',
    );
    return decision;
  }
}

/**
 * Vision strategy — same interface, implemented later. Kept as a class so the
 * flow runner can switch resolvers without code changes once a vision-capable
 * model is wired (needs VISION_MODEL + image input on the LLM client).
 */
export class VisionResolver implements ElementResolver {
  readonly mode = 'vision' as const;

  async resolve(_input: ResolveInput): Promise<ActionDecision> {
    throw new Error(
      'VisionResolver not implemented yet (DOM-only phase). Set the resolver to DOM, or wire a vision model.',
    );
  }
}

export function defaultResolver(): ElementResolver {
  return new DomResolver();
}
