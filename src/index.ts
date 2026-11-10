#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { DiscordConnection } from './discord/client.js';
import { resolveGuild } from './discord/resolve.js';
import { createLogger, registerSecret } from './logger.js';
import { startHttpServer } from './mcp/http.js';
import { createMcpServer } from './mcp/server.js';
import { PACK_DESCRIPTIONS, PACK_NAMES } from './tools/packs.js';
import { ALL_TOOLS, selectTools } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `guildora-mcp - an MCP server for Discord

Usage: npx guildora-mcp            (configured with environment variables)

Environment:
  DISCORD_TOKEN         (required) bot token
  DISCORD_GUILD_ID      default server ID
  GUILDORA_PACKS        comma list of packs, default "core"; "all" for everything
  GUILDORA_READ_ONLY    "true" to expose only non-mutating tools
  GUILDORA_TRANSPORT    "stdio" (default) or "http"
  GUILDORA_HOST         HTTP bind address, default 127.0.0.1
  GUILDORA_PORT         HTTP port, default 8085
  GUILDORA_HTTP_TOKEN   require "Authorization: Bearer <token>" over HTTP
  GUILDORA_SCAN_LIMIT   max messages scanned when server search is unavailable (default 1000)
  GUILDORA_LOG_LEVEL    error | warn | info (default) | debug  (logs go to stderr)

Packs:
${PACK_NAMES.map((p) => `  ${p.padEnd(11)} ${PACK_DESCRIPTIONS[p]}`).join('\n')}

Docs: https://github.com/az-xx/guildora-mcp
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const version = readVersion();
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`[guildora] ERROR ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  registerSecret(config.token);
  registerSecret(config.httpToken);
  const logger = createLogger(config.logLevel);

  const tools = selectTools(ALL_TOOLS, config);
  logger.info(
    `guildora-mcp ${version}: ${tools.length} tools from packs [${config.packs.join(', ')}]` +
      `${config.readOnly ? ', read-only' : ''}, transport ${config.transport}.`,
  );

  const discord = new DiscordConnection(config, logger);
  const getContext = async (): Promise<ToolContext> => {
    const client = await discord.waitReady();
    return {
      client,
      config,
      intents: discord.intents,
      buffer: discord.buffer,
      guild: async (input) => resolveGuild(client, input, config.defaultGuildId),
    };
  };
  const serverOptions = { version, packs: config.packs, readOnly: config.readOnly };

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode = code;
    await discord.destroy().catch(() => undefined);
    // Let open sockets close by themselves; calling process.exit() while libuv handles are
    // closing can abort on Windows. Force the exit only if something keeps the loop alive.
    setTimeout(() => process.exit(code), 3000).unref();
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  let started = false;
  const startDiscord = () => {
    if (started) return;
    started = true;
    discord.start().catch((e: unknown) => {
      logger.error(e instanceof Error ? e.message : String(e));
      void shutdown(1);
    });
  };

  // Serve MCP first, so the client handshake never waits for discord.js or the gateway.
  if (config.transport === 'stdio') {
    const server = createMcpServer(tools, getContext, serverOptions);
    server.server.oninitialized = () => setImmediate(startDiscord);
    await server.connect(new StdioServerTransport());
    process.stdin.on('close', () => void shutdown());
    // Connect anyway if the client is slow to finish the handshake.
    setTimeout(startDiscord, 1500).unref();
  } else {
    await startHttpServer({
      host: config.host,
      port: config.port,
      bearerToken: config.httpToken,
      createServer: () => createMcpServer(tools, getContext, serverOptions),
      status: () => (discord.client?.isReady() ? 'ready' : 'connecting'),
      logger,
    });
    startDiscord();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`[guildora] ERROR ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
