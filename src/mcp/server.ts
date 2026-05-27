// Builds the career-ops MCP server: one McpServer with every tool/resource/
// prompt registered. Transport-agnostic — the http.ts / stdio.ts entrypoints
// each attach a transport to a fresh server built here.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerSeekTools } from './tools/seek.js';
import { registerRunStateTools } from './tools/runstate.js';
import { registerWorkflowTools } from './tools/workflow.js';
import { registerResources, registerPrompts } from './resources.js';

const INSTRUCTIONS = `career-ops drives a multi-source job pipeline (SEEK/LinkedIn/Indeed) and a
stateful, agent-driven browser. YOU are the reasoner: observe the page, decide one
atomic action, act, then observe again to verify.

Operating contract:
- Loop: browser_observe → reason → ONE atomic action → browser_observe. Refs are
  valid only for the most recent observe; a navigation invalidates them.
- One safe action per turn. If two targets are plausible, STOP and ask the user.
- Stop-and-ask when: a value you don't have (code/captcha/an employer answer not in
  the guideline), a destructive action (delete/submit), the same step failing twice,
  or the page matches no known step.
- When a tool returns status "needs_human_input", ask the user for exactly that value,
  then call back — the browser stays open server-side meanwhile.
- Secrets (email/codes/passwords) are passed as tool args, used immediately, and never
  logged or written to run-state/guidelines.
- NEVER submit a SEEK application unless the user authorized it AND SEEK_ALLOW_SUBMIT is
  true. Default is dry-run / stop at the review page.`;

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'career-ops', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  registerBrowserTools(server);
  registerCatalogTools(server);
  registerSeekTools(server);
  registerRunStateTools(server);
  registerWorkflowTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}
