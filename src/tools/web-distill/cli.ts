import { webDistill } from './index.js';

function parseArgs(argv: string[]): { url: string; jsRender: boolean; format: 'markdown' | 'text' | 'json' } {
  let url = '';
  let jsRender = false;
  let format: 'markdown' | 'text' | 'json' = 'markdown';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--js' || a === '--js-render') jsRender = true;
    else if (a === '--text') format = 'text';
    else if (a === '--json') format = 'json';
    else if (a === '--markdown') format = 'markdown';
    else if (a && !a.startsWith('--')) url = a;
  }
  return { url, jsRender, format };
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.url) {
    console.error('Usage: career-ops web-distill <url> [--js] [--text|--markdown|--json]');
    process.exit(2);
  }
  const result = await webDistill(args.url, { jsRender: args.jsRender });
  if (args.format === 'json') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (args.format === 'text') {
    process.stdout.write(result.text + '\n');
  } else {
    if (result.title) process.stdout.write(`# ${result.title}\n\n`);
    process.stdout.write(result.markdown + '\n');
  }
}
