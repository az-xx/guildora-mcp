import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { checkBearer, checkRequestOrigin, startHttpServer } from '../src/mcp/http.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createLogger } from '../src/logger.js';
import { ALL_TOOLS, selectTools } from '../src/tools/registry.js';
import { context } from './helpers.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe('request checks', () => {
  it('accepts loopback Host headers when bound to loopback', () => {
    expect(checkRequestOrigin(req({ host: '127.0.0.1:8085' }), '127.0.0.1')).toBeUndefined();
    expect(checkRequestOrigin(req({ host: 'localhost:8085' }), '127.0.0.1')).toBeUndefined();
    expect(checkRequestOrigin(req({ host: '[::1]:8085' }), '::1')).toBeUndefined();
  });

  it('blocks DNS rebinding and cross-origin browser requests', () => {
    expect(checkRequestOrigin(req({ host: 'evil.example:8085' }), '127.0.0.1')).toMatch(
      /Host header/,
    );
    expect(
      checkRequestOrigin(
        req({ host: 'localhost:8085', origin: 'https://evil.example' }),
        '127.0.0.1',
      ),
    ).toMatch(/Cross-origin/);
    expect(
      checkRequestOrigin(
        req({ host: 'localhost:8085', origin: 'http://localhost:6274' }),
        '127.0.0.1',
      ),
    ).toBeUndefined();
  });

  it('does not restrict Host when deliberately bound to all interfaces', () => {
    expect(checkRequestOrigin(req({ host: 'my-server:8085' }), '0.0.0.0')).toBeUndefined();
  });

  it('checks bearer tokens', () => {
    expect(checkBearer(req({}), undefined)).toBe(true);
    expect(
      checkBearer(req({ authorization: 'Bearer s3cret-s3cret-s3cret' }), 's3cret-s3cret-s3cret'),
    ).toBe(true);
    expect(checkBearer(req({ authorization: 'Bearer wrong' }), 's3cret-s3cret-s3cret')).toBe(false);
    expect(checkBearer(req({}), 's3cret-s3cret-s3cret')).toBe(false);
  });
});

describe('HTTP transport', () => {
  let server: Server | undefined;
  afterEach(
    () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
  );

  async function start(bearerToken?: string) {
    const tools = selectTools(ALL_TOOLS, { packs: ['core'], readOnly: true });
    server = await startHttpServer({
      host: '127.0.0.1',
      port: 0,
      bearerToken,
      createServer: () =>
        createMcpServer(tools, async () => context(), {
          version: '0.0.0-test',
          packs: ['core'],
          readOnly: true,
        }),
      status: () => 'connecting',
      logger: createLogger('error', () => undefined),
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const rpc = (base: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  };

  it('serves initialize and tools/list (read-only core) statelessly', async () => {
    const base = await start();
    const res = await rpc(base, init);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { serverInfo: { name: string }; instructions: string };
    };
    expect(body.result.serverInfo.name).toBe('guildora');
    expect(body.result.instructions).toContain('Read-only mode is on');

    const list = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (
      (await list.json()) as {
        result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] };
      }
    ).result.tools;
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain('send_message');
  });

  it('requires the bearer token when configured', async () => {
    const base = await start('s3cret-s3cret-s3cret');
    expect((await rpc(base, init)).status).toBe(401);
    expect((await rpc(base, init, { authorization: 'Bearer s3cret-s3cret-s3cret' })).status).toBe(
      200,
    );
  });

  it('answers /health without secrets and rejects GET on /mcp', async () => {
    const base = await start();
    const health = await fetch(`${base}/health`);
    expect(await health.json()).toEqual({ status: 'ok', discord: 'connecting' });
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});
