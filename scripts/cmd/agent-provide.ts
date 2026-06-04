import { provideHumanInput, readPendingRequest } from '../../src/shared/agent/human-input.js';

export async function runCli(argv: string[]): Promise<void> {
  // `--show` / `--pending`: print what (if anything) is being asked for.
  if (argv[0] === '--show' || argv[0] === '--pending') {
    const req = readPendingRequest();
    if (!req) {
      process.stdout.write('No pending human-input request.\n');
      process.exit(1);
    }
    process.stdout.write(`Pending ${req.kind} request: ${req.label}\n  (id ${req.id}, since ${req.ts})\n`);
    return;
  }

  const value = argv.find((a) => !a.startsWith('--'));
  if (value === undefined) {
    const req = readPendingRequest();
    const hint = req ? `\nPending: ${req.kind} — ${req.label}` : '\n(nothing is currently waiting)';
    console.error(`Usage: career-ops agent-provide "<value>"   |   agent-provide --show${hint}`);
    process.exit(2);
  }

  const { id } = provideHumanInput(value);
  process.stdout.write(`✔ provided value for request ${id}\n`);
}
