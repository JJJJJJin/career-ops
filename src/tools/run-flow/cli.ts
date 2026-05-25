import { runFlow, type RunFlowOptions } from '../../shared/agent/flow.js';

function parseArgs(argv: string[]): { flowId?: string; json: boolean; opts: RunFlowOptions } {
  let flowId: string | undefined;
  let json = false;
  const opts: RunFlowOptions = {};
  const ctx: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--url') {
      opts.startUrl = next;
      i++;
    } else if (a === '--no-cache') {
      opts.noCache = true;
    } else if (a === '--headless') {
      // --headless or --headless=false
      opts.headless = next === 'false' ? false : true;
      if (next === 'false' || next === 'true') i++;
    } else if (a === '--headful') {
      opts.headless = false;
    } else if (a === '--min-confidence') {
      opts.minConfidence = parseFloat(next ?? '');
      i++;
    } else if (a === '--ctx') {
      const eq = (next ?? '').indexOf('=');
      if (eq > 0) ctx[(next ?? '').slice(0, eq)] = (next ?? '').slice(eq + 1);
      i++;
    } else if (a === '--json') {
      json = true;
    } else if (a && !a.startsWith('--')) {
      flowId = a;
    }
  }
  if (Object.keys(ctx).length) opts.context = ctx;
  return { flowId, json, opts };
}

export async function runCli(argv: string[]): Promise<void> {
  const { flowId, json, opts } = parseArgs(argv);
  if (!flowId) {
    console.error(
      'Usage: career-ops run-flow <flowId> [--url <startUrl>] [--no-cache] [--headful] [--min-confidence <n>] [--ctx key=value] [--json]\n' +
        '  flowId is the path under flows/ without .md, e.g. "test/seek-search-read"',
    );
    process.exit(2);
  }

  const result = await runFlow(flowId, opts);

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const mark = result.completed ? '✔' : '✘';
  process.stdout.write(`\n${mark} flow ${result.flowId} — ${result.completed ? 'completed' : 'incomplete'}\n`);
  for (const o of result.outcomes) {
    const status = o.ok ? '·' : '✘';
    const src = o.source ? ` (${o.source})` : '';
    const note = o.note ? `  — ${o.note}` : '';
    process.stdout.write(`  ${status} ${o.step}: ${o.action}${src}${note}\n`);
  }
  if (result.failedStep) {
    process.stdout.write(`\n  failed at: ${result.failedStep}\n`);
    if (result.screenshotPath) process.stdout.write(`  screenshot: ${result.screenshotPath}\n`);
  }
}
