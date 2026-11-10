import { z } from 'zod';
import type { Guild, GuildBasedChannel } from 'discord.js';
import { ChannelType, PermissionFlagsBits } from '../../discord/api.js';
import { defineTool } from '../types.js';
import { channelArg, cursorField, guildField, limitField } from '../shared.js';
import { formatColor, parseOffsetCursor, permissionNames } from '../../discord/parse.js';
import { CHANNEL_KINDS, channelKind, type ChannelKind } from '../../discord/resolve.js';
import {
  fmtChannel,
  fmtMember,
  fmtRole,
  fmtUser,
  page,
  slicePage,
  ts,
  truncate,
} from '../../discord/format.js';

const KIND_VALUES = Object.keys(CHANNEL_KINDS) as [ChannelKind, ...ChannelKind[]];

export const getServerInfo = defineTool({
  name: 'get_server_info',
  pack: 'core',
  title: 'Get server info',
  description:
    "Overview of a Discord server: owner, member count, boost tier, channel/role/emoji counts, the bot's " +
    'permissions and which privileged intents are on. Call this first to orient yourself. If the bot is in ' +
    'several servers and none is the default, the error lists them.',
  input: { guild: guildField },
  readOnly: true,
  async run({ guild: guildInput }, ctx) {
    const guild = await ctx.guild(guildInput);
    const owner = await guild.fetchOwner().catch(() => undefined);
    const counts = new Map<string, number>();
    for (const c of guild.channels.cache.values()) {
      const k = channelKind(c.type);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const me = guild.members.me;
    const lines = [
      `Server: ${guild.name} (${guild.id})`,
      `Owner: ${owner ? fmtMember(owner) : guild.ownerId}`,
      `Created: ${ts(guild.createdAt)}`,
      `Members: ${guild.memberCount}`,
      `Boost: tier ${guild.premiumTier}, ${guild.premiumSubscriptionCount ?? 0} boosts`,
      `Channels: ${[...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`,
      `Roles: ${guild.roles.cache.size} · Emoji: ${guild.emojis.cache.size} · Stickers: ${guild.stickers.cache.size}`,
    ];
    if (guild.description) lines.push(`Description: ${truncate(guild.description, 300)}`);
    if (guild.features.length) lines.push(`Features: ${guild.features.join(', ')}`);
    if (me) {
      lines.push(`Bot: ${fmtUser(me.user)}, highest role ${fmtRole(me.roles.highest)}`);
      lines.push(
        `Bot permissions: ${permissionNames(me.permissions.bitfield).join(', ') || 'none'}`,
      );
    }
    lines.push(
      `Intents: Message Content ${ctx.intents.messageContent ? 'on' : 'OFF (message text will be empty)'}, ` +
        `Server Members ${ctx.intents.members ? 'on' : 'OFF (list_members needs a query)'}`,
    );
    const others = [...ctx.client.guilds.cache.values()].filter((g) => g.id !== guild.id);
    if (others.length) {
      lines.push(
        `Other servers: ${others
          .slice(0, 20)
          .map((g) => `${g.name} (${g.id})`)
          .join(', ')}`,
      );
    }
    return lines.join('\n');
  },
});

const VOICE_LIKE = new Set<ChannelType>([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/** Orders channels the way the Discord sidebar does: uncategorised first, then by category. */
export function sidebarOrder(channels: GuildBasedChannel[]): GuildBasedChannel[] {
  const pos = (c: GuildBasedChannel) => ('rawPosition' in c ? c.rawPosition : 0);
  const byPos = (a: GuildBasedChannel, b: GuildBasedChannel) =>
    Number(VOICE_LIKE.has(a.type)) - Number(VOICE_LIKE.has(b.type)) ||
    pos(a) - pos(b) ||
    a.id.localeCompare(b.id);
  const top = channels.filter(
    (c) => !c.isThread() && c.type !== ChannelType.GuildCategory && !c.parentId,
  );
  const cats = channels
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => pos(a) - pos(b));
  const out = [...top.sort(byPos)];
  for (const cat of cats) {
    out.push(cat);
    out.push(...channels.filter((c) => !c.isThread() && c.parentId === cat.id).sort(byPos));
  }
  // Threads go after everything, grouped by parent.
  out.push(
    ...channels
      .filter((c) => c.isThread())
      .sort((a, b) => (a.parentId ?? '').localeCompare(b.parentId ?? '')),
  );
  // Anything left (orphans whose category is missing).
  for (const c of channels) if (!out.includes(c)) out.push(c);
  return out;
}

function channelLine(c: GuildBasedChannel, indent: boolean): string {
  const kind = channelKind(c.type);
  const extra: string[] = [];
  if (c.isThread()) {
    extra.push(`in ${fmtChannel(c.parent)}`);
    if (c.archived) extra.push('archived');
  }
  if ('nsfw' in c && c.nsfw) extra.push('nsfw');
  const body = `${fmtChannel(c)} [${kind}]${extra.length ? ` ${extra.join(', ')}` : ''}`;
  return indent && c.parentId && !c.isThread() ? `  ${body}` : body;
}

export const listChannels = defineTool({
  name: 'list_channels',
  pack: 'core',
  title: 'List channels',
  description:
    'Lists server channels in sidebar order (categories with their channels), with IDs and types. Filter by ' +
    'type, category or a name fragment; type "thread" lists active threads (archived ones: list_threads). ' +
    'Use get_channel for details of one channel.',
  input: {
    guild: guildField,
    type: z.enum(KIND_VALUES).optional().describe('Only this channel type.'),
    category: z.string().optional().describe('Only channels in this category (ID or name).'),
    query: z.string().optional().describe('Only channels whose name contains this text.'),
    limit: limitField(100, 200),
    cursor: cursorField,
  },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    let channels = [...guild.channels.cache.values()];
    if (args.type) channels = channels.filter((c) => CHANNEL_KINDS[args.type!].includes(c.type));
    else channels = channels.filter((c) => !c.isThread());
    if (args.category) {
      const cat = await channelArg(ctx, guild.id, args.category, {
        kinds: ['category'],
        label: 'category',
      });
      channels = channels.filter((c) => c.parentId === cat.id);
    }
    if (args.query) {
      const q = args.query.toLowerCase().replace(/^#/, '');
      channels = channels.filter((c) => c.name.toLowerCase().includes(q));
    }
    const ordered = sidebarOrder(channels);
    const { items, next } = slicePage(ordered, parseOffsetCursor(args.cursor), args.limit ?? 100);
    const indent = !args.type && !args.category && !args.query;
    return page(
      `${ordered.length} channel(s) in ${guild.name}${next ? `, showing ${items.length}` : ''}:`,
      items.map((c) => channelLine(c, indent)),
      next,
    );
  },
});

const KEY_CHANNEL_PERMS = [
  'ViewChannel',
  'SendMessages',
  'SendMessagesInThreads',
  'ReadMessageHistory',
  'EmbedLinks',
  'AttachFiles',
  'AddReactions',
  'ManageMessages',
  'PinMessages',
  'ManageThreads',
  'CreatePublicThreads',
  'ManageChannels',
  'ManageWebhooks',
  'Connect',
  'Speak',
  'MoveMembers',
] as const;

function describeChannel(c: GuildBasedChannel, guild: Guild): string[] {
  const lines = [`${fmtChannel(c)} [${channelKind(c.type)}]`, `Created: ${ts(c.createdAt)}`];
  if (c.parent && !c.isThread()) lines.push(`Category: ${fmtChannel(c.parent)}`);
  if ('rawPosition' in c) lines.push(`Position: ${c.rawPosition}`);
  if ('topic' in c && c.topic) lines.push(`Topic: ${truncate(c.topic, 500)}`);
  if ('nsfw' in c) lines.push(`NSFW: ${c.nsfw ? 'yes' : 'no'}`);
  if ('rateLimitPerUser' in c && c.rateLimitPerUser) lines.push(`Slowmode: ${c.rateLimitPerUser}s`);
  if (c.isVoiceBased()) {
    lines.push(
      `Bitrate: ${c.bitrate} · User limit: ${c.userLimit || 'none'} · Region: ${c.rtcRegion ?? 'automatic'}`,
    );
    const inVoice = [...c.members.values()];
    lines.push(`Connected: ${inVoice.length ? inVoice.map(fmtMember).join(', ') : 'nobody'}`);
  }
  if (c.isThread()) {
    lines.push(`Parent: ${fmtChannel(c.parent)}`);
    lines.push(`Owner: ${c.ownerId ?? 'unknown'}`);
    lines.push(
      `Archived: ${c.archived ? 'yes' : 'no'} · Locked: ${c.locked ? 'yes' : 'no'} · Auto-archive: ${c.autoArchiveDuration ?? '?'} min`,
    );
    lines.push(`Messages: ${c.messageCount ?? '?'} · Members: ${c.memberCount ?? '?'}`);
    if (c.appliedTags.length && c.parent && 'availableTags' in c.parent) {
      const names = c.appliedTags.map((id) =>
        c.parent && 'availableTags' in c.parent
          ? (c.parent.availableTags.find((t) => t.id === id)?.name ?? id)
          : id,
      );
      lines.push(`Tags: ${names.join(', ')}`);
    }
  }
  if (c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia) {
    const tags = c.availableTags.map(
      (t) => `${t.name} (${t.id})${t.moderated ? ' [mod only]' : ''}`,
    );
    lines.push(`Tags: ${tags.join(', ') || 'none'}`);
    lines.push(
      `Default sort: ${c.defaultSortOrder ?? 'default'} · Default layout: ${'defaultForumLayout' in c ? c.defaultForumLayout : 'n/a'}`,
    );
  }
  if (c.type === ChannelType.GuildCategory) {
    lines.push(`Channels: ${c.children.cache.map((ch) => fmtChannel(ch)).join(', ') || 'none'}`);
  }
  if ('permissionOverwrites' in c)
    lines.push(`Permission overwrites: ${c.permissionOverwrites.cache.size}`);
  const me = guild.members.me;
  if (me) {
    const perms = c.permissionsFor(me);
    const missing = KEY_CHANNEL_PERMS.filter((p) => !perms?.has(PermissionFlagsBits[p]));
    lines.push(`Bot missing here: ${missing.length ? missing.join(', ') : 'nothing important'}`);
  }
  return lines;
}

export const getChannel = defineTool({
  name: 'get_channel',
  pack: 'core',
  title: 'Get channel details',
  description:
    'Details of one channel, category, thread or forum post: topic, category, slowmode, voice settings and ' +
    'who is connected, forum tags, thread state, and which key permissions the bot lacks there. Works for ' +
    'archived threads by ID or link.',
  input: {
    channel: z.string().describe('Channel or thread: ID, <#mention>, link, or name.'),
    guild: guildField,
  },
  readOnly: true,
  async run(args, ctx) {
    const c = await channelArg(ctx, args.guild, args.channel);
    if (!('guild' in c) || !c.guild) return `${fmtChannel(c)} is a DM channel.`;
    return describeChannel(c as GuildBasedChannel, c.guild).join('\n');
  },
});

const NOTABLE_ROLE_PERMS = [
  'Administrator',
  'ManageGuild',
  'ManageRoles',
  'ManageChannels',
  'KickMembers',
  'BanMembers',
  'ModerateMembers',
  'ManageMessages',
  'MentionEveryone',
  'ManageWebhooks',
] as const;

export const listRoles = defineTool({
  name: 'list_roles',
  pack: 'core',
  title: 'List roles',
  description:
    'Lists server roles from highest to lowest with ID, position, color, flags and notable permissions. ' +
    "Marks the bot's highest role: the bot can only manage roles below it.",
  input: {
    guild: guildField,
    query: z.string().optional().describe('Only roles whose name contains this text.'),
    limit: limitField(100, 250),
    cursor: cursorField,
  },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    let roles = [...guild.roles.cache.values()].sort((a, b) => b.position - a.position);
    if (args.query)
      roles = roles.filter((r) => r.name.toLowerCase().includes(args.query!.toLowerCase()));
    const botTop = guild.members.me?.roles.highest.id;
    const { items, next } = slicePage(roles, parseOffsetCursor(args.cursor), args.limit ?? 100);
    const lines = items.map((r) => {
      const flags = [
        `pos ${r.position}`,
        formatColor(r.colors.primaryColor),
        r.hoist ? 'hoisted' : '',
        r.mentionable ? 'mentionable' : '',
        r.managed ? 'managed' : '',
        r.id === botTop ? "BOT'S HIGHEST" : '',
      ].filter(Boolean);
      const perms = NOTABLE_ROLE_PERMS.filter((p) =>
        r.permissions.has(PermissionFlagsBits[p], false),
      );
      const permText = perms.includes('Administrator') ? 'Administrator' : perms.join(', ');
      return `${fmtRole(r)} · ${flags.join(' · ')}${permText ? ` · perms: ${permText}` : ''}`;
    });
    return page(`${roles.length} role(s) in ${guild.name}:`, lines, next);
  },
});
