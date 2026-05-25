// Human-input broker — the "message gap" for agent-supervised runs.
//
// A long-running (often backgrounded) automation can hit a point where only a
// human can supply a value: an emailed verification code, a password not in
// .env, or anything unexpected. Instead of failing, it PAUSES here: writes a
// request file, prints a clear ⟨NEED-INPUT⟩ marker, and polls for a response.
//
// The supervisor (Claude, or a person) sees the marker and supplies the value
// with `career-ops agent-provide "<value>"`, which writes the response file.
// The waiting process reads it and resumes. Files live in a gitignored dir;
// secrets never touch stdout, the LLM, or the selector cache.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('agent:human-input');

export type HumanInputKind = 'text' | 'password' | 'code';
export type HumanInputRequest = { label: string; kind?: HumanInputKind };

type RequestFile = { id: string; label: string; kind: HumanInputKind; ts: string };

export type AwaitOptions = {
  /** Give up after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Poll interval. Default 2s. */
  pollMs?: number;
  /** Override how the prompt is surfaced (default: stderr marker). */
  onPrompt?: (req: RequestFile, responsePath: string) => void;
};

function inputDir(): string {
  return path.join(path.dirname(config.paths.dbPath), 'agent-input');
}
function requestPath(): string {
  return path.join(inputDir(), 'request.json');
}
function responsePath(): string {
  return path.join(inputDir(), 'response.json');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultPrompt(req: RequestFile, resPath: string): void {
  process.stderr.write(
    `\n⟨NEED-INPUT⟩ ${req.kind}: ${req.label}\n` +
      `  provide it with:  career-ops agent-provide "<value>"\n` +
      `  (request id ${req.id}; or write {"id":"${req.id}","value":"…"} to ${resPath})\n\n`,
  );
}

/** Pause and wait for a human/supervisor to supply a value. */
export async function awaitHumanInput(req: HumanInputRequest, opts: AwaitOptions = {}): Promise<string> {
  const dir = inputDir();
  fs.mkdirSync(dir, { recursive: true });
  const reqPath = requestPath();
  const resPath = responsePath();
  // Clear any stale response so we don't read a previous answer.
  try {
    fs.unlinkSync(resPath);
  } catch {
    /* none */
  }

  const payload: RequestFile = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label: req.label,
    kind: req.kind ?? 'text',
    ts: new Date().toISOString(),
  };
  fs.writeFileSync(reqPath, JSON.stringify(payload, null, 2));
  (opts.onPrompt ?? defaultPrompt)(payload, resPath);
  log.info({ id: payload.id, kind: payload.kind }, 'waiting for human input');

  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(resPath, 'utf-8');
    } catch {
      continue; // not answered yet
    }
    try {
      const resp = JSON.parse(raw) as { id: string; value: string };
      if (resp.id === payload.id) {
        try {
          fs.unlinkSync(resPath);
        } catch {
          /* best effort */
        }
        try {
          fs.unlinkSync(reqPath);
        } catch {
          /* best effort */
        }
        log.info({ id: payload.id }, 'human input received');
        return resp.value;
      }
    } catch {
      // partial write mid-poll — try again next tick.
    }
  }
  try {
    fs.unlinkSync(reqPath);
  } catch {
    /* best effort */
  }
  throw new Error(`human input timed out after ${Math.round(timeoutMs / 1000)}s waiting for "${req.label}"`);
}

/** The pending request, if a process is currently waiting. */
export function readPendingRequest(): RequestFile | null {
  try {
    return JSON.parse(fs.readFileSync(requestPath(), 'utf-8')) as RequestFile;
  } catch {
    return null;
  }
}

/** Supply a value for the pending request (called by the agent-provide tool). */
export function provideHumanInput(value: string): { id: string } {
  const req = readPendingRequest();
  if (!req) throw new Error('no pending human-input request (nothing is waiting)');
  fs.mkdirSync(inputDir(), { recursive: true });
  fs.writeFileSync(responsePath(), JSON.stringify({ id: req.id, value }));
  return { id: req.id };
}
