import path from 'node:path';
import { config } from '../../shared/config.js';
import { writeTracker } from './index.js';

export async function runCli(_argv: string[]): Promise<void> {
  const out = writeTracker();
  process.stdout.write(`✔ ${path.relative(config.repoRoot, out)}\n`);
}
