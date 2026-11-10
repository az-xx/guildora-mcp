import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { attachmentKind, fitImage, resizedProxyUrl } from '../src/tools/core/attachments.js';
import { lastActivity, mapLimit, parseSince, waitingRun } from '../src/tools/core/activity.js';
import { keyPerms, permLine } from '../src/tools/core/access.js';
import { executeTool } from '../src/tools/execute.js';
import { defineTool } from '../src/tools/types.js';
import { ChannelType, PermissionFlagsBits, snowflakeFromTimestamp } from '../src/discord/api.js';
import { context } from './helpers.js';

describe('get_attachment helpers', () => {
  it('keeps small images and scales large ones within 1568px / 1.15 MP, keeping the aspect ratio', () => {
    expect(fitImage(800, 600)).toEqual({ width: 800, height: 600 });
    const wide = fitImage(4000, 1000);
    expect(wide.width).toBeLessThanOrEqual(1568);
    expect(wide.width / wide.height).toBeCloseTo(4, 1);
    const big = fitImage(3000, 3000);
    expect(big.width * big.height).toBeLessThanOrEqual(1_150_000);
    expect(big.width).toBe(big.height);
  });

  it('adds width and height to the media proxy URL, keeping the signature', () => {
    const url = resizedProxyUrl(
      'https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2&hm=abc',
      1024,
      768,
    );
    expect(url).toBe(
      'https://media.discordapp.net/attachments/1/2/a.png?ex=1&is=2&hm=abc&width=1024&height=768',
    );
  });

  it('classifies attachments', () => {
    expect(attachmentKind({ contentType: 'image/png', name: 'a.png' })).toBe('image');
    expect(attachmentKind({ contentType: 'image/jpeg; charset=x', name: 'a' })).toBe('image');
    expect(attachmentKind({ contentType: 'text/plain; charset=utf-8', name: 'log' })).toBe('text');
    expect(attachmentKind({ contentType: null, name: 'crash.log' })).toBe('text');
    expect(attachmentKind({ contentType: 'application/json', name: 'x' })).toBe('text');
    expect(attachmentKind({ contentType: 'image/svg+xml', name: 'x.svg' })).toBe('other');
    expect(attachmentKind({ contentType: 'application/zip', name: 'x.zip' })).toBe('other');
  });

  it('returns images as MCP image content next to the text', async () => {
    const tool = defineTool({
      name: 'img',
      pack: 'core',
      title: 'Image',
      description: 'Returns an image for testing the rich output path of executeTool.',
      input: { x: z.string().optional() },
      readOnly: true,
      run: async () => ({ text: 'one image', images: [{ data: 'aGk=', mimeType: 'image/png' }] }),
    });
    const res = await executeTool(tool, {}, async () => context());
    expect(res.content).toEqual([
      { type: 'text', text: 'one image' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
    ]);
  });
});

const msg = (author: string, minutesAgo: number, bot = false) =>
  ({
    author: { id: author, bot },
    createdTimestamp: Date.now() - minutesAgo * 60_000,
  }) as never;

describe('list_unanswered: waitingRun', () => {
  const staff = new Set(['staff']);
  const isStaff = (m: { author: { id: string } }) => staff.has(m.author.id);

  it('is waiting when the newest human messages are not from staff', () => {
    const run = waitingRun([msg('user', 1), msg('user', 5), msg('staff', 10)], isStaff, false);
    expect(run?.messages).toHaveLength(2);
    expect(run?.noStaffInWindow).toBe(false);
  });

  it('is answered when staff spoke last', () => {
    expect(waitingRun([msg('staff', 1), msg('user', 5)], isStaff, false)).toBeUndefined();
  });

  it('ignores bot messages by default, or treats them as answers when asked', () => {
    const msgs = [msg('bot', 1, true), msg('user', 5)];
    expect(waitingRun(msgs, isStaff, false)?.messages).toHaveLength(1);
    expect(waitingRun(msgs, isStaff, true)).toBeUndefined();
  });

  it('flags channels where staff never replied in the window', () => {
    expect(waitingRun([msg('user', 1), msg('other', 2)], isStaff, false)?.noStaffInWindow).toBe(
      true,
    );
  });

  it('skips channels with only bot messages', () => {
    expect(waitingRun([msg('bot', 1, true)], isStaff, false)).toBeUndefined();
  });
});

describe('activity helpers', () => {
  it('parses "since" as a duration ago or an ISO date', () => {
    const d = parseSince('2h', '24h');
    expect(Math.abs(Date.now() - 2 * 3_600_000 - d.getTime())).toBeLessThan(1000);
    expect(parseSince(undefined, '1d').getTime()).toBeLessThan(Date.now() - 86_000_000);
    expect(parseSince('2026-11-01', '24h').toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('reads last activity from the cached last message ID', () => {
    const t = Date.parse('2026-11-05T12:00:00Z');
    expect(Math.abs(lastActivity({ lastMessageId: snowflakeFromTimestamp(t) }) - t)).toBeLessThan(
      2,
    );
    expect(lastActivity({ lastMessageId: null, createdTimestamp: 42 })).toBe(42);
  });

  it('mapLimit keeps order and caps concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4, 1], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40, 10]);
    expect(peak).toBe(2);
  });
});

describe('check_access helpers', () => {
  it('picks voice permissions for voice channels', () => {
    expect(keyPerms(ChannelType.GuildVoice)).toContain('Connect');
    expect(keyPerms(ChannelType.GuildText)).toContain('SendMessages');
    expect(keyPerms(ChannelType.GuildText)).not.toContain('Connect');
  });

  it('renders yes/NO per permission', () => {
    const has = (b: bigint) => b === PermissionFlagsBits.ViewChannel;
    expect(permLine(has, ['ViewChannel', 'SendMessages'])).toBe(
      'ViewChannel yes · SendMessages NO',
    );
  });
});
