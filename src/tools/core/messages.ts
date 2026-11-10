import { z } from 'zod';
import type { Message, MessageCreateOptions } from 'discord.js';
import { MessageFlags, MessageType } from '../../discord/api.js';
import { defineTool } from '../types.js';
import {
  buildEmbeds,
  cursorSnowflake,
  embedsField,
  filesField,
  guildOf,
  loadFiles,
  messageArg,
  messageChannelArg,
  messageField,
  messageTargetFields,
  sendable,
} from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { isSnowflake, parseDate, parseDiscordLink } from '../../discord/parse.js';
import { resolveMember, resolveReactionEmoji } from '../../discord/resolve.js';
import { fmtChannel, fmtMessage, fmtUser, page, truncate } from '../../discord/format.js';
import type { ToolContext } from '../types.js';

const MAX_CONTENT = 2000;

function contentNote(ctx: ToolContext, messages: Message[]): string | undefined {
  if (ctx.intents.messageContent) return undefined;
  const blank = messages.some((m) => !m.content && m.author.id !== ctx.client.user.id);
  return blank
    ? "Note: the Message Content intent is off, so other users' message text, embeds and attachments are empty. Enable it under Developer Portal > Bot > Message Content Intent."
    : undefined;
}

export const readMessages = defineTool({
  name: 'read_messages',
  pack: 'core',
  title: 'Read messages',
  description:
    'Reads recent messages from a channel, thread, forum post or DM, shown oldest first with IDs, authors, ' +
    'replies, attachments, embeds and reactions. Page with before/after/around (message ID or ISO date). ' +
    'pinned: true lists pinned messages instead. To find messages by text or author, use search_messages.',
  input: {
    ...messageTargetFields,
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('How many messages (1-100, default 25).'),
    before: z.string().optional().describe('Only messages before this message ID or ISO date.'),
    after: z.string().optional().describe('Only messages after this message ID or ISO date.'),
    around: z.string().optional().describe('Messages around this message ID.'),
    pinned: z.boolean().optional().describe('List pinned messages instead of history.'),
  },
  readOnly: true,
  async run(args, ctx) {
    const cursors = [args.before, args.after, args.around].filter(Boolean);
    if (cursors.length > 1) throw new GuildoraError('Use only one of before, after or around.');
    const channel = await messageChannelArg(ctx, args);
    const limit = args.limit ?? 25;

    let messages: Message[];
    let more: string | undefined;
    if (args.pinned) {
      // Pins page by pin time; a message ID or date both work as the "before" bound.
      const before = args.before ? parseDate(args.before, 'before') : undefined;
      const res = await channel.messages.fetchPins({
        limit: Math.min(limit, 50),
        ...(before ? { before } : {}),
      });
      messages = res.items.map((p) => p.message);
      if (res.hasMore && res.items.length)
        more = `before=${res.items.at(-1)!.pinnedAt.toISOString()}`;
    } else {
      const options: { limit: number; before?: string; after?: string; around?: string } = {
        limit,
      };
      const before = cursorSnowflake(args.before, 'before');
      const after = cursorSnowflake(args.after, 'after');
      if (before) options.before = before;
      if (after) options.after = after;
      if (args.around) {
        if (!isSnowflake(args.around.trim()) && !parseDiscordLink(args.around)) {
          throw new GuildoraError('"around" must be a message ID or link.');
        }
        options.around = cursorSnowflake(args.around, 'around')!;
      }
      const fetched = await channel.messages.fetch(options);
      messages = [...fetched.values()];
    }
    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const footer: string[] = [];
    if (messages.length && !args.pinned) {
      footer.push(`Older: before=${messages[0]!.id} · Newer: after=${messages.at(-1)!.id}`);
    }
    if (more) footer.push(`More pins: ${more}`);
    const note = contentNote(ctx, messages);
    if (note) footer.push(note);
    return page(
      `${messages.length} ${args.pinned ? 'pinned ' : ''}message(s) in ${fmtChannel(channel)}, oldest first:`,
      messages.map((m) => fmtMessage(m)),
      undefined,
      footer.join('\n') || undefined,
    );
  },
});

export const getMessage = defineTool({
  name: 'get_message',
  pack: 'core',
  title: 'Get one message',
  description:
    'Fetches one message by ID or link, with attachments (IDs, sizes, URLs), embeds, reactions and the message ' +
    'it replies to. include_replies: true also scans later messages for replies to it and says how many it scanned.',
  input: {
    message: messageField,
    ...messageTargetFields,
    include_replies: z
      .boolean()
      .optional()
      .describe('Also find replies to this message (scans newer messages).'),
    scan_limit: z
      .number()
      .int()
      .min(100)
      .max(10000)
      .optional()
      .describe('Max newer messages to scan for replies (default 500).'),
  },
  readOnly: true,
  async run(args, ctx) {
    const m = await messageArg(ctx, args);
    const lines = [fmtMessage(m), `Link: ${m.url}`];
    if (m.type === MessageType.Reply && m.reference?.messageId) {
      const ref = await m.fetchReference().catch(() => undefined);
      lines.push(
        ref
          ? `Replying to:\n${fmtMessage(ref, { maxContent: 500 })}`
          : `Replying to ${m.reference.messageId} (deleted or not visible)`,
      );
    }
    if (args.include_replies) {
      const max = Math.min(args.scan_limit ?? 500, ctx.config.scanLimit);
      let after = m.id;
      let scanned = 0;
      let reachedLatest = false;
      const replies: Message[] = [];
      while (scanned < max) {
        const batch = await m.channel.messages.fetch({
          after,
          limit: Math.min(100, max - scanned),
        });
        if (batch.size === 0) {
          reachedLatest = true;
          break;
        }
        const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const r of sorted) {
          if (r.type === MessageType.Reply && r.reference?.messageId === m.id) replies.push(r);
        }
        scanned += batch.size;
        after = sorted.at(-1)!.id;
        if (batch.size < 100) {
          reachedLatest = true;
          break;
        }
      }
      lines.push(
        `Replies: ${replies.length} found in ${scanned} newer message(s) scanned` +
          `${reachedLatest ? ' (reached the latest message)' : ` (stopped at the scan limit; continue with read_messages after=${after})`}.`,
      );
      lines.push(...replies.map((r) => fmtMessage(r, { maxContent: 500 })));
    }
    const note = contentNote(ctx, [m]);
    if (note) lines.push(note);
    return lines.join('\n');
  },
});

export const sendMessage = defineTool({
  name: 'send_message',
  pack: 'core',
  title: 'Send a message',
  description:
    'Sends a message to a channel, thread, forum post or a user\'s DMs (pass "user"). Supports replies, up to ' +
    '10 embeds and 10 file attachments (local path in stdio mode, https URL, or base64). Content max 2000 ' +
    'characters. @everyone/@here only ping if mention_everyone is true. Returns the new message ID and link. ' +
    'To start a new forum post, use create_thread.',
  input: {
    ...messageTargetFields,
    content: z
      .string()
      .optional()
      .describe('Message text (Discord markdown, max 2000 characters).'),
    reply_to: z.string().optional().describe('Message ID or link to reply to (same channel).'),
    embeds: embedsField,
    files: filesField,
    mention_everyone: z
      .boolean()
      .optional()
      .describe('Allow @everyone/@here to ping (default false).'),
    silent: z.boolean().optional().describe('Send without push notifications.'),
  },
  readOnly: false,
  permissions: ['View Channel', 'Send Messages', 'Embed Links / Attach Files when used'],
  async run(args, ctx) {
    if (!args.content && !args.embeds?.length && !args.files?.length) {
      throw new GuildoraError('Provide content, embeds or files.');
    }
    if (args.content && args.content.length > MAX_CONTENT) {
      throw new GuildoraError(
        `Content is ${args.content.length} characters; Discord allows ${MAX_CONTENT}. Split it into several messages.`,
      );
    }
    const channel = sendable(await messageChannelArg(ctx, args));
    const files = await loadFiles(ctx, args.files, guildOf(channel));
    const options: MessageCreateOptions = {
      allowedMentions: {
        parse: args.mention_everyone ? ['users', 'roles', 'everyone'] : ['users', 'roles'],
        repliedUser: true,
      },
    };
    if (args.content) options.content = args.content;
    const embeds = buildEmbeds(args.embeds);
    if (embeds) options.embeds = embeds;
    if (files) options.files = files;
    if (args.silent) options.flags = MessageFlags.SuppressNotifications;
    if (args.reply_to) {
      const replyId = parseDiscordLink(args.reply_to)?.messageId ?? args.reply_to.trim();
      if (!isSnowflake(replyId)) throw new GuildoraError('reply_to must be a message ID or link.');
      options.reply = { messageReference: replyId, failIfNotExists: true };
    }
    const sent = await channel.send(options);
    return `Sent message ${sent.id} in ${fmtChannel(channel)}: ${sent.url}`;
  },
});

export const editMessage = defineTool({
  name: 'edit_message',
  pack: 'core',
  title: 'Edit a message',
  description:
    'Edits a message the bot sent (content and/or embeds). suppress_embeds hides link previews on any message ' +
    "(needs Manage Messages for others' messages). Bots cannot change other users' text.",
  input: {
    message: messageField,
    ...messageTargetFields,
    content: z
      .string()
      .max(MAX_CONTENT)
      .optional()
      .describe('New text. Pass "" to remove the text.'),
    embeds: embedsField,
    suppress_embeds: z.boolean().optional().describe('Hide (true) or show (false) link embeds.'),
  },
  readOnly: false,
  idempotent: true,
  permissions: ["Manage Messages (only for suppress_embeds on others' messages)"],
  async run(args, ctx) {
    const m = await messageArg(ctx, args);
    const changesBody = args.content !== undefined || args.embeds !== undefined;
    if (!changesBody && args.suppress_embeds === undefined) {
      throw new GuildoraError('Nothing to change: pass content, embeds or suppress_embeds.');
    }
    if (changesBody && m.author.id !== ctx.client.user.id) {
      throw new GuildoraError(
        `Message ${m.id} was sent by ${fmtUser(m.author)}; bots can only edit their own messages.`,
      );
    }
    if (changesBody) {
      const embeds = buildEmbeds(args.embeds);
      await m.edit({
        ...(args.content !== undefined ? { content: args.content } : {}),
        ...(embeds ? { embeds } : {}),
      });
    }
    if (args.suppress_embeds !== undefined) await m.suppressEmbeds(args.suppress_embeds);
    return `Edited message ${m.id} in ${fmtChannel(m.channel)}: ${m.url}`;
  },
});

export const deleteMessage = defineTool({
  name: 'delete_message',
  pack: 'core',
  title: 'Delete a message',
  description:
    "Deletes one message (the bot's own, or anyone's with Manage Messages). Destructive: returns a dry run " +
    'unless confirm is true. For many messages use bulk_delete_messages (moderation pack).',
  input: { message: messageField, ...messageTargetFields, reason: z.string().max(512).optional() },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Messages (for messages by others)'],
  async prepare(args, ctx) {
    const m = await messageArg(ctx, args);
    const preview = m.content ? `: "${truncate(m.content.replace(/\n/g, ' '), 80)}"` : '';
    return {
      summary: `delete message ${m.id} by ${fmtUser(m.author)} in ${fmtChannel(m.channel)}${preview}`,
      async execute() {
        await m.delete();
        return `Deleted message ${m.id} from ${fmtChannel(m.channel)}.`;
      },
    };
  },
});

const reactionInput = {
  message: messageField,
  ...messageTargetFields,
  emoji: z
    .string()
    .describe('Unicode emoji ("👍") or a server emoji ("<:name:id>", ":name:", name or ID).'),
};

export const addReaction = defineTool({
  name: 'add_reaction',
  pack: 'core',
  title: 'Add a reaction',
  description: 'Reacts to a message with a Unicode or custom server emoji.',
  input: reactionInput,
  readOnly: false,
  idempotent: true,
  permissions: ['Add Reactions', 'Read Message History'],
  async run(args, ctx) {
    const m = await messageArg(ctx, args);
    const emoji = resolveReactionEmoji(m.guild ?? undefined, args.emoji);
    await m.react(emoji);
    return `Reacted ${args.emoji} to message ${m.id} in ${fmtChannel(m.channel)}.`;
  },
});

export const removeReaction = defineTool({
  name: 'remove_reaction',
  pack: 'core',
  title: 'Remove a reaction',
  description:
    "Removes a reaction from a message: the bot's own by default, or another member's (needs Manage Messages).",
  input: {
    ...reactionInput,
    member: z
      .string()
      .optional()
      .describe('Whose reaction to remove (ID, mention or name). Default: the bot.'),
  },
  readOnly: false,
  idempotent: true,
  permissions: ["Manage Messages (for other members' reactions)"],
  async run(args, ctx) {
    const m = await messageArg(ctx, args);
    const emoji = resolveReactionEmoji(m.guild ?? undefined, args.emoji);
    const key = emoji.includes(':') ? emoji.split(':').at(-1)! : emoji;
    const reaction = m.reactions.resolve(key);
    if (!reaction) return `Message ${m.id} has no ${args.emoji} reaction.`;
    let userId = ctx.client.user.id;
    if (args.member) {
      if (!m.guild) throw new GuildoraError('"member" only works in server channels.');
      userId = (await resolveMember(m.guild, args.member)).id;
    }
    await reaction.users.remove(userId);
    return `Removed ${args.emoji} reaction by ${userId === ctx.client.user.id ? 'the bot' : userId} from message ${m.id}.`;
  },
});

export const pinMessage = defineTool({
  name: 'pin_message',
  pack: 'core',
  title: 'Pin or unpin a message',
  description:
    'Pins a message (pinned: true, default) or unpins it (pinned: false). Max 50 pins per channel.',
  input: {
    message: messageField,
    ...messageTargetFields,
    pinned: z.boolean().optional().describe('true to pin (default), false to unpin.'),
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Pin Messages'],
  async run(args, ctx) {
    const m = await messageArg(ctx, args);
    const pin = args.pinned ?? true;
    if (pin) await m.pin();
    else await m.unpin();
    return `${pin ? 'Pinned' : 'Unpinned'} message ${m.id} in ${fmtChannel(m.channel)}.`;
  },
});
