import path from 'node:path';
import { config } from '../../src/shared/config.js';
import { sendFiles, KNOWN_PROVIDERS } from '../../src/tools/send-files/index.js';

function printUsage(): void {
  console.error(`Usage:
  career-ops send-files <file...> [options]
  career-ops send-files --job <jobId> [--ext .pdf,.docx] [options]

Options:
  --job <jobId>            Auto-collect files from output/<source>/<slug>/ for this job
  --ext <list>             Comma-separated extension filter when --job is used (default: .pdf)
  --webhook <url>          Override the webhook URL (default: $WEBHOOK_URL)
  --provider <name>        Webhook provider (default: $WEBHOOK_PROVIDER or 'wecom'). Available: ${KNOWN_PROVIDERS.join(', ')}
  --text <msg>             Optional prelude message sent before the files
  --markdown               Treat --text as markdown (if the provider supports it)
  --no-fail                Don't exit non-zero if some files fail
`);
}

export async function runCli(argv: string[]): Promise<void> {
  const paths: string[] = [];
  let jobId: string | undefined;
  let extensions: string[] | undefined;
  let webhookUrl: string | undefined;
  let provider: string | undefined;
  let text: string | undefined;
  let markdown = false;
  let throwOnFailure = true;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--job' || a === '--jobId') {
      jobId = argv[i + 1];
      i++;
    } else if (a === '--ext' || a === '--extensions') {
      extensions = (argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (a === '--webhook' || a === '--webhook-url') {
      webhookUrl = argv[i + 1];
      i++;
    } else if (a === '--provider') {
      provider = argv[i + 1];
      i++;
    } else if (a === '--text' || a === '--message') {
      text = argv[i + 1];
      i++;
    } else if (a === '--markdown') {
      markdown = true;
    } else if (a === '--no-fail') {
      throwOnFailure = false;
    } else if (a === '-h' || a === '--help') {
      printUsage();
      process.exit(0);
    } else if (a && !a.startsWith('--')) {
      paths.push(a);
    }
  }

  if (!paths.length && !jobId) {
    printUsage();
    process.exit(2);
  }

  const result = await sendFiles({
    paths,
    jobId,
    extensions,
    webhookUrl,
    provider,
    text,
    markdown,
    throwOnFailure,
  });

  process.stdout.write(`\n✔ sent via ${result.provider}\n`);
  if (result.textSent) process.stdout.write(`  text: delivered\n`);
  for (const a of result.attachments) {
    const rel = path.relative(config.repoRoot, a.path);
    const mark = a.ok ? '✓' : '✘';
    const detail = a.ok ? '' : ` — ${a.error ?? 'failed'}`;
    process.stdout.write(`  ${mark} ${rel}${detail}\n`);
  }
}
