#!/usr/bin/env node
// `mcp-serve` — the default entrypoint. A long-lived localhost Streamable-HTTP
// daemon. Identical on a Mac (test) and a Raspberry Pi (prod). The browser
// session + run-state live in the server independent of any one chat, which is
// what lets it hold a logged-in session open while it asks you for a captcha.
//
// Register it with Claude Code:
//   claude mcp add --transport http career-ops http://127.0.0.1:8731/mcp
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '../../shared/logger.js';
import { sessions } from '../session.js';
import { buildServer } from '../server.js';

const log = createLogger('mcp:http');

const HOST = process.env.MCP_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.MCP_PORT ?? '8731', 10);
const PATHNAME = '/mcp';

// One transport per MCP session id. The browser/run-state are process-wide
// (SessionManager), so this map only tracks JSON-RPC plumbing, not app state.
const transports = new Map<string, StreamableHTTPServerTransport>();

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on('error', reject);
  });
}

function rpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

const httpServer = http.createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname !== PATHNAME) {
        res.writeHead(404).end('not found');
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existing = sessionId ? transports.get(sessionId) : undefined;

      if (existing) {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await existing.handleRequest(req, res, body);
        return;
      }

      // No known session. A POST initialize starts one; anything else is invalid.
      if (req.method !== 'POST') {
        rpcError(res, 400, 'No valid session id');
        return;
      }
      const body = await readBody(req);
      if (!isInitializeRequest(body)) {
        rpcError(res, 400, 'No valid session id (expected an initialize request)');
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          log.info({ sid }, 'mcp session initialized');
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      await buildServer().connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'request failed');
      if (!res.headersSent) rpcError(res, 500, (err as Error).message);
    }
  })();
});

httpServer.listen(PORT, HOST, () => {
  log.info({ host: HOST, port: PORT, path: PATHNAME }, 'career-ops MCP daemon listening');
  process.stderr.write(`career-ops MCP daemon: http://${HOST}:${PORT}${PATHNAME}\n`);
});

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  await sessions.close('shutdown');
  httpServer.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
