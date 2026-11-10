import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
}

const secrets = new Set<string>();

/** Registers a value that must never appear in logs (for example the bot token). */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  // Webhook URLs carry a secret token in the path.
  out = out.replace(/(\/webhooks\/\d+\/)[A-Za-z0-9_-]+/g, '$1[redacted]');
  return out;
}

/**
 * Writes to stderr only. stdout is reserved for the MCP protocol in stdio mode,
 * so nothing in Guildora may ever print there.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = defaultWrite,
): Logger {
  const log = (lvl: LogLevel, msg: string) => {
    if (ORDER[lvl] > ORDER[level]) return;
    write(`[guildora] ${lvl.toUpperCase()} ${redact(msg)}\n`);
  };
  return {
    error: (m) => log('error', m),
    warn: (m) => log('warn', m),
    info: (m) => log('info', m),
    debug: (m) => log('debug', m),
  };
}

function defaultWrite(line: string): void {
  process.stderr.write(line);
}
