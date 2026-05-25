// Agent engine — shared types for the layered human-behavior model.
//
//   L1 actions     — atomic Playwright primitives (click/type/…)
//   L2 perception  — pruned, ref-tagged snapshot of the live page
//   L3 resolver    — intent + snapshot → a single ActionDecision (LLM/vision)
//   L4 flow        — runs a Markdown narrative playbook step by step
//
// Everything here is platform-agnostic; SEEK-specific knowledge lives in the
// flow markdown and in src/shared/seek/, never in this module.

/** The atomic actions L1 knows how to perform. */
export type ActionType =
  | 'click'
  | 'type'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'upload'
  | 'press'
  | 'goto'
  | 'assert'
  | 'skip' // step not applicable to the current page (e.g. an absent banner)
  | 'done'; // flow goal reached / nothing left to do

/** Loose classification of a perceived element, for the resolver's benefit. */
export type NodeKind = 'button' | 'link' | 'input' | 'select' | 'textarea' | 'checkbox' | 'radio' | 'heading' | 'other';

/** One element kept in a perception snapshot. */
export type SnapshotNode = {
  /** Index into the snapshot. Also written to the DOM as data-agent-ref for this tick. */
  ref: number;
  kind: NodeKind;
  tag: string;
  /** True when the element is actionable (vs. heading/context-only). */
  interactive: boolean;
  /** Accessible name: aria-label / associated label / text / placeholder / value. */
  name: string;
  role?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  /** A stable selector recomputed each tick — what we persist to the cache. */
  locator: string;
};

/** A pruned view of the live page handed to the resolver. */
export type Snapshot = {
  url: string;
  title: string;
  /** Stable hash of (normalized url + present data-automation set + title). Cache key component. */
  signature: string;
  nodes: SnapshotNode[];
};

/** The single next action the resolver decided on. */
export type ActionDecision = {
  action: ActionType;
  /** Index into snapshot.nodes; null for goto/press/skip/done. */
  ref: number | null;
  /** Payload for type/select/press/goto. */
  value?: string;
  confidence: number; // 0..1
  reasoning?: string;
  /** Where the decision came from — for logging & telemetry. */
  source?: 'cache' | 'dom' | 'vision';
};

/** One step parsed out of a Markdown narrative flow. */
export type FlowStep = {
  /** Slug of the heading — stable cache key. Changing the heading re-resolves. */
  id: string;
  index: number;
  title: string;
  /** Full natural-language instruction (heading + body) shown to the resolver. */
  instruction: string;
};

/** A parsed Markdown narrative playbook. */
export type Flow = {
  id: string;
  title: string;
  /** Preamble before the first step — global context shown to the resolver every tick. */
  context: string;
  steps: FlowStep[];
};

/** Input to a resolver for one step. */
export type ResolveInput = {
  flow: Flow;
  step: FlowStep;
  snapshot: Snapshot;
  /** Optional screenshot for vision resolvers (DOM resolver ignores it). */
  screenshot?: Buffer;
  /** Short trailing log of what we already did, for context. */
  history?: string[];
};

/** L3 strategy interface — DOM (LLM-over-HTML) or vision (VLM-over-screenshot). */
export interface ElementResolver {
  readonly mode: 'dom' | 'vision';
  resolve(input: ResolveInput): Promise<ActionDecision>;
}
