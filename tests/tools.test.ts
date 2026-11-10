import { describe, expect, it, vi } from 'vitest';
import { Collection } from 'discord.js';
import { ALL_TOOLS } from '../src/tools/registry.js';
import { executeTool } from '../src/tools/execute.js';
import { sidebarOrder } from '../src/tools/core/server.js';
import { inviteCode } from '../src/tools/invites/index.js';
import { ChannelType, PermissionFlagsBits } from '../src/discord/api.js';
import { context } from './helpers.js';
import type { AnyTool } from '../src/tools/types.js';

const tool = (name: string): AnyTool => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

const BOT_ID = '200000000000000001';
const OWNER_ID = '200000000000000002';
const A1 = '800000000000000001';
const A2 = '800000000000000002';

function perms(all = true) {
  return { has: () => all, bitfield: all ? PermissionFlagsBits.Administrator : 0n };
}

function makeGuild() {
  const guild: Record<string, unknown> = {
    id: '300000000000000001',
    name: 'Guild',
    ownerId: OWNER_ID,
  };
  const role = (id: string, position: number) => ({
    id,
    name: `r${position}`,
    position,
    guild,
    managed: false,
    comparePositionTo: (other: { position: number }) => position - other.position,
  });
  const botRole = role('400000000000000010', 10);
  const lowRole = role('400000000000000002', 2);
  const highRole = role('400000000000000020', 20);
  const me = { id: BOT_ID, roles: { highest: botRole }, permissions: perms(true) };
  const mk = (id: string, username: string, highest: unknown) => ({
    id,
    displayName: username,
    nickname: null,
    guild,
    user: { id, username, globalName: null, bot: false },
    roles: { highest, cache: new Collection() },
    permissions: perms(false),
    kick: vi.fn(async () => undefined),
  });
  const low = mk('500000000000000001', 'low', lowRole);
  const high = mk('500000000000000002', 'high', highRole);
  const owner = mk(OWNER_ID, 'owner', lowRole);
  const members = new Collection([low, high, owner].map((m) => [m.id, m]));
  Object.assign(guild, {
    members: {
      me,
      cache: members,
      fetch: async (id: string) => members.get(id),
      search: async () => new Collection(),
    },
    client: { user: { id: BOT_ID } },
    roles: { cache: new Collection(), everyone: role('300000000000000001', 0) },
    channels: { cache: new Collection() },
  });
  return { guild, low, high, owner };
}

describe('kick_member', () => {
  it('returns a dry run and does not kick without confirm', async () => {
    const { guild, low } = makeGuild();
    const ctx = context({ guild: async () => guild as never });
    const res = await executeTool(
      tool('kick_member'),
      { member: low.id, reason: 'spam' },
      async () => ctx,
    );
    expect(textOf(res)).toContain('DRY RUN');
    expect(textOf(res)).toContain('kick @low (500000000000000001) from Guild (reason: spam)');
    expect(low.kick).not.toHaveBeenCalled();
  });

  it('kicks with confirm', async () => {
    const { guild, low } = makeGuild();
    const res = await executeTool(
      tool('kick_member'),
      { member: low.id, confirm: true },
      async () => context({ guild: async () => guild as never }),
    );
    expect(res.isError).toBeUndefined();
    expect(low.kick).toHaveBeenCalledOnce();
  });

  it('refuses members above the bot and the owner, before calling Discord', async () => {
    const { guild, high, owner } = makeGuild();
    const ctx = async () => context({ guild: async () => guild as never });
    const a = await executeTool(tool('kick_member'), { member: high.id, confirm: true }, ctx);
    expect(a.isError).toBe(true);
    expect(textOf(a)).toMatch(/not below the bot's highest role/);
    expect(high.kick).not.toHaveBeenCalled();
    const b = await executeTool(tool('kick_member'), { member: owner.id, confirm: true }, ctx);
    expect(textOf(b)).toBe('The server owner cannot be kicked.');
  });
});

describe('bulk_delete_messages', () => {
  function setup() {
    const now = Date.now();
    const msg = (
      id: string,
      author: string,
      minutesAgo: number,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      author: { id: author, username: author === A1 ? 'alice' : 'bob' },
      content: 'hello world',
      pinned: false,
      createdTimestamp: now - minutesAgo * 60_000,
      createdAt: new Date(now - minutesAgo * 60_000),
      ...extra,
    });
    const messages = new Collection(
      [
        msg('600000000000000005', A1, 1),
        msg('600000000000000004', A2, 2),
        msg('600000000000000003', A1, 3, { pinned: true }),
        msg('600000000000000002', A1, 15 * 24 * 60),
      ].map((m) => [m.id, m]),
    );
    const bulkDelete = vi.fn(async (ids: string[]) => new Collection(ids.map((i) => [i, {}])));
    const fetch = vi.fn(async () => messages);
    const guild = makeGuild().guild;
    const channel = {
      id: '700000000000000001',
      name: 'general',
      type: ChannelType.GuildText,
      guild,
      isTextBased: () => true,
      isThread: () => false,
      permissionsFor: () => perms(true),
      messages: { fetch },
      bulkDelete,
    };
    const client = {
      user: { id: BOT_ID },
      channels: { cache: new Collection([[channel.id, channel]]) },
      users: { fetch: async (id: string) => ({ id }) },
    };
    return { channel, client, bulkDelete, fetch };
  }

  it('skips pinned and >14-day messages and offers an exact up_to', async () => {
    const { channel, client, bulkDelete } = setup();
    const res = await executeTool(tool('bulk_delete_messages'), { channel: channel.id }, async () =>
      context({ client: client as never }),
    );
    const text = textOf(res);
    expect(text).toContain('Would: delete 2 message(s) in #general');
    expect(text).toContain('"up_to": "600000000000000005"');
    expect(text).toContain('1 matching message(s) are older than 14 days');
    expect(text).toContain('1 pinned message(s) skipped');
    expect(bulkDelete).not.toHaveBeenCalled();
  });

  it('filters by author and deletes only the planned IDs when confirmed', async () => {
    const { channel, client, bulkDelete, fetch } = setup();
    const res = await executeTool(
      tool('bulk_delete_messages'),
      { channel: channel.id, author: A1, up_to: '600000000000000005', confirm: true },
      async () => context({ client: client as never }),
    );
    expect(textOf(res)).toBe('Deleted 1 message(s) in #general (700000000000000001).');
    expect(bulkDelete).toHaveBeenCalledWith(['600000000000000005'], true);
    expect(fetch).toHaveBeenCalledWith({ limit: 50, before: '600000000000000006' });
  });
});

describe('send_message validation', () => {
  it('rejects content over 2000 characters with a hint, before any API call', async () => {
    const res = await executeTool(
      tool('send_message'),
      { channel: '700000000000000001', content: 'x'.repeat(2001) },
      async () => context(),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/2001 characters.*Split it/);
  });

  it('requires something to send', async () => {
    const res = await executeTool(
      tool('send_message'),
      { channel: '700000000000000001' },
      async () => context(),
    );
    expect(textOf(res)).toBe('Provide content, embeds or files.');
  });
});

describe('sidebarOrder', () => {
  it('lists uncategorised channels first, then each category with text before voice', () => {
    const c = (id: string, type: number, rawPosition: number, parentId: string | null = null) => ({
      id,
      type,
      rawPosition,
      parentId,
      isThread: () => false,
    });
    const catB = c('cB', ChannelType.GuildCategory, 1);
    const catA = c('cA', ChannelType.GuildCategory, 0);
    const voice = c('v', ChannelType.GuildVoice, 0, 'cA');
    const text = c('t', ChannelType.GuildText, 5, 'cA');
    const lone = c('l', ChannelType.GuildText, 9);
    const inB = c('b', ChannelType.GuildText, 0, 'cB');
    const order = sidebarOrder([catB, voice, inB, text, catA, lone] as never).map((x) => x.id);
    expect(order).toEqual(['l', 'cA', 't', 'v', 'cB', 'b']);
  });
});

describe('inviteCode', () => {
  it.each([
    ['abc123', 'abc123'],
    ['discord.gg/abc123', 'abc123'],
    ['https://discord.com/invite/abc-123', 'abc-123'],
    ['https://discordapp.com/invite/xyz', 'xyz'],
  ])('%s', (input, code) => expect(inviteCode(input)).toBe(code));

  it('rejects junk', () => {
    expect(() => inviteCode('not an invite!')).toThrow(/invite code/);
  });
});
