// MCP resources + prompts.
//
// Resources expose read-only context the agent can pull: the operating
// contract, each playbook, the employer-answers guideline, the live run-state,
// and the structured profile. Prompts seed a workflow by injecting the contract
// + the relevant playbook so a single "/seek-apply" gets the agent fully briefed.
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config, profileJsonPath } from '../shared/config.js';
import { listPlaybooks, loadContract, loadPlaybook } from './playbooks.js';
import { runs } from './runstate.js';

function seekAnswersPath(): string {
  return path.join(config.paths.profileDir, 'seek-answers.md');
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    'operating-contract',
    'playbook://contract',
    { title: 'Operating contract', description: 'How to drive the agent loop, stop-and-ask, self-correct, and the safety rules.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: loadContract() }] }),
  );

  for (const id of listPlaybooks()) {
    server.registerResource(
      `playbook-${id.replace(/\//g, '-')}`,
      `playbook://${id}`,
      { title: `Playbook: ${id}`, description: `Step-by-step guideline for ${id}.`, mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: loadPlaybook(id).markdown }] }),
    );
  }

  server.registerResource(
    'seek-answers',
    'guideline://seek-answers',
    { title: 'SEEK employer-question answers', description: 'The user-authored standard answers the agent fills from (never guesses).', mimeType: 'text/markdown' },
    async (uri) => {
      const p = seekAnswersPath();
      const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '(no guideline yet — captured questions are appended here)';
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  server.registerResource(
    'run-current',
    'run://current',
    { title: 'Current run-state', description: 'Durable progress of the active (or most recent) workflow run.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(runs.status() ?? { run: null }, null, 2) }] }),
  );

  server.registerResource(
    'profile-json',
    'profile://json',
    { title: 'Structured profile', description: 'profile/profile.json — the distilled CV the generators use.', mimeType: 'application/json' },
    async (uri) => {
      const p = profileJsonPath();
      const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '{}';
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    },
  );
}

function brief(playbookId: string, lead: string): { messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } {
  const text = `${lead}\n\n${loadContract()}\n\n---\n\n${loadPlaybook(playbookId).markdown}`;
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'seek-apply',
    { title: 'SEEK quick-apply', description: 'Brief the agent to drive a SEEK quick-apply for one job (stops at review by default).', argsSchema: { jobId: z.string().describe('SEEK job id to apply to.') } },
    ({ jobId }) => brief('seek/quick-apply', `Drive a SEEK quick-apply for job ${jobId}. Follow the playbook. Stop at the review page unless the user authorizes submission.`),
  );

  server.registerPrompt(
    'seek-batch-apply',
    { title: 'SEEK batch apply', description: 'Brief the agent to apply to a LIST of SEEK URLs: quick-apply jobs driven (stop at review), external jobs reported for manual apply, resume slots cleaned up every N.' },
    () => brief('seek/batch-apply', 'Apply to these SEEK job URLs following the playbook. Drive only quick-apply jobs (stop each at review for me to submit); collect external jobs and report them at the end for me to do manually; manage resume cleanup. Paste your URLs and I\'ll begin.'),
  );

  server.registerPrompt(
    'seek-login',
    { title: 'SEEK login', description: 'Brief the agent to sign in to SEEK (passwordless emailed code).' },
    () => brief('seek/login', 'Sign in to SEEK following the playbook. Ask me for the emailed code when you reach that step.'),
  );

  server.registerPrompt(
    'seek-search-triage',
    { title: 'Search & triage', description: 'Brief the agent to search a board and triage matches.' },
    () => brief('seek/search-triage', 'Search and triage jobs following the playbook, then give me a ranked shortlist.'),
  );
}
