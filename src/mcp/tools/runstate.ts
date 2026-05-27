// Run-state tools — the agent records durable progress so a workflow can be
// resumed and audited. Never put secrets in goal/vars/notes.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { guard, ok } from '../result.js';
import { runs } from '../runstate.js';

const STATUS = z.enum(['running', 'awaiting_human', 'paused', 'done', 'failed']);

export function registerRunStateTools(server: McpServer): void {
  server.registerTool(
    'run_begin',
    {
      title: 'Begin a run',
      description: 'Start a durable run-state record for a workflow you are about to drive. Returns the runId. Put the user\'s intent in `goal` and non-secret context (jobId, etc.) in `vars`.',
      inputSchema: {
        workflow: z.string().optional().describe('e.g. "seek/quick-apply".'),
        goal: z.string().optional().describe('The user\'s natural-language intent.'),
        vars: z.record(z.string(), z.unknown()).optional().describe('Non-secret context like { jobId }.'),
      },
    },
    async ({ workflow, goal, vars }) => guard(async () => ok(runs.begin({ workflow, goal, vars }) as unknown as Record<string, unknown>)),
  );

  server.registerTool(
    'run_note',
    {
      title: 'Note run progress',
      description: 'Append a progress note to the current (or named) run, optionally updating the current step pointer and status. Call this as you complete each meaningful workflow step.',
      inputSchema: {
        note: z.string(),
        currentStep: z.string().optional().describe('Step id you are now on / just finished.'),
        status: STATUS.optional(),
        runId: z.string().optional().describe('Defaults to the active run.'),
      },
    },
    async ({ note, currentStep, status, runId }) => guard(async () => ok(runs.note({ note, currentStep, status, runId }) as unknown as Record<string, unknown>)),
  );

  server.registerTool(
    'run_status',
    {
      title: 'Get run status',
      description: 'Read a run\'s durable state ("where were we?"). With no runId, returns the active run, or the most recently updated run after a restart.',
      inputSchema: { runId: z.string().optional() },
    },
    async ({ runId }) => guard(async () => {
      const r = runs.status(runId);
      return ok((r ?? { run: null }) as unknown as Record<string, unknown>, r ? `run ${r.runId}: ${r.status} (${r.workflow ?? 'no workflow'})` : 'no runs yet');
    }),
  );

  server.registerTool(
    'run_end',
    {
      title: 'End a run',
      description: 'Close the current (or named) run with a final status (default "done").',
      inputSchema: { status: STATUS.optional(), note: z.string().optional(), runId: z.string().optional() },
    },
    async ({ status, note, runId }) => guard(async () => ok(runs.end({ status, note, runId }) as unknown as Record<string, unknown>)),
  );
}
