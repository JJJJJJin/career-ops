// Structured logger — compact human output by default, JSON when LOG_JSON=1.
// Adapted from AutoBrowser/src/logger.ts.

const LEVELS = { trace: 5, debug: 10, info: 20, warn: 30, error: 40, fatal: 50, silent: 100 } as const;
type LogLevel = keyof typeof LEVELS;
type EmitLevel = Exclude<LogLevel, 'silent' | 'trace' | 'fatal'>;

const envLevelRaw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const envLevel = (envLevelRaw in LEVELS ? envLevelRaw : 'info') as LogLevel;
const THRESHOLD = LEVELS[envLevel];

const USE_JSON = process.env.LOG_JSON === '1' || process.env.LOG_JSON === 'true';
const TTY = (process.stderr as NodeJS.WriteStream).isTTY ?? false;
const COLOR = TTY && !USE_JSON;

const C = {
  reset: COLOR ? '\x1b[0m' : '',
  dim: COLOR ? '\x1b[2m' : '',
  gray: COLOR ? '\x1b[90m' : '',
  cyan: COLOR ? '\x1b[36m' : '',
  yellow: COLOR ? '\x1b[33m' : '',
  red: COLOR ? '\x1b[31m' : '',
  magenta: COLOR ? '\x1b[35m' : '',
  green: COLOR ? '\x1b[32m' : '',
};
const LEVEL_COLOR: Record<EmitLevel, string> = {
  debug: C.gray,
  info: C.cyan,
  warn: C.yellow,
  error: C.red,
};

function truncateValue(v: unknown): unknown {
  if (typeof v === 'string' && v.length > 240) {
    return v.slice(0, 240) + `…(+${v.length - 240}ch)`;
  }
  return v;
}

function formatExtra(extra: Record<string, unknown>): string {
  const keys = Object.keys(extra);
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${C.dim}${k}${C.reset}=${JSON.stringify(truncateValue(extra[k]))}`);
  return ' ' + parts.join(' ');
}

type LogFn = {
  (msg: string): void;
  (extra: Record<string, unknown>, msg: string): void;
};

export type Logger = {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child(extra: Record<string, unknown>): Logger;
};

function emit(level: EmitLevel, scope: Record<string, unknown>, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < THRESHOLD) return;
  const ts = new Date().toISOString();
  const merged = { ...scope, ...(extra ?? {}) };

  if (USE_JSON) {
    process.stderr.write(JSON.stringify({ ts, level, msg, ...merged }) + '\n');
    return;
  }

  const scopeLabel = typeof merged.scope === 'string' ? merged.scope : '';
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (k === 'scope') continue;
    rest[k] = v;
  }
  const lvlStr = `${LEVEL_COLOR[level]}${level.toUpperCase().padEnd(5)}${C.reset}`;
  const tag = scopeLabel ? ` ${C.magenta}[${scopeLabel}]${C.reset}` : '';
  process.stderr.write(`${C.gray}${ts}${C.reset} ${lvlStr}${tag} ${msg}${formatExtra(rest)}\n`);
}

function buildLogger(scope: Record<string, unknown>): Logger {
  const make = (level: EmitLevel): LogFn => {
    function fn(arg1: string | Record<string, unknown>, arg2?: string): void {
      if (typeof arg1 === 'string') {
        emit(level, scope, arg1);
      } else {
        emit(level, scope, arg2 ?? '', arg1);
      }
    }
    return fn as LogFn;
  };
  return {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child(extra) {
      return buildLogger({ ...scope, ...extra });
    },
  };
}

export function createLogger(scope: string | Record<string, unknown> = {}): Logger {
  if (typeof scope === 'string') return buildLogger({ scope });
  return buildLogger(scope);
}

export const rootLogger: Logger = createLogger();
