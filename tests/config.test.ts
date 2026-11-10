import { describe, expect, it } from 'vitest';
import { ConfigError, cleanToken, loadConfig, parsePacks } from '../src/config.js';
import { PACK_NAMES } from '../src/tools/packs.js';
import { TOKEN } from './helpers.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ DISCORD_TOKEN: TOKEN });
    expect(c).toMatchObject({
      token: TOKEN,
      defaultGuildId: undefined,
      packs: ['core'],
      readOnly: false,
      transport: 'stdio',
      host: '127.0.0.1',
      port: 8085,
      logLevel: 'info',
      scanLimit: 1000,
    });
  });

  it('fails fast without a token, pointing to the Developer Portal', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DISCORD_TOKEN: '  ' })).toThrow(/Reset Token/);
  });

  it('rejects values that are not bot tokens (client secret, app ID)', () => {
    expect(() => loadConfig({ DISCORD_TOKEN: 'abcdefghijklmnopqrstuvwxyz123456' })).toThrow(
      /does not look like a bot token/,
    );
    expect(() => loadConfig({ DISCORD_TOKEN: '123456789012345678' })).toThrow(ConfigError);
  });

  it('strips quotes and a "Bot " prefix from the token', () => {
    expect(cleanToken(`"${TOKEN}"`)).toBe(TOKEN);
    expect(cleanToken(`Bot ${TOKEN}`)).toBe(TOKEN);
    expect(loadConfig({ DISCORD_TOKEN: `'Bot ${TOKEN}'` }).token).toBe(TOKEN);
  });

  it('validates DISCORD_GUILD_ID', () => {
    expect(
      loadConfig({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '123456789012345678' }).defaultGuildId,
    ).toBe('123456789012345678');
    expect(() => loadConfig({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: 'my-server' })).toThrow(
      /numeric server ID/,
    );
  });

  it('parses booleans strictly', () => {
    expect(loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_READ_ONLY: 'true' }).readOnly).toBe(true);
    expect(loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_READ_ONLY: 'YES' }).readOnly).toBe(true);
    expect(loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_READ_ONLY: '0' }).readOnly).toBe(false);
    expect(() => loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_READ_ONLY: 'maybe' })).toThrow(
      /GUILDORA_READ_ONLY/,
    );
  });

  it('validates transport, port, log level and scan limit', () => {
    expect(
      loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_TRANSPORT: 'HTTP', GUILDORA_PORT: '9000' }),
    ).toMatchObject({
      transport: 'http',
      port: 9000,
    });
    expect(() => loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_TRANSPORT: 'sse' })).toThrow(
      /stdio" or "http/,
    );
    expect(() => loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_PORT: '70000' })).toThrow(
      /GUILDORA_PORT/,
    );
    expect(() => loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_LOG_LEVEL: 'trace' })).toThrow(
      /GUILDORA_LOG_LEVEL/,
    );
    expect(() => loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_SCAN_LIMIT: '50' })).toThrow(
      /GUILDORA_SCAN_LIMIT/,
    );
  });

  it('requires a reasonably long HTTP token', () => {
    expect(() => loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_HTTP_TOKEN: 'short' })).toThrow(
      /16 characters/,
    );
    expect(
      loadConfig({ DISCORD_TOKEN: TOKEN, GUILDORA_HTTP_TOKEN: 'a'.repeat(32) }).httpToken,
    ).toBe('a'.repeat(32));
  });
});

describe('parsePacks', () => {
  it('defaults to core', () => {
    expect(parsePacks(undefined)).toEqual(['core']);
    expect(parsePacks('')).toEqual(['core']);
  });

  it('always includes core, dedupes and keeps a stable order', () => {
    expect(parsePacks('roles, moderation,roles')).toEqual(['core', 'roles', 'moderation']);
  });

  it('"all" enables every pack', () => {
    expect(parsePacks('all')).toEqual([...PACK_NAMES]);
    expect(parsePacks('core,ALL')).toEqual([...PACK_NAMES]);
  });

  it('rejects unknown packs and lists the valid ones', () => {
    expect(() => parsePacks('core,admin')).toThrow(
      /unknown pack\(s\): admin.*Valid packs: core, channels/,
    );
  });
});
