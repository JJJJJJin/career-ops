#!/usr/bin/env node
// career-ops — single binary, many subcommands. Each subcommand is a
// thin wrapper around a tool's runCli() function.
//
// Subcommand naming follows the openclaw skill names exactly so:
//   career-ops <skill> <args...>
// matches the SKILL.md frontmatter invocation lines.

const COMMANDS: Record<string, () => Promise<{ runCli: (argv: string[]) => Promise<void> }>> = {
  // discovery + ingestion
  'seek-search': () => import('./tools/seek-search/cli.js'),
  'seek-extract': () => import('./tools/seek-extract/cli.js'),
  'linkedin-search': () => import('./tools/linkedin-search/cli.js'),
  'linkedin-extract': () => import('./tools/linkedin-extract/cli.js'),
  'indeed-search': () => import('./tools/indeed-search/cli.js'),
  'indeed-extract': () => import('./tools/indeed-extract/cli.js'),
  'web-distill': () => import('./tools/web-distill/cli.js'),

  // profile
  'distill-profile': () => import('./tools/distill-profile/cli.js'),

  // evaluation
  'flag-eligibility': () => import('./tools/flag-eligibility/cli.js'),
  'summarize-job': () => import('./tools/summarize-job/cli.js'),
  'match-job': () => import('./tools/match-job/cli.js'),
  'evaluate-job': () => import('./tools/evaluate-job/cli.js'),

  // generation
  'generate-resume': () => import('./tools/generate-resume/cli.js'),
  'generate-cover-letter': () => import('./tools/generate-cover-letter/cli.js'),
  'generate-company-brief': () => import('./tools/generate-company-brief/cli.js'),

  // rendering
  'render-resume-pdf': () => import('./tools/render-resume-pdf/cli.js'),
  'render-cover-letter-pdf': () => import('./tools/render-cover-letter-pdf/cli.js'),
  'render-company-brief-pdf': () => import('./tools/render-company-brief-pdf/cli.js'),

  // delivery
  'send-files': () => import('./tools/send-files/cli.js'),

  // tracking
  'query-jobs': () => import('./tools/query-jobs/cli.js'),
  'show-job': () => import('./tools/show-job/cli.js'),
  'mark-job': () => import('./tools/mark-job/cli.js'),
  'job-stats': () => import('./tools/job-stats/cli.js'),
  'render-tracker': () => import('./tools/render-tracker/cli.js'),

  // workflows
  'apply-job': () => import('./workflows/apply-job.js'),
  'daily-pipeline': () => import('./workflows/daily-pipeline.js'),
};

const TOOL_GROUPS: Array<{ heading: string; tools: string[] }> = [
  { heading: 'Discovery & ingestion', tools: ['seek-search', 'seek-extract', 'linkedin-search', 'linkedin-extract', 'indeed-search', 'indeed-extract', 'web-distill'] },
  { heading: 'Profile', tools: ['distill-profile'] },
  { heading: 'Evaluation', tools: ['flag-eligibility', 'summarize-job', 'match-job', 'evaluate-job'] },
  { heading: 'Generation', tools: ['generate-resume', 'generate-cover-letter', 'generate-company-brief'] },
  { heading: 'Rendering', tools: ['render-resume-pdf', 'render-cover-letter-pdf', 'render-company-brief-pdf'] },
  { heading: 'Delivery', tools: ['send-files'] },
  { heading: 'Tracking', tools: ['query-jobs', 'show-job', 'mark-job', 'job-stats', 'render-tracker'] },
  { heading: 'Workflows', tools: ['apply-job', 'daily-pipeline'] },
];

function printHelp(): void {
  process.stdout.write(`career-ops — multi-source job-search pipeline (SEEK, LinkedIn, Indeed)

Usage: career-ops <command> [args]

`);
  for (const g of TOOL_GROUPS) {
    process.stdout.write(`  ${g.heading}\n`);
    for (const t of g.tools) {
      process.stdout.write(`    ${t}\n`);
    }
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
