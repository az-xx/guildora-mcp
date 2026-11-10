import { z } from 'zod';
import type { Message, TextBasedChannel } from 'discord.js';
import { MessageType } from '../../discord/api.js';
import { defineTool } from '../types.js';
import { cursorSnowflake, guildField, messageChannelArg } from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { bytes, fmtChannel, ts } from '../../discord/format.js';
import { dateStamp, safeFileName, writeExport } from './files.js';

const INLINE_MAX = 100_000;

export interface ExportedMessage {
  id: string;
  timestamp: string;
  edited: string | null;
  author: { id: string; username: string; display_name: string | null; bot: boolean };
  content: string;
  reply_to: string | null;
  attachments: {
    id: string;
    name: string;
    size: number;
    content_type: string | null;
    url: string;
  }[];
  embeds: { title: string | null; description: string | null; url: string | null }[];
  reactions: { emoji: string; count: number }[];
  pinned: boolean;
}

export function toExported(m: Message): ExportedMessage {
  return {
    id: m.id,
    timestamp: m.createdAt.toISOString(),
    edited: m.editedAt ? m.editedAt.toISOString() : null,
    author: {
      id: m.author.id,
      username: m.author.username,
      display_name: m.member?.displayName ?? m.author.globalName ?? null,
      bot: m.author.bot,
    },
    content: m.content,
    reply_to: m.type === MessageType.Reply ? (m.reference?.messageId ?? null) : null,
    attachments: [...m.attachments.values()].map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      content_type: a.contentType ?? null,
      url: a.url,
    })),
    embeds: m.embeds.map((e) => ({
      title: e.title ?? null,
      description: e.description ?? null,
      url: e.url ?? null,
    })),
    reactions: [...m.reactions.cache.values()].map((r) => ({
      emoji: r.emoji.toString(),
      count: r.count,
    })),
    pinned: m.pinned,
  };
}

/** Human-readable transcript: one heading per day, one block per message. */
export function toMarkdown(title: string, meta: string, messages: ExportedMessage[]): string {
  const out = [`# ${title}`, '', meta, ''];
  let day = '';
  for (const m of messages) {
    const d = m.timestamp.slice(0, 10);
    if (d !== day) {
      day = d;
      out.push(`## ${d}`, '');
    }
    const who =
      m.author.display_name && m.author.display_name !== m.author.username
        ? `${m.author.display_name} (@${m.author.username})`
        : `@${m.author.username}`;
    const tags = [
      m.timestamp.slice(11, 19) + ' UTC',
      `msg ${m.id}`,
      m.reply_to ? `reply to ${m.reply_to}` : '',
      m.edited ? 'edited' : '',
      m.pinned ? 'pinned' : '',
      m.author.bot ? 'bot' : '',
    ].filter(Boolean);
    out.push(`**${who}** · ${tags.join(' · ')}`);
    if (m.content) out.push('', ...m.content.split('\n').map((l) => (l ? `> ${l}` : '>')));
    for (const a of m.attachments)
      out.push(`- Attachment: [${a.name}](${a.url}) (${bytes(a.size)})`);
    for (const e of m.embeds)
      out.push(
        `- Embed: ${[e.title, e.description, e.url].filter(Boolean).join(' — ') || '(no text)'}`,
      );
    if (m.reactions.length)
      out.push(`- Reactions: ${m.reactions.map((r) => `${r.emoji} ${r.count}`).join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}

async function collect(
  channel: TextBasedChannel,
  max: number,
  beforeId: string | undefined,
  afterId: string | undefined,
): Promise<{ messages: Message[]; reachedStart: boolean }> {
  const out: Message[] = [];
  let before = beforeId;
  let reachedStart = false;
  while (out.length < max) {
    const requested = Math.min(100, max - out.length);
    const batch = await channel.messages.fetch({ limit: requested, ...(before ? { before } : {}) });
    const sorted = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    for (const m of sorted) {
      if (afterId && BigInt(m.id) <= BigInt(afterId)) {
        reachedStart = true;
        break;
      }
      out.push(m);
    }
    // Fewer messages than asked for means there is nothing older.
    if (reachedStart || batch.size < requested) {
      reachedStart = true;
      break;
    }
    before = sorted.at(-1)!.id;
  }
  return { messages: out.reverse(), reachedStart };
}

export const exportMessages = defineTool({
  name: 'export_messages',
  pack: 'insights',
  title: 'Export a conversation',
  description:
    'Saves a channel, ticket, thread, forum post or DM to a Markdown transcript or JSON file (authors, times, ' +
    'replies, attachment links, embeds, reactions). Files go to GUILDORA_EXPORT_DIR (default ~/guildora-exports) ' +
    'and never overwrite existing ones. Over HTTP the export is returned inline instead. Returns the file path.',
  input: {
    channel: z
      .string()
      .optional()
      .describe('Channel, thread or forum post: ID, mention, link or name.'),
    user: z
      .string()
      .optional()
      .describe('Instead of channel: export your DM history with this user.'),
    guild: guildField,
    format: z.enum(['markdown', 'json']).optional().describe('Default "markdown".'),
    max_messages: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Newest N messages (default 1000).'),
    after: z.string().optional().describe('Only messages after this ISO date or message ID.'),
    before: z.string().optional().describe('Only messages before this ISO date or message ID.'),
    path: z.string().optional().describe('File path (relative to the export folder, or absolute).'),
  },
  readOnly: true,
  async run(args, ctx) {
    if (!args.channel && !args.user)
      throw new GuildoraError('Pass "channel" (or "user" for a DM).');
    const channel = await messageChannelArg(ctx, args);
    const format = args.format ?? 'markdown';
    const max = args.max_messages ?? 1000;
    const { messages, reachedStart } = await collect(
      channel,
      max,
      cursorSnowflake(args.before, 'before'),
      cursorSnowflake(args.after, 'after'),
    );
    if (messages.length === 0)
      throw new GuildoraError(`No messages to export in ${fmtChannel(channel)} for that range.`);

    const data = messages.map(toExported);
    const name = 'name' in channel && channel.name ? channel.name : channel.id;
    const guildName = 'guild' in channel && channel.guild ? channel.guild.name : 'Direct messages';
    const first = data[0]!.timestamp;
    const last = data.at(-1)!.timestamp;
    const meta = `Server: ${guildName} · Channel: ${name} (${channel.id}) · ${data.length} message(s) from ${first} to ${last} · exported ${new Date().toISOString()} by Guildora${reachedStart ? '' : ` · older messages not included (max_messages ${max})`} · attachment links are signed by Discord and expire after about a day`;
    const contents =
      format === 'json'
        ? JSON.stringify(
            {
              server: guildName,
              channel: { id: channel.id, name },
              exported_at: new Date().toISOString(),
              complete: reachedStart,
              messages: data,
            },
            null,
            2,
          )
        : toMarkdown(`${guildName} · #${name}`, meta, data);

    const ext = format === 'json' ? 'json' : 'md';
    const path = await writeExport(
      ctx,
      `${safeFileName(`${guildName}-${name}`)}-${dateStamp()}.${ext}`,
      contents,
      args.path,
    );
    const summary =
      `${data.length} message(s) from ${fmtChannel(channel)}, ${ts(new Date(first))} to ${ts(new Date(last))}` +
      `${reachedStart ? ' (whole range)' : ` (newest ${max}; raise max_messages or set after for older ones)`}`;
    if (path) return `Exported ${summary} to ${path} (${bytes(Buffer.byteLength(contents))}).`;
    const inline =
      contents.length > INLINE_MAX ? `${contents.slice(0, INLINE_MAX)}\n… (truncated)` : contents;
    return `Exported ${summary}. Files are not written over HTTP; here is the ${format} content:\n\n${inline}`;
  },
});
