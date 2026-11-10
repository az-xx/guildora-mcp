import { z } from 'zod';
import type { Guild, Message, TextBasedChannel } from 'discord.js';
import { isDiscordApiError } from '../../discord/api.js';
import { defineTool, type ToolContext } from '../types.js';
import { cursorSnowflake, guildField, messageChannelArg } from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { resolveUser } from '../../discord/resolve.js';
import { isSnowflake } from '../../discord/parse.js';
import { fmtChannel, fmtMessage, page, ts, truncate } from '../../discord/format.js';

const HAS_VALUES = ['image', 'video', 'sound', 'file', 'sticker', 'embed', 'link', 'poll'] as const;
type Has = (typeof HAS_VALUES)[number];

interface RawMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  attachments?: { filename: string; size: number; url: string }[];
  embeds?: { title?: string; description?: string }[];
  message_reference?: { message_id?: string };
  type: number;
}

interface SearchResponse {
  messages?: RawMessage[][];
  total_results?: number;
  doing_deep_historical_index?: boolean;
  code?: number;
  retry_after?: number;
}

const INDEX_NOT_READY = 110000;

function fmtRaw(m: RawMessage, guild: Guild): string {
  const channel = guild.channels.cache.get(m.channel_id);
  const name =
    m.author.global_name && m.author.global_name !== m.author.username
      ? `${m.author.global_name} `
      : '';
  const lines = [
    `[${ts(new Date(m.timestamp))}] ${name}@${m.author.username} (${m.author.id})${m.author.bot ? ' [bot]' : ''} · msg ${m.id} · in ${channel ? fmtChannel(channel) : m.channel_id}`,
  ];
  if (m.content) lines.push(...m.content.split('\n').map((l) => `  ${l}`));
  for (const a of m.attachments ?? []) lines.push(`  [attachment] ${a.filename} ${a.url}`);
  for (const e of m.embeds ?? [])
    lines.push(
      `  [embed] ${[e.title, e.description && truncate(e.description, 200)].filter(Boolean).join(' — ') || '(no text)'}`,
    );
  return lines.join('\n');
}

function matchesHas(m: Message, has: Has): boolean {
  const types = [...m.attachments.values()].map((a) => a.contentType ?? '');
  switch (has) {
    case 'image':
      return (
        types.some((t) => t.startsWith('image/')) || m.embeds.some((e) => e.image || e.thumbnail)
      );
    case 'video':
      return types.some((t) => t.startsWith('video/')) || m.embeds.some((e) => e.video);
    case 'sound':
      return types.some((t) => t.startsWith('audio/'));
    case 'file':
      return m.attachments.size > 0;
    case 'sticker':
      return m.stickers.size > 0;
    case 'embed':
      return m.embeds.length > 0;
    case 'link':
      return /https?:\/\/\S+/i.test(m.content);
    case 'poll':
      return m.poll !== null;
  }
}

interface Filters {
  query?: string | undefined;
  authorId?: string | undefined;
  mentionId?: string | undefined;
  has?: Has[] | undefined;
  pinned?: boolean | undefined;
  afterId?: string | undefined;
}

function matches(m: Message, f: Filters): boolean {
  if (f.query && !m.content.toLowerCase().includes(f.query.toLowerCase())) return false;
  if (f.authorId && m.author.id !== f.authorId) return false;
  if (f.mentionId && !m.mentions.users.has(f.mentionId)) return false;
  if (f.pinned !== undefined && m.pinned !== f.pinned) return false;
  if (f.has?.some((h) => !matchesHas(m, h))) return false;
  return true;
}

async function scanChannel(
  ctx: ToolContext,
  channel: TextBasedChannel,
  f: Filters,
  opts: { before?: string | undefined; limit: number; scanLimit: number },
  reason: string,
): Promise<string> {
  const found: Message[] = [];
  let before = opts.before;
  let scanned = 0;
  let reachedStart = false;
  let reachedAfter = false;
  outer: while (scanned < opts.scanLimit && found.length < opts.limit) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, opts.scanLimit - scanned),
      ...(before ? { before } : {}),
    });
    if (batch.size === 0) {
      reachedStart = true;
      break;
    }
    const sorted = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    for (const m of sorted) {
      if (f.afterId && BigInt(m.id) <= BigInt(f.afterId)) {
        reachedAfter = true;
        break outer;
      }
      scanned++;
      before = m.id;
      if (matches(m, f)) found.push(m);
      if (found.length >= opts.limit) break outer;
    }
    if (batch.size < 100) {
      reachedStart = true;
      break;
    }
  }
  const coverage = reachedStart
    ? 'reached the start of the channel'
    : reachedAfter
      ? 'reached the "after" bound'
      : `more history remains; continue with cursor "${before}"`;
  const note =
    !ctx.intents.messageContent && f.query
      ? "\nNote: the Message Content intent is off, so text matching only sees the bot's own messages, DMs and mentions."
      : '';
  return page(
    `${found.length} match(es) in ${fmtChannel(channel)} by scanning ${scanned} message(s), newest first (${coverage}). ${reason}`,
    found.map((m) => fmtMessage(m, { maxContent: 600 })),
    !reachedStart && !reachedAfter && before ? before : undefined,
    note || undefined,
  );
}

export const searchMessages = defineTool({
  name: 'search_messages',
  pack: 'core',
  title: 'Search messages',
  description:
    'Finds messages by text, author, mentions, attachments/links (has), pinned state and date range. Uses ' +
    "Discord's server-wide search when available (whole history, all channels). Otherwise, or if " +
    "scan: true, it scans one channel's history up to scan_limit and states exactly how much it scanned. " +
    'Results include message IDs and channels; use get_message or read_messages around=ID for context.',
  input: {
    guild: guildField,
    query: z.string().max(1024).optional().describe('Text the message must contain.'),
    channel: z
      .string()
      .optional()
      .describe('Limit to one channel or thread (ID, mention, link or name).'),
    author: z.string().optional().describe('Only messages by this user (ID, mention or name).'),
    mentions: z.string().optional().describe('Only messages that mention this user.'),
    has: z.array(z.enum(HAS_VALUES)).optional().describe('Only messages that have all of these.'),
    pinned: z.boolean().optional(),
    before: z.string().optional().describe('Only before this ISO date or message ID.'),
    after: z.string().optional().describe('Only after this ISO date or message ID.'),
    sort: z
      .enum(['newest', 'oldest', 'relevance'])
      .optional()
      .describe('Server search only (default newest).'),
    limit: z.number().int().min(1).max(25).optional().describe('Max results (1-25, default 25).'),
    cursor: z.string().optional().describe('next_cursor from a previous call.'),
    scan: z
      .boolean()
      .optional()
      .describe('Skip server search and scan the channel history directly.'),
    scan_limit: z
      .number()
      .int()
      .min(100)
      .max(10000)
      .optional()
      .describe('Max messages to scan (default and cap: GUILDORA_SCAN_LIMIT).'),
  },
  readOnly: true,
  async run(args, ctx) {
    if (
      !args.query &&
      !args.author &&
      !args.mentions &&
      !args.has?.length &&
      args.pinned === undefined &&
      !args.before &&
      !args.after
    ) {
      throw new GuildoraError(
        'Give at least one filter: query, author, mentions, has, pinned, before or after.',
      );
    }
    const limit = args.limit ?? 25;
    const channel = args.channel
      ? await messageChannelArg(ctx, { channel: args.channel, guild: args.guild })
      : undefined;
    const guild =
      channel && 'guild' in channel && channel.guild ? channel.guild : await ctx.guild(args.guild);
    const authorId = args.author
      ? (await resolveUser(ctx.client, guild, args.author)).id
      : undefined;
    const mentionId = args.mentions
      ? (await resolveUser(ctx.client, guild, args.mentions)).id
      : undefined;
    const beforeId = cursorSnowflake(args.before, 'before');
    const afterId = cursorSnowflake(args.after, 'after');
    const filters: Filters = {
      query: args.query,
      authorId,
      mentionId,
      has: args.has,
      pinned: args.pinned,
      afterId,
    };
    const scanLimit = Math.min(args.scan_limit ?? ctx.config.scanLimit, ctx.config.scanLimit);

    const fallback = async (reason: string) => {
      if (!channel) {
        throw new GuildoraError(`${reason} Pass "channel" to scan one channel's history instead.`);
      }
      const scanBefore = args.cursor && isSnowflake(args.cursor) ? args.cursor : beforeId;
      return scanChannel(ctx, channel, filters, { before: scanBefore, limit, scanLimit }, reason);
    };

    if (args.scan || channel?.isDMBased())
      return fallback(args.scan ? 'Scan requested.' : 'DMs have no server search.');

    const offset = args.cursor ? Number(args.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new GuildoraError(
        'Invalid cursor for server search: pass next_cursor from the previous result.',
      );
    }
    const params = new URLSearchParams();
    if (args.query) params.set('content', args.query);
    if (channel) params.append('channel_id', channel.id);
    if (authorId) params.append('author_id', authorId);
    if (mentionId) params.append('mentions', mentionId);
    for (const h of args.has ?? []) params.append('has', h);
    if (args.pinned !== undefined) params.set('pinned', String(args.pinned));
    if (beforeId) params.set('max_id', beforeId);
    if (afterId) params.set('min_id', afterId);
    if (args.sort === 'relevance') params.set('sort_by', 'relevance');
    else params.set('sort_order', args.sort === 'oldest' ? 'asc' : 'desc');
    params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));

    let res: SearchResponse;
    try {
      res = (await ctx.client.rest.get(`/guilds/${guild.id}/messages/search`, {
        query: params,
      })) as SearchResponse;
    } catch (e) {
      if (isDiscordApiError(e) && [400, 403, 404].includes(e.status)) {
        return fallback(`Server search is unavailable for this bot (${e.message}).`);
      }
      throw e;
    }
    if (res.code === INDEX_NOT_READY || !res.messages) {
      const wait = res.retry_after ? ` Try again in about ${Math.ceil(res.retry_after)}s.` : '';
      return fallback(`Discord is still indexing this server for search.${wait}`);
    }

    const hits = res.messages.map((group) => group[0]).filter((m): m is RawMessage => Boolean(m));
    const total = res.total_results ?? hits.length;
    const nextOffset = offset + hits.length;
    const more = hits.length > 0 && nextOffset < total && nextOffset <= 9975;
    const notes: string[] = [];
    if (res.doing_deep_historical_index)
      notes.push('Note: Discord is still indexing older history; results may be incomplete.');
    if (!ctx.intents.messageContent)
      notes.push('Note: the Message Content intent is off, so message text may be empty.');
    return page(
      `${total} message(s) match in ${guild.name} (server search); showing ${offset + 1}-${nextOffset}:`,
      hits.map((m) => fmtRaw(m, guild)),
      more ? String(nextOffset) : undefined,
      notes.join('\n') || undefined,
    );
  },
});
