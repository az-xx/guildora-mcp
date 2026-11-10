import { describe, expect, it } from 'vitest';
import { createLogger, redact, registerSecret } from '../src/logger.js';
import { TOKEN } from './helpers.js';

describe('logger', () => {
  it('filters by level and writes one line per message', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (l) => lines.push(l));
    log.info('hidden');
    log.debug('hidden');
    log.warn('shown');
    log.error('also shown');
    expect(lines).toEqual(['[guildora] WARN shown\n', '[guildora] ERROR also shown\n']);
  });

  it('never logs the token or webhook secrets', () => {
    registerSecret(TOKEN);
    const lines: string[] = [];
    const log = createLogger('debug', (l) => lines.push(l));
    log.error(`login failed with ${TOKEN}`);
    log.info('POST https://discord.com/api/webhooks/123456789012345678/abcDEF_secret-token');
    expect(lines.join('')).not.toContain(TOKEN);
    expect(lines.join('')).not.toContain('abcDEF_secret-token');
    expect(redact(`x ${TOKEN} y`)).toBe('x [redacted] y');
  });
});
