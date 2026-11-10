import { z } from 'zod';
import type {
  AnyThreadChannel,
  ForumChannel,
  GuildForumTagData,
  MediaChannel,
  NewsChannel,
  TextChannel,
} from 'discord.js';
import { ChannelFlags, ChannelType, ThreadAutoArchiveDuration } from '../../discord/api.js';
import { defineTool, type AnyTool } from '../types.js';
import {
  buildEmbeds,
  embedsField,
  filesField,
  guildChannelArg,
  guildField,
  loadFiles,
  reasonField,
  requireBotPermissions,
} from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { isUnicodeEmoji, pickByName, resolveGuildEmoji } from '../../discord/resolve.js';
import { isSnowflake, parseDate, parseDiscordLink, parseDuration } from '../../discord/parse.js';
import { fmtChannel, fmtMessage, fmtUser, page, ts } from '../../discord/format.js';
import { snowflakeTimestamp } from '../../discord/api.js';

type ThreadParent = TextChannel | NewsChannel | ForumChannel | MediaChannel;
type PostParent = ForumChannel | MediaChannel;

const PARENT_KINDS = ['text', 'announcement', 'forum', 'media'] as (
  'text' | 'announcement' | 'forum' | 'media'
)[];

const isPostParent = (c: ThreadParent): c is PostParent =>
  c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia;

const AUTO_ARCHIVE = {
  '1h': ThreadAutoArchiveDuration.OneHour,
  '24h': ThreadAutoArchiveDuration.OneDay,
  '3d': ThreadAutoArchiveDuration.ThreeDays,
  '1w': ThreadAutoArchiveDuration.OneWeek,
} as const;
const autoArchiveField = z
  .enum(Object.keys(AUTO_ARCHIVE) as [keyof typeof AUTO_ARCHIVE])
  .optional()
  .describe('Archive after this much inactivity.');

function tagNames(t: AnyThreadChannel): string[] {
  const parent = t.parent;
  if (!parent || !('availableTags' in parent)) return [];
  return t.appliedTags.map((id) => parent.availableTags.find((tag) => tag.id === id)?.name ?? id);
}

function threadLine(t: AnyThreadChannel): string {
  const state = [
    t.type === ChannelType.PrivateThread ? 'private' : '',
    t.archived ? 'archived' : 'active',
    t.locked ? 'locked' : '',
    t.flags.has(ChannelFlags.Pinned) ? 'pinned' : '',
  ].filter(Boolean);
  const tags = tagNames(t);
  return (
    `${fmtChannel(t)} in ${fmtChannel(t.parent)} · ${state.join(', ')} · ${t.messageCount ?? '?'} msgs` +
    `${tags.length ? ` · tags: ${tags.join(', ')}` : ''}` +
    ` · ${t.archived && t.archiveTimestamp ? `archived ${ts(t.archiveTimestamp)}` : `created ${ts(t.createdAt)}`}`
  );
}

/** Resolves forum tag names or IDs to tag IDs. */
function tagIds(forum: PostParent, inputs: string[]): string[] {
  return inputs.map((input) => {
    const byId = forum.availableTags.find((t) => t.id === input.trim());
    if (byId) return byId.id;
    return pickByName(
      forum.availableTags.map((t) => ({
        item: t.id,
        names: [t.name],
        label: `${t.name} (${t.id})`,
      })),
      input,
      'forum tag',
      `Tags in ${fmtChannel(forum)}: ${forum.availableTags.map((t) => t.name).join(', ') || 'none'}. Add tags with manage_forum_tags.`,
    );
  });
}

const listThreads = defineTool({
  name: 'list_threads',
  pack: 'threads',
  title: 'List threads and forum posts',
  description:
    'Lists threads or forum posts. With "channel": its active threads plus archived ones (public, and private ' +
    'with include_private), newest first, paged with next_cursor; no other call is needed first. Without ' +
    'channel: all active threads in the server. Thread IDs work as "channel" in read_messages/send_message.',
  input: {
    channel: z
      .string()
      .optional()
      .describe('Parent text, announcement, forum or media channel (ID or name).'),
    guild: guildField,
    state: z
      .enum(['active', 'archived', 'all'])
      .optional()
      .describe('Default "all" (needs channel for archived).'),
    include_private: z
      .boolean()
      .optional()
      .describe('Also list private archived threads (needs Manage Threads).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Max archived threads (1-100, default 50).'),
    cursor: z
      .string()
      .optional()
      .describe('next_cursor from a previous call (pages archived threads).'),
  },
  readOnly: true,
  async run(args, ctx) {
    const state = args.state ?? 'all';
    if (!args.channel) {
      if (state === 'archived') throw new GuildoraError('Pass "channel" to list archived threads.');
      const guild = await ctx.guild(args.guild);
      const { threads } = await guild.channels.fetchActiveThreads();
      return page(`${threads.size} active thread(s) in ${guild.name}:`, threads.map(threadLine));
    }
    const parent = (await guildChannelArg(ctx, args.guild, args.channel, {
      kinds: PARENT_KINDS,
      label: 'channel',
    })) as ThreadParent;
    const lines: string[] = [];
    const notes: string[] = [];
    let next: string | undefined;
    if (state !== 'archived' && !args.cursor) {
      const active = await parent.threads.fetchActive();
      const mine = active.threads.filter((t) => t.parentId === parent.id);
      lines.push(...mine.map(threadLine));
    }
    if (state !== 'active') {
      const limit = args.limit ?? 50;
      const before = args.cursor ? parseDate(args.cursor, 'cursor') : undefined;
      const pub = await parent.threads.fetchArchived({
        type: 'public',
        limit,
        ...(before ? { before } : {}),
      });
      const archived = [...pub.threads.values()];
      let hasMore = pub.hasMore;
      if (args.include_private) {
        if (isPostParent(parent)) notes.push('Forum and media channels have no private threads.');
        else {
          try {
            const priv = await parent.threads.fetchArchived({
              type: 'private',
              limit,
              ...(before ? { before } : {}),
            });
            archived.push(...priv.threads.values());
            hasMore ||= priv.hasMore;
          } catch {
            notes.push('Private archived threads were skipped: the bot needs Manage Threads here.');
          }
        }
      }
      archived.sort((a, b) => (b.archiveTimestamp ?? 0) - (a.archiveTimestamp ?? 0));
      const pageItems = archived.slice(0, limit);
      lines.push(...pageItems.map(threadLine));
      const last = pageItems.at(-1);
      if ((hasMore || archived.length > limit) && last?.archiveTimestamp)
        next = new Date(last.archiveTimestamp).toISOString();
    }
    return page(
      `${lines.length} thread(s) in ${fmtChannel(parent)}:`,
      lines,
      next,
      notes.join('\n') || undefined,
    );
  },
});

const createThread = defineTool({
  name: 'create_thread',
  pack: 'threads',
  title: 'Create a thread or forum post',
  description:
    'Starts a thread in a text/announcement channel (from an existing message, or standalone; private: true for ' +
    'an invite-only thread), or creates a forum/media post with a first message, tags, embeds and files. ' +
    'Returns the thread ID; reply with send_message using it as channel.',
  input: {
    channel: z
      .string()
      .describe('Text, announcement, forum or media channel (ID, mention, link or name).'),
    name: z.string().min(1).max(100).describe('Thread or post title.'),
    guild: guildField,
    message: z
      .string()
      .optional()
      .describe('Text channels: start the thread from this message (ID or link).'),
    content: z
      .string()
      .max(2000)
      .optional()
      .describe('Forum posts: the first message (required for forums unless embeds/files).'),
    embeds: embedsField,
    files: filesField,
    tags: z.array(z.string()).max(5).optional().describe('Forum posts: tag names or IDs.'),
    private: z.boolean().optional().describe('Text channels: create a private thread.'),
    auto_archive: autoArchiveField,
    slowmode: z.string().optional().describe('Slowmode, e.g. "30s" (max "6h").'),
    reason: reasonField,
  },
  readOnly: false,
  permissions: ['Create Public/Private Threads or Send Messages (forums)'],
  async run(args, ctx) {
    const parent = (await guildChannelArg(ctx, args.guild, args.channel, {
      kinds: PARENT_KINDS,
      label: 'channel',
    })) as ThreadParent;
    const slow =
      args.slowmode !== undefined
        ? Math.round(parseDuration(args.slowmode, 'slowmode') / 1000)
        : undefined;
    const common = {
      name: args.name,
      ...(args.auto_archive ? { autoArchiveDuration: AUTO_ARCHIVE[args.auto_archive] } : {}),
      ...(slow !== undefined ? { rateLimitPerUser: slow } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    };
    if (isPostParent(parent)) {
      if (args.message || args.private)
        throw new GuildoraError('"message" and "private" only apply to text channels.');
      if (!args.content && !args.embeds?.length && !args.files?.length) {
        throw new GuildoraError(
          'A forum post needs a first message: pass content, embeds or files.',
        );
      }
      const files = await loadFiles(ctx, args.files, parent.guild);
      const embeds = buildEmbeds(args.embeds);
      const post = await parent.threads.create({
        ...common,
        message: {
          ...(args.content ? { content: args.content } : {}),
          ...(embeds ? { embeds } : {}),
          ...(files ? { files } : {}),
        },
        ...(args.tags?.length ? { appliedTags: tagIds(parent, args.tags) } : {}),
      });
      return `Created forum post ${fmtChannel(post)} in ${fmtChannel(parent)}: ${post.url}`;
    }
    if (args.tags?.length || args.content || args.embeds?.length || args.files?.length) {
      throw new GuildoraError(
        'tags, content, embeds and files apply to forum posts. For text threads, create it and then use send_message.',
      );
    }
    if (args.message) {
      if (args.private)
        throw new GuildoraError('Threads started from a message are always public.');
      const id = parseDiscordLink(args.message)?.messageId ?? args.message.trim();
      if (!isSnowflake(id)) throw new GuildoraError('"message" must be a message ID or link.');
      const msg = await parent.messages.fetch(id);
      const thread = await msg.startThread(common);
      return `Started thread ${fmtChannel(thread)} from message ${msg.id} in ${fmtChannel(parent)}.`;
    }
    if (args.private && parent.type !== ChannelType.GuildText) {
      throw new GuildoraError('Private threads are only possible in text channels.');
    }
    requireBotPermissions(
      parent.guild,
      [args.private ? 'CreatePrivateThreads' : 'CreatePublicThreads'],
      parent,
    );
    const thread = await (parent as TextChannel).threads.create({
      ...common,
      type: args.private ? ChannelType.PrivateThread : ChannelType.PublicThread,
    });
    return `Created ${args.private ? 'private ' : ''}thread ${fmtChannel(thread)} in ${fmtChannel(parent)}.`;
  },
});

const editThread = defineTool({
  name: 'edit_thread',
  pack: 'threads',
  title: 'Edit a thread or forum post',
  description:
    'Renames, archives/unarchives, locks/unlocks, pins (forum posts), sets tags, slowmode or auto-archive of a ' +
    'thread or forum post, including archived ones (by ID or link). To change an archived thread, include ' +
    'archived: false.',
  input: {
    thread: z.string().describe('Thread or forum post: ID, <#mention> or link.'),
    guild: guildField,
    name: z.string().min(1).max(100).optional(),
    archived: z.boolean().optional(),
    locked: z.boolean().optional().describe('Only moderators can reply when locked.'),
    pinned: z.boolean().optional().describe('Forum posts: pin to the top of the forum.'),
    tags: z
      .array(z.string())
      .max(5)
      .optional()
      .describe('Forum posts: replace tags (names or IDs); [] clears.'),
    auto_archive: autoArchiveField,
    slowmode: z.string().optional(),
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Manage Threads (or be the thread owner for name/archive)'],
  async run(args, ctx) {
    const thread = (await guildChannelArg(ctx, args.guild, args.thread, {
      kinds: ['thread'],
      label: 'thread',
    })) as AnyThreadChannel;
    const edit: Record<string, unknown> = {};
    if (args.name) edit.name = args.name;
    if (args.archived !== undefined) edit.archived = args.archived;
    if (args.locked !== undefined) edit.locked = args.locked;
    if (args.auto_archive) edit.autoArchiveDuration = AUTO_ARCHIVE[args.auto_archive];
    if (args.slowmode !== undefined)
      edit.rateLimitPerUser = Math.round(parseDuration(args.slowmode, 'slowmode') / 1000);
    if (args.tags) {
      const parent = thread.parent;
      if (!parent || !('availableTags' in parent))
        throw new GuildoraError('Tags only exist on forum and media posts.');
      edit.appliedTags = tagIds(parent as PostParent, args.tags);
    }
    if (args.reason) edit.reason = args.reason;
    const changes = Object.keys(edit).filter((k) => k !== 'reason');
    if (!changes.length && args.pinned === undefined) throw new GuildoraError('Nothing to change.');
    if (
      thread.archived &&
      args.archived === undefined &&
      (changes.length || args.pinned !== undefined)
    ) {
      throw new GuildoraError(
        `${fmtChannel(thread)} is archived. Add archived: false to change it.`,
      );
    }
    // Unarchive first so other changes (and pinning) are accepted, then apply the rest.
    let current = thread;
    if (changes.length) current = await thread.edit(edit);
    if (args.pinned !== undefined) {
      if (!current.parent || !('availableTags' in current.parent))
        throw new GuildoraError('Only forum and media posts can be pinned.');
      current = args.pinned ? await current.pin(args.reason) : await current.unpin(args.reason);
    }
    return `Updated ${threadLine(current)}`;
  },
});

const tagInput = z.object({
  name: z.string().min(1).max(20),
  emoji: z.string().optional().describe('Unicode emoji or a server emoji.'),
  moderated: z.boolean().optional().describe('Only moderators can apply it.'),
});

const manageForumTags = defineTool({
  name: 'manage_forum_tags',
  pack: 'threads',
  title: 'Manage forum tags',
  description:
    'Adds, updates or removes the tags available in a forum or media channel (max 20). Removing a tag also ' +
    'removes it from posts that use it. Returns the resulting tag list.',
  input: {
    forum: z.string().describe('Forum or media channel (ID, mention, link or name).'),
    guild: guildField,
    add: z
      .array(tagInput)
      .optional()
      .describe('Tags to add, or to update if the name already exists.'),
    remove: z.array(z.string()).optional().describe('Tag names or IDs to remove.'),
    reason: reasonField,
  },
  readOnly: false,
  permissions: ['Manage Channels'],
  async run(args, ctx) {
    const forum = (await guildChannelArg(ctx, args.guild, args.forum, {
      kinds: ['forum', 'media'],
      label: 'forum',
    })) as PostParent;
    requireBotPermissions(forum.guild, ['ManageChannels'], forum);
    if (!args.add?.length && !args.remove?.length)
      throw new GuildoraError('Pass add and/or remove.');
    const removeIds = new Set(args.remove?.length ? tagIds(forum, args.remove) : []);
    const tags: GuildForumTagData[] = forum.availableTags
      .filter((t) => !removeIds.has(t.id))
      .map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji }));
    for (const a of args.add ?? []) {
      let emoji: GuildForumTagData['emoji'] = null;
      if (a.emoji) {
        emoji = isUnicodeEmoji(a.emoji)
          ? { id: null, name: a.emoji }
          : { id: resolveGuildEmoji(forum.guild, a.emoji).id, name: null };
      }
      const existing = tags.find((t) => t.name.toLowerCase() === a.name.toLowerCase());
      if (existing) {
        if (a.moderated !== undefined) existing.moderated = a.moderated;
        if (a.emoji) existing.emoji = emoji;
      } else {
        tags.push({ name: a.name, moderated: a.moderated ?? false, emoji });
      }
    }
    if (tags.length > 20)
      throw new GuildoraError(`A forum can have at most 20 tags (this would make ${tags.length}).`);
    const updated = await forum.setAvailableTags(tags, args.reason);
    return `Tags in ${fmtChannel(updated)}: ${updated.availableTags.map((t) => `${t.name} (${t.id})${t.moderated ? ' [mod only]' : ''}`).join(', ') || 'none'}.`;
  },
});

const readForum = defineTool({
  name: 'read_forum',
  pack: 'threads',
  title: 'Read a forum',
  description:
    'Reads a forum or media channel in one call: each post with its title, tags, author, message count, last ' +
    'activity and opening message, optionally the latest replies. Covers active and archived posts; filter by ' +
    'tag. Use it to review bug reports or questions; read_messages on a post ID gives the full conversation.',
  input: {
    forum: z.string().describe('Forum or media channel (ID, mention, link or name).'),
    guild: guildField,
    state: z.enum(['active', 'archived', 'all']).optional().describe('Default "all".'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Only posts with any of these tags (names or IDs).'),
    replies: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('Latest replies per post (0-10, default 0).'),
    max_chars: z
      .number()
      .int()
      .min(100)
      .max(4000)
      .optional()
      .describe('Max characters per message (default 600).'),
    limit: z.number().int().min(1).max(25).optional().describe('Max posts (1-25, default 10).'),
    cursor: z
      .string()
      .optional()
      .describe('next_cursor from a previous call (continues with older archived posts).'),
  },
  readOnly: true,
  async run(args, ctx) {
    const forum = (await guildChannelArg(ctx, args.guild, args.forum, {
      kinds: ['forum', 'media'],
      label: 'forum',
    })) as PostParent;
    const state = args.state ?? 'all';
    const limit = args.limit ?? 10;
    const wanted = args.tags?.length ? new Set(tagIds(forum, args.tags)) : undefined;
    const hasTag = (t: AnyThreadChannel) => !wanted || t.appliedTags.some((id) => wanted.has(id));
    const lastAt = (t: AnyThreadChannel) =>
      t.lastMessageId ? snowflakeTimestamp(t.lastMessageId) : (t.createdTimestamp ?? 0);

    const posts: AnyThreadChannel[] = [];
    if (state !== 'archived' && !args.cursor) {
      const active = await forum.threads.fetchActive();
      posts.push(
        ...[...active.threads.values()]
          .filter((t) => t.parentId === forum.id && hasTag(t))
          .sort((a, b) => lastAt(b) - lastAt(a)),
      );
    }
    let next: string | undefined;
    if (state !== 'active' && posts.length < limit) {
      const before = args.cursor ? parseDate(args.cursor, 'cursor') : undefined;
      const archived = await forum.threads.fetchArchived({
        type: 'public',
        limit: 50,
        ...(before ? { before } : {}),
      });
      const list = [...archived.threads.values()].sort(
        (a, b) => (b.archiveTimestamp ?? 0) - (a.archiveTimestamp ?? 0),
      );
      const room = limit - posts.length;
      const matching = list.filter(hasTag);
      posts.push(...matching.slice(0, room));
      const lastTaken = matching.slice(0, room).at(-1) ?? list.at(-1);
      if ((archived.hasMore || matching.length > room) && lastTaken?.archiveTimestamp) {
        next = new Date(lastTaken.archiveTimestamp).toISOString();
      }
    }
    const shown = posts.slice(0, limit);
    const maxContent = args.max_chars ?? 600;
    const blocks = [];
    for (const t of shown) {
      const tags = tagNames(t);
      const head =
        `## ${fmtChannel(t)} · ${t.archived ? 'archived' : 'active'}${t.locked ? ', locked' : ''}` +
        `${tags.length ? ` · tags: ${tags.join(', ')}` : ''} · ${t.messageCount ?? '?'} msgs` +
        ` · by ${t.ownerId ? fmtUser((await t.fetchOwner().catch(() => null))?.user ?? { id: t.ownerId, username: null, bot: false }) : 'unknown'}` +
        ` · created ${ts(t.createdAt)} · last activity ${ts(lastAt(t))}`;
      const lines = [head];
      const starter = await t.fetchStarterMessage().catch(() => null);
      lines.push(starter ? fmtMessage(starter, { maxContent }) : '(opening message deleted)');
      if (args.replies) {
        const recent = [...(await t.messages.fetch({ limit: args.replies + 1 })).values()]
          .filter((m) => m.id !== t.id)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .slice(-args.replies);
        if (recent.length)
          lines.push(
            `Latest ${recent.length} repl${recent.length === 1 ? 'y' : 'ies'}:`,
            ...recent.map((m) => fmtMessage(m, { maxContent })),
          );
      }
      blocks.push(lines.join('\n'));
    }
    return page(
      `${shown.length} post(s) in ${fmtChannel(forum)}${wanted ? ' with the requested tags' : ''}:`,
      blocks,
      next,
    );
  },
});

export const threadTools: AnyTool[] = [
  listThreads,
  readForum,
  createThread,
  editThread,
  manageForumTags,
];
