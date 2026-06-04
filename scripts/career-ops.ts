#!/usr/bin/env -S npx tsx
// career-ops — the OFFLINE / SCRIPT entry point. Any agent can run every
// capability here without the MCP server:
//
//   npx tsx scripts/career-ops.ts <command> [args]
//   npm run career-ops -- <command> [args]
//
// Each command lives in scripts/cmd/<command>.ts as a thin `runCli(argv)` that
// parses args, calls the REUSABLE CORE in src/ (src/tools/*/index.ts,
// src/workflows/*), and prints. The exact same core functions are exposed over
// MCP (src/mcp/) — scripts and MCP share one implementation, zero duplication.
//
// To learn what a command does, read its scripts/cmd/<command>.ts (args + output)
// and the src/ core it calls. Run a command with no args to see its usage.

const COMMANDS: Record<string, () => Promise<{ runCli: (argv: string[]) => Promise<void> }>> = {
  // discovery & ingestion
  'seek-search': () => import('./cmd/seek-search.js'),
  'seek-extract': () => import('./cmd/seek-extract.js'),
  'linkedin-search': () => import('./cmd/linkedin-search.js'),
  'linkedin-extract': () => import('./cmd/linkedin-extract.js'),
  'indeed-search': () => import('./cmd/indeed-search.js'),
  'indeed-extract': () => import('./cmd/indeed-extract.js'),
  'builtin-search': () => import('./cmd/builtin-search.js'),
  'builtin-extract': () => import('./cmd/builtin-extract.js'),
  'web-distill': () => import('./cmd/web-distill.js'),

  // content library
  'parse-library': () => import('./cmd/parse-library.js'),

  // evaluation
  'flag-eligibility': () => import('./cmd/flag-eligibility.js'),
  'summarize-job': () => import('./cmd/summarize-job.js'),
  'classify-jd': () => import('./cmd/classify-jd.js'),
  'go-no-go': () => import('./cmd/go-no-go.js'),
  'match-job': () => import('./cmd/match-job.js'),
  'evaluate-job': () => import('./cmd/evaluate-job.js'),

  // generation
  'assemble-resume': () => import('./cmd/assemble-resume.js'),
  'generate-cover-letter': () => import('./cmd/generate-cover-letter.js'),
  'generate-company-brief': () => import('./cmd/generate-company-brief.js'),
  'outreach-draft': () => import('./cmd/outreach-draft.js'),
  'gap-report': () => import('./cmd/gap-report.js'),

  // rendering
  'render-resume-pdf': () => import('./cmd/render-resume-pdf.js'),
  'render-cover-letter-pdf': () => import('./cmd/render-cover-letter-pdf.js'),
  'render-company-brief-pdf': () => import('./cmd/render-company-brief-pdf.js'),

  // delivery
  'send-files': () => import('./cmd/send-files.js'),

  // tracking
  'query-jobs': () => import('./cmd/query-jobs.js'),
  'show-job': () => import('./cmd/show-job.js'),
  'mark-job': () => import('./cmd/mark-job.js'),
  'job-stats': () => import('./cmd/job-stats.js'),
  'render-tracker': () => import('./cmd/render-tracker.js'),
  'tracker-sync': () => import('./cmd/tracker-sync.js'),

  // workflows
  'apply-job': () => import('./cmd/apply-job.js'),
  'daily-pipeline': () => import('./cmd/daily-pipeline.js'),

  // agent engine
  'run-flow': () => import('./cmd/run-flow.js'),
  'agent-provide': () => import('./cmd/agent-provide.js'),

  // SEEK automation
  'seek-login': () => import('./cmd/seek-login.js'),
  'seek-resumes': () => import('./cmd/seek-resumes.js'),
  'seek-apply': () => import('./cmd/seek-apply.js'),
};

const TOOL_GROUPS: Array<{ heading: string; tools: string[] }> = [
  { heading: 'Discovery & ingestion', tools: ['seek-search', 'seek-extract', 'linkedin-search', 'linkedin-extract', 'indeed-search', 'indeed-extract', 'builtin-search', 'builtin-extract', 'web-distill'] },
  { heading: 'Content library', tools: ['parse-library'] },
  { heading: 'Evaluation', tools: ['flag-eligibility', 'summarize-job', 'classify-jd', 'go-no-go', 'match-job', 'evaluate-job'] },
  { heading: 'Generation', tools: ['assemble-resume', 'generate-cover-letter', 'generate-company-brief', 'outreach-draft', 'gap-report'] },
  { heading: 'Rendering', tools: ['render-resume-pdf', 'render-cover-letter-pdf', 'render-company-brief-pdf'] },
  { heading: 'Delivery', tools: ['send-files'] },
  { heading: 'Tracking', tools: ['query-jobs', 'show-job', 'mark-job', 'job-stats', 'render-tracker', 'tracker-sync'] },
  { heading: 'Workflows', tools: ['apply-job', 'daily-pipeline'] },
  { heading: 'Agent engine', tools: ['run-flow', 'agent-provide'] },
  { heading: 'SEEK automation', tools: ['seek-login', 'seek-resumes', 'seek-apply'] },
];

function printHelp(): void {
  process.stdout.write(`career-ops — multi-source job-search pipeline (SEEK, LinkedIn, Indeed, Built In)

Usage: npx tsx scripts/career-ops.ts <command> [args]
   or: npm run career-ops -- <command> [args]

The same capabilities are also exposed over MCP (npm run mcp-serve). Scripts and
MCP share one core in src/ — read scripts/cmd/<command>.ts + the src/ it imports.

`);
  for (const g of TOOL_GROUPS) {
    process.stdout.write(`  ${g.heading}\n`);
    for (const t of g.tools) process.stdout.write(`    ${t}\n`);
    process.stdout.write('\n');
  }
  process.stdout.write(`Run any command without args to see its specific usage.\n`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp();
    process.exit(cmd ? 0 : 1);
  }

  const loader = COMMANDS[cmd];
  if (!loader) {
    process.stderr.write(`Unknown command: ${cmd}\n\n`);
    printHelp();
    process.exit(2);
  }

  try {
    const mod = await loader();
    await mod.runCli(rest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✘ ${cmd} failed: ${message}\n`);
    if (process.env.LOG_LEVEL === 'debug' && err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    process.exit(1);
  }
}

main();
