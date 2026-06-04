import readline from 'node:readline';
import { config } from '../../src/shared/config.js';
import { journal } from '../../src/shared/agent/journal.js';
import { seekLogin, type SeekLoginMode } from '../../src/tools/seek-login/index.js';

function pressEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

export async function runCli(argv: string[]): Promise<void> {
  let mode: SeekLoginMode = 'ensure';
  let headful = false;
  let noCache = false;
  for (const a of argv) {
    if (a === '--manual') mode = 'manual';
    else if (a === '--check') mode = 'check';
    else if (a === '--headful' || a === '--headed') headful = true;
    else if (a === '--no-cache') noCache = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: career-ops seek-login [--manual | --check] [--headful] [--no-cache]\n');
      return;
    }
  }

  const waitForUser = () =>
    pressEnter(
      '\n  A browser window is open. Log in to SEEK (handle any emailed code / captcha).\n' +
        '  When you can see your account is signed in, return here and press Enter… ',
    );

  // `check` is read-only and frequent — don't bother tracing it.
  const trace = mode === 'check' ? null : journal.start(`seek-login-${mode}-${Date.now()}`, { mode });
  let result;
  try {
    result = await seekLogin({ mode, headful, noCache, waitForUser });
  } catch (err) {
    if (trace) { journal.fail('seek-login failed', { error: (err as Error).message }); journal.end({ aborted: true }); }
    throw err;
  }
  if (trace) { journal.end({ loggedIn: result.loggedIn, method: result.method }); process.stdout.write(`  trace: ${trace}\n`); }

  if (result.mode === 'check') {
    process.stdout.write(result.loggedIn ? '✔ SEEK session is valid (logged in)\n' : '✘ No valid SEEK session (logged out)\n');
    process.exit(result.loggedIn ? 0 : 1);
  }

  if (result.loggedIn) {
    const how = result.method === 'reused' ? 'reused cached session' : result.method === 'credentials' ? 'logged in with credentials' : 'logged in';
    process.stdout.write(`✔ ${how}. Session cached at ${config.seek.authStatePath}\n`);
  } else {
    process.stdout.write('✘ Not logged in. Try `career-ops seek-login --manual`.\n');
    process.exit(1);
  }
}
