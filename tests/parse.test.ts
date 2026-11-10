import { describe, expect, it } from 'vitest';
import { SnowflakeUtil } from 'discord.js';
import {
  formatColor,
  formatDuration,
  formatDurationShort,
  parseColor,
  parseDate,
  parseDiscordLink,
  parseDuration,
  parseOffsetCursor,
  parsePermissions,
  permissionBits,
  permissionNames,
  snowflakeAt,
} from '../src/discord/parse.js';
import { PermissionFlagsBits, snowflakeTimestamp } from '../src/discord/api.js';

describe('parseDiscordLink', () => {
  it('parses message and channel links, including canary, ptb and DMs', () => {
    expect(
      parseDiscordLink(
        'https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333',
      ),
    ).toEqual({
      guildId: '111111111111111111',
      channelId: '222222222222222222',
      messageId: '333333333333333333',
    });
    expect(parseDiscordLink('https://ptb.discordapp.com/channels/@me/222222222222222222')).toEqual({
      guildId: undefined,
      channelId: '222222222222222222',
      messageId: undefined,
    });
    expect(
      parseDiscordLink(
        '<https://canary.discord.com/channels/111111111111111111/222222222222222222>',
      )?.channelId,
    ).toBe('222222222222222222');
  });

  it('ignores other URLs', () => {
    expect(parseDiscordLink('https://example.com/channels/1/2')).toBeUndefined();
    expect(parseDiscordLink('general')).toBeUndefined();
  });
});

describe('parseDuration', () => {
  it.each([
    ['90', 90_000],
    ['30s', 30_000],
    ['10m', 600_000],
    ['1h30m', 5_400_000],
    ['7d', 604_800_000],
    ['2w', 1_209_600_000],
    ['1 day', 86_400_000],
    ['0', 0],
    ['none', 0],
  ])('%s → %d ms', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it('accepts numbers as seconds', () => {
    expect(parseDuration(60)).toBe(60_000);
  });

  it('rejects garbage with an example', () => {
    expect(() => parseDuration('soon')).toThrow(/"10m"/);
    expect(() => parseDuration('10 lightyears')).toThrow();
  });

  it('formats durations compactly', () => {
    expect(formatDuration(5_400_000)).toBe('1h30m');
    expect(formatDuration(0)).toBe('0s');
  });

  it('shortens durations to the two largest units', () => {
    const ms = ((28 * 24 + 22) * 60 + 32) * 60_000 + 16_000;
    expect(formatDuration(ms)).toBe('28d22h32m16s');
    expect(formatDurationShort(ms)).toBe('28d22h');
    expect(formatDurationShort(45_000)).toBe('45s');
    expect(formatDurationShort(0)).toBe('0s');
  });
});

describe('dates and snowflakes', () => {
  it('matches discord.js snowflake math', () => {
    const id = '1100000000000000000';
    expect(snowflakeTimestamp(id)).toBe(Number(SnowflakeUtil.timestampFrom(id)));
    const at = new Date('2026-01-01T00:00:00Z');
    expect(snowflakeAt(at)).toBe(
      SnowflakeUtil.generate({
        timestamp: at.getTime(),
        increment: 0n,
        processId: 0n,
        workerId: 0n,
      }).toString(),
    );
  });

  it('parses ISO dates and message IDs', () => {
    expect(parseDate('2026-11-10T18:00:00Z').toISOString()).toBe('2026-11-10T18:00:00.000Z');
    expect(parseDate('1100000000000000000').getTime()).toBe(
      snowflakeTimestamp('1100000000000000000'),
    );
    expect(() => parseDate('yesterday-ish')).toThrow(/ISO 8601/);
  });
});

describe('colors', () => {
  it.each([
    ['#5865F2', 0x5865f2],
    ['5865f2', 0x5865f2],
    ['0xff0000', 0xff0000],
    ['#f00', 0xff0000],
    ['Blurple', 0x5865f2],
    ['dark red', 0x992d22],
    ['none', 0],
    [255, 255],
  ])('%s', (input, value) => {
    expect(parseColor(input)).toBe(value);
  });

  it('rejects unknown colors', () => {
    expect(() => parseColor('ultraviolet')).toThrow(/hex value/);
    expect(() => parseColor(0x1000000)).toThrow();
  });

  it('formats colors', () => {
    expect(formatColor(0x5865f2)).toBe('#5865F2');
    expect(formatColor(0)).toBe('default');
  });
});

describe('permissions', () => {
  it('accepts PascalCase, SCREAMING_SNAKE, spaced and UI aliases', () => {
    expect(
      parsePermissions([
        'ManageMessages',
        'BAN_MEMBERS',
        'view channel',
        'Manage Server',
        'Timeout Members',
      ]),
    ).toEqual(['ManageMessages', 'BanMembers', 'ViewChannel', 'ManageGuild', 'ModerateMembers']);
  });

  it('suggests close names for typos', () => {
    expect(() => parsePermissions(['ManageMessage'])).toThrow(/Did you mean: .*ManageMessages/);
  });

  it('round-trips bitfields', () => {
    const bits = permissionBits(['SendMessages', 'ViewChannel']);
    expect(bits).toBe(PermissionFlagsBits.SendMessages | PermissionFlagsBits.ViewChannel);
    expect(permissionNames(bits).sort()).toEqual(['SendMessages', 'ViewChannel']);
    expect(
      permissionNames(PermissionFlagsBits.Administrator | PermissionFlagsBits.KickMembers),
    ).toEqual(['Administrator']);
  });
});

describe('parseOffsetCursor', () => {
  it('parses offsets and rejects junk', () => {
    expect(parseOffsetCursor(undefined)).toBe(0);
    expect(parseOffsetCursor('50')).toBe(50);
    expect(() => parseOffsetCursor('-1')).toThrow(/next_cursor/);
    expect(() => parseOffsetCursor('abc')).toThrow();
  });
});
