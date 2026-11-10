import { z } from 'zod';
import { defineTool } from '../types.js';
import { channelArg, guildField } from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { isSnowflake, snowflakeAt } from '../../discord/parse.js';
import type { BufferedMessage } from '../../discord/buffer.js';
import { page, ts } from '../../discord/format.js';

export function fmtBuffered(m: BufferedMessage): string {
  const name = m.displayName && m.displayName !== m.authorName ? `${m.displayName} ` : '';
  const head = [
    `[${ts(m.createdTimestamp)}] ${name}@${m.authorName} (${m.authorId})${m.bot ? ' [bot]' : ''}`,
    `#${m.channelName} (${m.channelId})`,
    `msg ${m.id}`,
  ];
  if (m.replyTo) head.push(`reply to ${m.replyTo}`);
  if (m.mentionsBot) head.push('mentions the bot');
  const lines = [head.join(' · ')];
  if (m.content) lines.push(...m.content.split('\n').map((l) => `  ${l}`));
  if (m.attachments.length) lines.push(`  [attachments] ${m.attachments.join(', ')}`);
  if (m.embeds) lines.push(`  [${m.embeds} embed(s)]`);
  if (!m.content && !m.attachments.length && !m.embeds) lines.push('  (no text)');
  return lines.join('\n');
}

export const getNewMessages = defineTool({
  name: 'get_new_messages',
  pack: 'core',
  title: 'Get new messages',
  description:
    'Returns messages that arrived across the server (or a channel, category or forum) since your last call, ' +
    'oldest first, from what Guildora received live during this session. Pass the returned next_cursor next ' +
    'time to get only newer ones. only_mentions keeps messages that mention or reply to the bot. For older ' +
    'history use recent_activity or read_messages.',
  input: {
    guild: guildField,
    cursor: z
      .string()
      .optional()
      .describe('next_cursor from the previous call. Default: everything since startup.'),
    scope: z
      .string()
      .optional()
      .describe('Only this channel, thread, category or forum (ID or name).'),
    only_mentions: z
      .boolean()
      .optional()
      .describe('Only messages that mention or reply to the bot.'),
    include_bots: z
      .boolean()
      .optional()
      .describe('Include bot and webhook messages (default false).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max messages (1-200, default 50).'),
  },
  readOnly: true,
  async run(args, ctx) {
    const buffer = ctx.buffer;
    if (!buffer)
      throw new GuildoraError(
        'Live messages are not available in this mode; use recent_activity instead.',
      );
    const guild = await ctx.guild(args.guild);
    if (args.cursor !== undefined && !isSnowflake(args.cursor.trim())) {
      throw new GuildoraError(
        'Invalid cursor: pass the next_cursor value from the previous result.',
      );
    }
    const scopeId = args.scope ? (await channelArg(ctx, guild.id, args.scope)).id : undefined;
    const { messages, more } = buffer.query({
      guildId: guild.id,
      after: args.cursor?.trim(),
      scopeId,
      includeBots: args.include_bots === true,
      onlyMentions: args.only_mentions === true,
      limit: args.limit ?? 50,
    });

    const since = args.cursor
      ? `message ${args.cursor.trim()}`
      : `startup (${ts(buffer.startedAt)})`;
    const next = messages.at(-1)?.id ?? args.cursor?.trim() ?? snowflakeAt(new Date());
    const notes = [
      more
        ? `More new messages are waiting: call again with cursor "${next}".`
        : `That is everything so far. Call again later with cursor "${next}" to get only newer messages.`,
      `Live messages are kept since ${ts(buffer.coversSince)}; older ones: recent_activity or read_messages.`,
    ];
    if (!ctx.intents.messageContent) {
      notes.push(
        'Note: the Message Content intent is off, so message text from other users is empty.',
      );
    }
    return page(
      `${messages.length} new message(s) in ${guild.name} since ${since}${args.only_mentions ? ' that mention the bot' : ''}, oldest first:`,
      messages.map(fmtBuffered),
      next,
      notes.join('\n'),
    );
  },
});
