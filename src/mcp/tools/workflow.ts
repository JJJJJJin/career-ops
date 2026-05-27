// Workflow tools — discover/read the agent-facing playbooks, and the
// propose→confirm→apply self-correction loop. The agent never auto-writes a
// guideline: it proposes a diff, shows the user, and only applies on a yes.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { guard, ok } from '../result.js';
import { applyFix, listPlaybooks, loadContract, loadPlaybook, proposeFix } from '../playbooks.js';

export function registerWorkflowTools(server: McpServer): void {
  server.registerTool(
    'workflow_list',
    { title: 'List playbooks', description: 'List available workflow playbook ids (e.g. "seek/login", "seek/quick-apply").' },
    async () => guard(async () => {
      const ids = listPlaybooks();
      return ok({ playbooks: ids }, ids.join('\n'));
    }),
  );

  server.registerTool(
    'workflow_get',
    {
      title: 'Get a playbook',
      description:
        'Read a workflow playbook by id. Returns the shared operating contract followed by the playbook markdown (the step-by-step guideline you follow). Always read the relevant playbook before driving a workflow.',
      inputSchema: { id: z.string().describe('Playbook id, e.g. "seek/quick-apply".') },
    },
    async ({ id }) => guard(async () => {
      const pb = loadPlaybook(id);
      const text = `${loadContract()}\n\n---\n\n${pb.markdown}`;
      return ok({ id, title: pb.title, stepIds: pb.steps.map((s) => s.id), markdown: pb.markdown }, text);
    }),
  );

  server.registerTool(
    'workflow_propose_fix',
    {
      title: 'Propose a playbook fix',
      description:
        'After diagnosing a failed step (with the user), stage an improved instruction for it. Returns a diff WITHOUT writing. Show the diff to the user; only call workflow_apply_fix on their explicit yes. `newText` replaces the step body (everything under its heading); pass `newTitle` only to rename the step. Never include secrets.',
      inputSchema: {
        workflow: z.string().describe('Playbook id, e.g. "seek/login".'),
        stepId: z.string().describe('The failing step id (see workflow_get stepIds).'),
        newText: z.string().describe('The improved step body (markdown).'),
        rationale: z.string().describe('Why this fix — what went wrong and how this prevents it.'),
        newTitle: z.string().optional().describe('Only to rename the step heading.'),
      },
    },
    async ({ workflow, stepId, newText, rationale, newTitle }) =>
      guard(async () => {
        const p = proposeFix({ workflow, stepId, newText, rationale, newTitle });
        return ok(p as unknown as Record<string, unknown>, `Proposed fix ${p.fixId} for ${workflow} › ${stepId}. Show this diff to the user and apply only on their yes:\n\n${p.diff}`);
      }),
  );

  server.registerTool(
    'workflow_apply_fix',
    {
      title: 'Apply a proposed fix',
      description: 'Write a previously proposed fix to the playbook (only after the user approved the diff). Also appends an audit record. Use the fixId from workflow_propose_fix.',
      inputSchema: { fixId: z.string() },
    },
    async ({ fixId }) => guard(async () => ok(applyFix(fixId) as unknown as Record<string, unknown>, 'fix applied — the next run reads the improved step')),
  );
}
