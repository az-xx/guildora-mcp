import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../logger.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** When set, requests must send "Authorization: Bearer <token>". */
  bearerToken: string | undefined;
  /** Creates a fresh MCP server for each request (stateless mode). */
  createServer: () => McpServer;
  /** Reported by GET /health. */
  status: () => string;
  logger: Logger;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0];
}

export function isLoopbackBind(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

/**
 * Rejects requests that could come from a malicious web page (DNS rebinding): when bound to
 * loopback, the Host header must be a loopback name and any Origin must be loopback too.
 */
export function checkRequestOrigin(req: IncomingMessage, bindHost: string): string | undefined {
  if (!isLoopbackBind(bindHost)) return undefined;
  const host = hostnameOf(req.headers.host);
  if (!host || !LOCAL_HOSTS.has(host))
    return 'Host header must be localhost when bound to loopback.';
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (
        !LOCAL_HOSTS.has(new URL(origin).hostname) &&
        !LOCAL_HOSTS.has(`[${new URL(origin).hostname}]`)
      ) {
        return 'Cross-origin requests are not allowed.';
      }
    } catch {
      return 'Invalid Origin header.';
    }
  }
  return undefined;
}

export function checkBearer(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const a = Buffer.from(match[1]!.trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  json(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/** Streamable HTTP transport at /mcp, stateless: every POST gets its own server instance. */
export function startHttpServer(opts: HttpOptions): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const originProblem = checkRequestOrigin(req, opts.host);
    if (originProblem) return rpcError(res, 403, originProblem);

    if (url.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, { status: 'ok', discord: opts.status() });
    }
    if (url.pathname !== '/mcp')
      return json(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' });
    if (!checkBearer(req, opts.bearerToken)) {
      res.setHeader('www-authenticate', 'Bearer');
      return rpcError(res, 401, 'Missing or invalid bearer token.');
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return rpcError(res, 405, 'Method not allowed: this server is stateless; use POST.');
    }

    const mcp = opts.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      opts.logger.error(`HTTP request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) rpcError(res, 500, 'Internal server error.');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      const shownHost = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
      opts.logger.info(`MCP endpoint: http://${shownHost}:${opts.port}/mcp`);
      if (!isLoopbackBind(opts.host) && !opts.bearerToken) {
        opts.logger.warn(
          `Listening on ${opts.host} without GUILDORA_HTTP_TOKEN: anyone who can reach this port can use the bot.`,
        );
      }
      resolve(server);
    });
  });
}
