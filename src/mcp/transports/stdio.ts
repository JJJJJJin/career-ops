#!/usr/bin/env node
// `mcp-stdio` — the simplest co-located entrypoint. The MCP client (e.g. Claude
// Code) spawns this process and talks over stdio. The browser session lives as
// long as this process does; durable state (DB, guidelines, run-state) is on
// disk regardless. Use the HTTP daemon (transports/http.ts) when you want the
// server to be a standalone, inspectable, longer-lived service.
//
// Register it with Claude Code:
//   claude mcp add career-ops -- node dist/mcp/transports/stdio.js
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from '../../shared/logger.js';
import { sessions } from '../session.js';
import { buildServer } from '../server.js';

const log = createLogger('mcp:stdio');

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel — never write logs there.
  log.info('career-ops MCP server connected over stdio');
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  await sessions.close('shutdown');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  log.error({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
