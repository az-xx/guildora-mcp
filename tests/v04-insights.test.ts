import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection } from 'discord.js';
import { planCategories } from '../src/tools/channels/archive.js';
import { safeFileName, uniquePath, writeExport } from '../src/tools/insights/files.js';
import { toMarkdown, type ExportedMessage } from '../src/tools/insights/export.js';
import { diffSnapshots, type Snapshot } from '../src/tools/insights/snapshot.js';
import { aggregate } from '../src/tools/insights/stats.js';
import { ChannelType } from '../src/discord/api.js';
import { config, context } from './helpers.js';

describe('archive_channel planning', () => {
  const category = (id: string, name: string, children: number, rawPosition = 0) => ({
    id,
    name,
    type: ChannelType.GuildCategory,
    rawPosition,
    children: { cache: { size: children } },
  });
  const guildWith = (...cats: ReturnType<typeof category>[]) =>
    ({ channels: { cache: new Collection(cats.map((c) => [c.id, c])) } }) as never;

  it('creates "Archive" when none exists', () => {
    expect(planCategories(guildWith(), 3)).toEqual([{ createName: 'Archive', room: 50 }]);
  });

  it('fills existing archive categories first, then creates the next number', () => {
    const a = category('1', 'Archive', 48);
    const plans = planCategories(guildWith(a, category('2', 'General', 0)), 5);
    expect(plans).toEqual([
      { existing: a, room: 2 },
      { createName: 'Archive 2', room: 50 },
    ]);
  });

  it('refuses an explicit category without enough room (Discord allows 50 per category)', () => {
    const full = category('3', 'Old', 49);
    expect(() => planCategories(guildWith(full), 2, full as never)).toThrow(/room for 1 more/);
  });
});

describe('export files', () => {
  let dir = '';
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('makes names safe for every OS', () => {
    expect(safeFileName('BubbleClean-💬│chat: a/b?')).toBe('BubbleClean-💬│chat-a-b');
    expect(safeFileName('\u0001\u0002')).toBe('export');
  });

  it('never overwrites existing files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'guildora-test-'));
    const p = join(dir, 'a.md');
    await writeFile(p, 'x');
    expect(await uniquePath(p)).toBe(join(dir, 'a-2.md'));
  });

  it('writes in stdio mode and returns nothing over HTTP', async () => {
    dir ||= await mkdtemp(join(tmpdir(), 'guildora-test-'));
    const ctx = context({ config: config({ exportDir: dir }) });
    const path = await writeExport(ctx, 'x.json', '{}');
    expect(path).toBe(join(dir, 'x.json'));
    expect(await readFile(path!, 'utf8')).toBe('{}');
    const http = context({ config: config({ exportDir: dir, transport: 'http' }) });
    expect(await writeExport(http, 'y.json', '{}')).toBeUndefined();
  });
});

describe('export_messages transcript', () => {
  it('groups by day and keeps authors, replies, attachments and reactions', () => {
    const msg = (over: Partial<ExportedMessage>): ExportedMessage => ({
      id: '1',
      timestamp: '2026-11-09T10:00:00.000Z',
      edited: null,
      author: { id: '9', username: 'alice', display_name: 'Alice', bot: false },
      content: 'hello\nworld',
      reply_to: null,
      attachments: [],
      embeds: [],
      reactions: [],
      pinned: false,
      ...over,
    });
    const md = toMarkdown('Server · #chat', 'meta', [
      msg({}),
      msg({
        id: '2',
        timestamp: '2026-11-10T08:30:05.000Z',
        reply_to: '1',
        attachments: [
          {
            id: 'a',
            name: 'log.txt',
            size: 2048,
            content_type: 'text/plain',
            url: 'https://cdn/x',
          },
        ],
        reactions: [{ emoji: '👍', count: 2 }],
      }),
    ]);
    expect(md).toContain('## 2026-11-09');
    expect(md).toContain('## 2026-11-10');
    expect(md).toContain('**Alice (@alice)** · 10:00:00 UTC · msg 1');
    expect(md).toContain('> hello\n> world');
    expect(md).toContain('reply to 1');
    expect(md).toContain('- Attachment: [log.txt](https://cdn/x) (2.0 KB)');
    expect(md).toContain('- Reactions: 👍 2');
  });
});

describe('server_snapshot diff', () => {
  const base = (): Snapshot => ({
    guildora_snapshot: 1,
    taken_at: '2026-11-01T00:00:00.000Z',
    guild: {
      id: 'g',
      name: 'Server',
      owner_id: 'o',
      verification_level: 1,
      features: [],
      system_channel_id: null,
      rules_channel_id: null,
      member_count: 200,
    },
    roles: [
      {
        id: 'r1',
        name: 'Staff',
        position: 2,
        color: '#3498DB',
        hoist: true,
        mentionable: false,
        managed: false,
        permissions: ['ManageMessages'],
      },
    ],
    channels: [
      {
        id: 'c1',
        name: 'general',
        type: 'text',
        parent_id: null,
        position: 0,
        topic: null,
        nsfw: false,
        slowmode: 0,
        synced: false,
        overwrites: [{ id: 'g', type: 'role', name: '@everyone', allow: [], deny: [] }],
      },
    ],
    emojis: [],
    stickers: [],
  });

  it('reports no changes for identical snapshots', () => {
    expect(diffSnapshots(base(), base())).toEqual([]);
  });

  it('reports role, channel, permission and member changes', () => {
    const cur = base();
    cur.guild.member_count = 212;
    cur.roles[0]!.permissions = ['ManageMessages', 'KickMembers'];
    cur.roles.push({
      id: 'r2',
      name: 'VIP',
      position: 1,
      color: '#FFD700',
      hoist: false,
      mentionable: false,
      managed: false,
      permissions: [],
    });
    cur.channels[0]!.name = 'chat';
    cur.channels[0]!.overwrites[0]!.deny = ['SendMessages'];
    cur.channels.push({ ...cur.channels[0]!, id: 'c2', name: 'new', overwrites: [] });
    const diff = diffSnapshots(base(), cur);
    expect(diff).toContain('Members: 200 → 212');
    expect(diff).toContain('Role added: @VIP (r2)');
    expect(diff).toContain('Role @Staff (r1): permissions +KickMembers');
    expect(diff).toContain('Channel added: #new (c2) [text] in no category');
    expect(diff.find((d) => d.startsWith('Channel #chat (c1)'))).toBe(
      'Channel #chat (c1): renamed from #general; overwrite for role @everyone: deny +SendMessages',
    );
  });
});

describe('message_stats aggregate', () => {
  it('counts people and bots per channel, author, day and hour', () => {
    const s = aggregate([
      {
        channelId: 'a',
        authorId: '1',
        authorName: 'alice',
        bot: false,
        timestamp: Date.parse('2026-11-09T18:05:00Z'),
      },
      {
        channelId: 'a',
        authorId: '1',
        authorName: 'alice',
        bot: false,
        timestamp: Date.parse('2026-11-09T18:40:00Z'),
      },
      {
        channelId: 'b',
        authorId: '2',
        authorName: 'bob',
        bot: false,
        timestamp: Date.parse('2026-11-10T09:00:00Z'),
      },
      {
        channelId: 'b',
        authorId: '3',
        authorName: 'bot',
        bot: true,
        timestamp: Date.parse('2026-11-10T09:01:00Z'),
      },
    ]);
    expect(s).toMatchObject({ total: 4, people: 3, bots: 1, activePeople: 2 });
    expect(s.byChannel.get('a')).toEqual({ total: 2, people: 2 });
    expect(s.byChannel.get('b')).toEqual({ total: 2, people: 1 });
    expect(s.byAuthor.get('1')?.count).toBe(2);
    expect(s.byDay.get('2026-11-09')).toBe(2);
    expect(s.byHour[18]).toBe(2);
    expect(s.byHour[9]).toBe(2);
  });
});
