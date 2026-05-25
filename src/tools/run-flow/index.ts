// run-flow — thin tool wrapper around the agent flow runner. Lets you execute
// any Markdown narrative playbook from flows/<id>.md and inspect the per-step
// outcome (action taken, whether it came from cache or the LLM resolver). The
// validation harness for the agent engine.
export { runFlow, loadFlow, parseFlow } from '../../shared/agent/flow.js';
export type { RunFlowOptions, RunFlowResult, StepOutcome } from '../../shared/agent/flow.js';
