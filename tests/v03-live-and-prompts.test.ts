import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MessageBuffer, toBuffered, type BufferedMessage } from '../src/discord/buffer.js';
import { MessageType } from '../src/discord/api.js';
import { executeTool } from '../src/tools/execute.js';
import { ALL_TOOLS, selectTools } from '../src/tools/registry.js';
import { PROMPTS } from '../src/mcp/prompts.js';
import { createMcpServer } from '../src/mcp/server.js';
import { context } from './helpers.js';

const G = '300000000000000001';
let seq = 1000000000000000000n;
function rec(over: Partial<BufferedMessage> = {}): BufferedMessage {
  seq += 1n;
  return {
    id: seq.toString(),
    guildId: G,
    channelId: '700000000000000001',
    parentId: '600000000000000001',
    categoryId: '600000000000000001',
    channelName: 'general',
    authorId: '800000000000000001',
    authorName: 'alice',
    displayName: null,
    bot: false,
    createdTimestamp: Date.now(),
    content: 'hello',
    attachments: [],
    embeds: 0,
    replyTo: null,
    mentionsBot: false,
    ...over,
  };
}

describe('MessageBuffer', () => {
  it('returns messages after a cursor, oldest first, with paging', () => {
    const b = new MessageBuffer();
    const items = [rec(), rec(), rec(), rec()];
    for (const m of items) b.add(m);
    const first = b.query({ guildId: G, limit: 2 });
    expect(first.messages.map((m) => m.id)).toEqual([items[0]!.id, items[1]!.id]);
    expect(first.more).toBe(true);
    const second = b.query({ guildId: G, after: items[1]!.id, limit: 10 });
    expect(second.messages.map((m) => m.id)).toEqual([items[2]!.id, items[3]!.id]);
    expect(second.more).toBe(false);
  });

  it('filters by server, scope (channel, thread parent, category), bots and mentions', () => {
    const b = new MessageBuffer();
    b.add(rec({ guildId: '300000000000000009' }));
    b.add(rec({ bot: true }));
    b.add(
      rec({
        channelId: '700000000000000002',
        parentId: '700000000000000003',
        categoryId: '600000000000000002',
      }),
    );
    b.add(rec({ mentionsBot: true }));
    expect(b.query({ guildId: G, limit: 50 }).messages).toHaveLength(2);
    expect(b.query({ guildId: G, includeBots: true, limit: 50 }).messages).toHaveLength(3);
    expect(b.query({ guildId: G, scopeId: '700000000000000003', limit: 50 }).messages).toHaveLength(
      1,
    );
    expect(b.query({ guildId: G, scopeId: '600000000000000002', limit: 50 }).messages).toHaveLength(
      1,
    );
    expect(b.query({ guildId: G, onlyMentions: true, limit: 50 }).messages).toHaveLength(1);
  });

  it('keeps memory bounded and reports what it still covers', () => {
    const b = new MessageBuffer(3);
    for (let i = 0; i < 5; i++) b.add(rec({ createdTimestamp: 1000 + i }));
    expect(b.size).toBe(3);
    expect(b.coversSince).toBe(1002);
  });
});

describe('toBuffered', () => {
  const BOT = '200000000000000001';
  function message(over: Record<string, unknown> = {}) {
    const parent = { id: '700000000000000010', parentId: '600000000000000010' };
    return {
      id: '900000000000000001',
      guildId: G,
      guild: { members: { me: { roles: { cache: new Map() } } } },
      channelId: '700000000000000011',
      channel: { isThread: () => true, parentId: parent.id, parent, name: 'bug: crash' },
      type: MessageType.Reply,
      reference: { messageId: '900000000000000000' },
      author: { id: '800000000000000002', username: 'bob', globalName: 'Bob', bot: false },
      member: null,
      webhookId: null,
      createdTimestamp: 1,
      content: 'still broken',
      attachments: new Map([['1', { name: 'log.txt' }]]),
      embeds: [],
      mentions: {
        users: new Map([[BOT, {}]]),
        repliedUser: null,
        roles: { some: () => false },
      },
      ...over,
    } as never;
  }

  it('records thread parent and category, reply target and bot mentions', () => {
    const r = toBuffered(message(), BOT)!;
    expect(r).toMatchObject({
      channelId: '700000000000000011',
      parentId: '700000000000000010',
      categoryId: '600000000000000010',
      channelName: 'bug: crash',
      replyTo: '900000000000000000',
      mentionsBot: true,
      attachments: ['log.txt'],
      displayName: 'Bob',
    });
  });

  it('skips DMs and system messages', () => {
    expect(toBuffered(message({ guildId: null, guild: null }), BOT)).toBeUndefined();
    expect(toBuffered(message({ type: MessageType.ChannelPinnedMessage }), BOT)).toBeUndefined();
  });
});

describe('get_new_messages', () => {
  const tool = ALL_TOOLS.find((t) => t.name === 'get_new_messages')!;
  const guild = { id: G, name: 'Guild' };

  it('returns new messages and a cursor to continue from', async () => {
    const buffer = new MessageBuffer();
    const a = rec({ content: 'first' });
    const b = rec({ content: 'second', mentionsBot: true });
    buffer.add(a);
    buffer.add(b);
    const ctx = context({ buffer, guild: async () => guild as never });
    const res = await executeTool(tool, {}, async () => ctx);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('2 new message(s) in Guild since startup');
    expect(text).toContain('first');
    expect(text).toContain('mentions the bot');
    expect(text).toContain(`next_cursor: ${b.id}`);

    const again = await executeTool(tool, { cursor: b.id }, async () => ctx);
    expect((again.content[0] as { text: string }).text).toContain('0 new message(s)');
  });

  it('explains when live messages are unavailable', async () => {
    const res = await executeTool(tool, {}, async () => context());
    expect(res.isError).toBe(true);
  });
});

describe('prompts', () => {
  const names = (readOnly: boolean, packs: ('core' | 'threads')[] = ['core', 'threads']) =>
    new Set(selectTools(ALL_TOOLS, { packs, readOnly }).map((t) => t.name));

  it('only reference tools that exist', () => {
    const all = new Set(ALL_TOOLS.map((t) => t.name));
    for (const p of PROMPTS) {
      const text = p.build({}, names(false));
      for (const word of text.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) {
        if (
          word.includes('_') &&
          !['only_mentions', 'staff_roles', 'reply_to', 'next_cursor'].includes(word)
        ) {
          expect(all.has(word), `${p.name} mentions ${word}`).toBe(true);
        }
      }
    }
  });

  it('adapt to read-only mode and missing packs', () => {
    const triage = PROMPTS.find((p) => p.name === 'triage_forum')!;
    expect(triage.build({ forum: 'bug-reports' }, names(false))).toContain(
      'post it with send_message',
    );
    expect(triage.build({ forum: 'bug-reports' }, names(true))).toContain('only write drafts');
    expect(triage.build({}, names(false, ['core']))).toContain('list_threads');
    const digest = PROMPTS.find((p) => p.name === 'server_digest')!;
    expect(digest.build({ since: '7d' }, names(true))).toContain('since "7d"');
  });

  it('are served over MCP (prompts/list and prompts/get)', async () => {
    const tools = selectTools(ALL_TOOLS, { packs: ['core', 'threads'], readOnly: true });
    const server = createMcpServer(tools, async () => context(), {
      version: 'test',
      packs: ['core', 'threads'],
      readOnly: true,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const list = await client.listPrompts();
    expect(list.prompts.map((p) => p.name).sort()).toEqual([
      'catch_up',
      'reply_queue',
      'server_digest',
      'triage_forum',
    ]);
    const got = await client.getPrompt({ name: 'reply_queue', arguments: { scope: 'tickets' } });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toContain('list_unanswered with scope "tickets"');
    expect(text).toContain('only write drafts');
    await client.close();
  });
});
