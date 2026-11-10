import { z } from 'zod';
import { PACK_NAMES, type PackName } from './tools/packs.js';

export type Transport = 'stdio' | 'http';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface Config {
  token: string;
  defaultGuildId: string | undefined;
  packs: PackName[];
  readOnly: boolean;
  transport: Transport;
  host: string;
  port: number;
  httpToken: string | undefined;
  logLevel: LogLevel;
  scanLimit: number;
}

/** Raised for invalid configuration. The message is shown to the user as-is. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

const SNOWFLAKE = /^\d{17,20}$/;
/** Bot tokens are three base64url segments separated by dots. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;

const boolish = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v, ctx) => {
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(v)) return false;
    ctx.addIssue({ code: 'custom', message: `expected true or false, got "${v}"` });
    return z.NEVER;
  });

/** Strips quotes and a "Bot " prefix that people often paste along with the token. */
export function cleanToken(raw: string): string {
  let token = raw.trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }
  if (/^bot\s+/i.test(token)) token = token.replace(/^bot\s+/i, '');
  return token;
}

export function parsePacks(raw: string | undefined): PackName[] {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return ['core'];
  const names = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.includes('all')) return [...PACK_NAMES];
  const unknown = names.filter((n) => !(PACK_NAMES as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new ConfigError(
      `GUILDORA_PACKS contains unknown pack(s): ${unknown.join(', ')}. ` +
        `Valid packs: ${PACK_NAMES.join(', ')}, or "all".`,
    );
  }
  // Keep a stable order and drop duplicates. "core" is always included.
  const set = new Set<string>(['core', ...names]);
  return PACK_NAMES.filter((p) => set.has(p));
}

function issueText(error: z.ZodError): string {
  return error.issues.map((i) => i.message).join('; ');
}

/** Parses configuration from environment variables. Throws ConfigError with a clear message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawToken = env.DISCORD_TOKEN;
  if (rawToken === undefined || rawToken.trim() === '') {
    throw new ConfigError(
      'DISCORD_TOKEN is not set. Create a bot in the Discord Developer Portal ' +
        '(https://discord.com/developers/applications > your app > Bot > Reset Token) ' +
        'and pass the token in the DISCORD_TOKEN environment variable.',
    );
  }
  const token = cleanToken(rawToken);
  if (!TOKEN_SHAPE.test(token)) {
    throw new ConfigError(
      'DISCORD_TOKEN does not look like a bot token. Use the token from the "Bot" page ' +
        '(Bot > Reset Token), not the Application ID, Public Key or Client Secret.',
    );
  }

  const guildId = env.DISCORD_GUILD_ID?.trim() || undefined;
  if (guildId !== undefined && !SNOWFLAKE.test(guildId)) {
    throw new ConfigError(
      `DISCORD_GUILD_ID must be a numeric server ID (right-click the server > Copy Server ID), got "${guildId}".`,
    );
  }

  const readOnly = boolish.safeParse(env.GUILDORA_READ_ONLY ?? '');
  if (!readOnly.success) {
    throw new ConfigError(`GUILDORA_READ_ONLY: ${issueText(readOnly.error)}`);
  }

  const transportRaw = (env.GUILDORA_TRANSPORT ?? 'stdio').trim().toLowerCase() || 'stdio';
  if (transportRaw !== 'stdio' && transportRaw !== 'http') {
    throw new ConfigError(`GUILDORA_TRANSPORT must be "stdio" or "http", got "${transportRaw}".`);
  }

  const port = parseIntInRange(env.GUILDORA_PORT, 8085, 1, 65535, 'GUILDORA_PORT');
  const scanLimit = parseIntInRange(
    env.GUILDORA_SCAN_LIMIT,
    1000,
    100,
    10000,
    'GUILDORA_SCAN_LIMIT',
  );

  const logLevelRaw = (env.GUILDORA_LOG_LEVEL ?? 'info').trim().toLowerCase() || 'info';
  if (!['error', 'warn', 'info', 'debug'].includes(logLevelRaw)) {
    throw new ConfigError(
      `GUILDORA_LOG_LEVEL must be one of error, warn, info, debug, got "${logLevelRaw}".`,
    );
  }

  const host = env.GUILDORA_HOST?.trim() || '127.0.0.1';
  const httpToken = env.GUILDORA_HTTP_TOKEN?.trim() || undefined;
  if (httpToken !== undefined && httpToken.length < 16) {
    throw new ConfigError('GUILDORA_HTTP_TOKEN must be at least 16 characters long.');
  }

  return {
    token,
    defaultGuildId: guildId,
    packs: parsePacks(env.GUILDORA_PACKS),
    readOnly: readOnly.data,
    transport: transportRaw,
    host,
    port,
    httpToken,
    logLevel: logLevelRaw as LogLevel,
    scanLimit,
  };
}

function parseIntInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${raw}".`);
  }
  return n;
}
