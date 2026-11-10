import { z } from 'zod';
import type {
  CategoryChannel,
  Guild,
  GuildBasedChannel,
  GuildChannelCreateOptions,
  GuildMember,
  OverwriteResolvable,
  PermissionOverwriteOptions,
  Role,
} from 'discord.js';
import {
  ChannelType,
  ForumLayoutType,
  OverwriteType,
  PermissionFlagsBits,
  SortOrderType,
} from '../../discord/api.js';
import { defineTool, type AnyTool, type ToolContext } from '../types.js';
import {
  botMember,
  channelArg,
  guildChannelArg,
  guildField,
  reasonField,
  requireBotPermissions,
} from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { resolveMember, resolveRole } from '../../discord/resolve.js';
import { parseDuration, parsePermissions, permissionNames } from '../../discord/parse.js';
import { fmtChannel, fmtChannelWithKind, fmtMember, fmtRole, page } from '../../discord/format.js';

const CREATE_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
  media: ChannelType.GuildMedia,
} as const;

const MAX_SLOWMODE_S = 21_600;

function slowmodeSeconds(input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  const s = Math.round(parseDuration(input, 'slowmode') / 1000);
  if (s > MAX_SLOWMODE_S) throw new GuildoraError('slowmode can be at most "6h".');
  return s;
}

async function categoryArg(
  ctx: ToolContext,
  guild: Guild,
  input: string,
): Promise<CategoryChannel> {
  return (await channelArg(ctx, guild.id, input, {
    kinds: ['category'],
    label: 'category',
  })) as CategoryChannel;
}

const commonChannelFields = {
  topic: z
    .string()
    .max(4096)
    .optional()
    .describe('Topic (text/announcement) or post guidelines (forum).'),
  nsfw: z.boolean().optional().describe('Age-restricted channel.'),
  slowmode: z
    .string()
    .optional()
    .describe('Slowmode per user, e.g. "10s", "5m", "0" for off (max "6h").'),
  position: z.number().int().min(0).optional().describe('Sort position among siblings.'),
  bitrate: z
    .number()
    .int()
    .min(8000)
    .max(384000)
    .optional()
    .describe('Voice/stage bitrate in bits/s.'),
  user_limit: z
    .number()
    .int()
    .min(0)
    .max(99)
    .optional()
    .describe('Voice user limit (0 = unlimited).'),
  rtc_region: z.string().optional().describe('Voice region ID, or "auto".'),
};

const createChannel = defineTool({
  name: 'create_channel',
  pack: 'channels',
  title: 'Create a channel',
  description:
    'Creates a text, voice, announcement, stage, forum or media channel, or a category. Put it in a category, ' +
    'set topic, slowmode, NSFW, voice settings, forum tags, or make it private (only listed roles and the bot ' +
    'can see it). Returns the new channel ID.',
  input: {
    name: z.string().min(1).max(100),
    type: z
      .enum(Object.keys(CREATE_TYPES) as [keyof typeof CREATE_TYPES])
      .optional()
      .describe('Default "text".'),
    guild: guildField,
    category: z.string().optional().describe('Parent category (ID or name).'),
    ...commonChannelFields,
    tags: z
      .array(z.string().max(20))
      .max(20)
      .optional()
      .describe('Forum/media only: tag names to create.'),
    private: z
      .boolean()
      .optional()
      .describe('Hide from @everyone; only visible_to roles and the bot can see it.'),
    visible_to: z
      .array(z.string())
      .optional()
      .describe('With private: roles (IDs or names) that can see it.'),
    reason: reasonField,
  },
  readOnly: false,
  permissions: ['Manage Channels', 'Manage Roles (for private channels)'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['ManageChannels']);
    const type = CREATE_TYPES[args.type ?? 'text'];
    const options: GuildChannelCreateOptions = { name: args.name, type };
    if (args.category) {
      if (type === ChannelType.GuildCategory)
        throw new GuildoraError('Categories cannot be inside a category.');
      options.parent = await categoryArg(ctx, guild, args.category);
    }
    if (args.topic !== undefined) options.topic = args.topic;
    if (args.nsfw !== undefined) options.nsfw = args.nsfw;
    const slow = slowmodeSeconds(args.slowmode);
    if (slow !== undefined) options.rateLimitPerUser = slow;
    if (args.position !== undefined) options.position = args.position;
    if (args.bitrate !== undefined) options.bitrate = args.bitrate;
    if (args.user_limit !== undefined) options.userLimit = args.user_limit;
    if (args.rtc_region !== undefined && args.rtc_region !== 'auto')
      options.rtcRegion = args.rtc_region;
    if (args.tags?.length) {
      if (type !== ChannelType.GuildForum && type !== ChannelType.GuildMedia) {
        throw new GuildoraError('tags only apply to forum and media channels.');
      }
      options.availableTags = args.tags.map((name) => ({ name }));
    }
    if (args.private) {
      requireBotPermissions(guild, ['ManageRoles']);
      const overwrites: OverwriteResolvable[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
        {
          id: ctx.client.user.id,
          allow: [PermissionFlagsBits.ViewChannel],
          type: OverwriteType.Member,
        },
      ];
      for (const r of args.visible_to ?? []) {
        overwrites.push({
          id: resolveRole(guild, r).id,
          allow: [PermissionFlagsBits.ViewChannel],
          type: OverwriteType.Role,
        });
      }
      options.permissionOverwrites = overwrites;
    } else if (args.visible_to?.length) {
      throw new GuildoraError('visible_to only applies together with private: true.');
    }
    if (args.reason) options.reason = args.reason;
    const created = await guild.channels.create(options);
    return `Created ${fmtChannelWithKind(created)}${created.parent ? ` in ${fmtChannel(created.parent)}` : ''}.`;
  },
});

const editChannel = defineTool({
  name: 'edit_channel',
  pack: 'channels',
  title: 'Edit or move a channel',
  description:
    'Renames, moves (category, position) or changes settings of any channel or category: topic, NSFW, ' +
    'slowmode, voice bitrate/user limit/region, forum default sort and layout. category "none" removes it ' +
    "from its category; sync_permissions copies the category's permissions. For threads use edit_thread.",
  input: {
    channel: z.string().describe('Channel or category: ID, <#mention>, link, or name.'),
    guild: guildField,
    name: z.string().min(1).max(100).optional(),
    category: z.string().optional().describe('Move into this category (ID or name), or "none".'),
    ...commonChannelFields,
    default_sort: z
      .enum(['latest_activity', 'creation_date'])
      .optional()
      .describe('Forum default sort order.'),
    default_layout: z.enum(['list', 'gallery']).optional().describe('Forum default layout.'),
    sync_permissions: z.boolean().optional().describe("Replace permissions with the category's."),
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Manage Channels'],
  async run(args, ctx) {
    const channel = await guildChannelArg(ctx, args.guild, args.channel);
    if (channel.isThread())
      throw new GuildoraError(`${fmtChannel(channel)} is a thread; use edit_thread.`);
    const guild = channel.guild;
    requireBotPermissions(guild, ['ManageChannels'], channel);
    const edit: Record<string, unknown> = {};
    if (args.name) edit.name = args.name;
    if (args.category !== undefined) {
      edit.parent = ['none', ''].includes(args.category.toLowerCase())
        ? null
        : (await categoryArg(ctx, guild, args.category)).id;
      if (args.sync_permissions !== undefined) edit.lockPermissions = args.sync_permissions;
    }
    if (args.topic !== undefined) edit.topic = args.topic;
    if (args.nsfw !== undefined) edit.nsfw = args.nsfw;
    const slow = slowmodeSeconds(args.slowmode);
    if (slow !== undefined) edit.rateLimitPerUser = slow;
    if (args.position !== undefined) edit.position = args.position;
    if (args.bitrate !== undefined) edit.bitrate = args.bitrate;
    if (args.user_limit !== undefined) edit.userLimit = args.user_limit;
    if (args.rtc_region !== undefined)
      edit.rtcRegion = args.rtc_region === 'auto' ? null : args.rtc_region;
    if (args.default_sort) {
      edit.defaultSortOrder =
        args.default_sort === 'creation_date'
          ? SortOrderType.CreationDate
          : SortOrderType.LatestActivity;
    }
    if (args.default_layout) {
      edit.defaultForumLayout =
        args.default_layout === 'gallery' ? ForumLayoutType.GalleryView : ForumLayoutType.ListView;
    }
    if (args.reason) edit.reason = args.reason;
    const onlySync = args.sync_permissions && args.category === undefined;
    if (Object.keys(edit).filter((k) => k !== 'reason').length === 0 && !onlySync) {
      throw new GuildoraError('Nothing to change: pass at least one field to edit.');
    }
    let updated: GuildBasedChannel = channel;
    if (Object.keys(edit).filter((k) => k !== 'reason').length > 0) {
      updated =
        (await (channel as unknown as { edit(o: unknown): Promise<GuildBasedChannel> }).edit(
          edit,
        )) ?? channel;
    }
    if (onlySync) {
      if (!('lockPermissions' in channel) || !channel.parent) {
        throw new GuildoraError(
          `${fmtChannel(channel)} is not in a category, so there is nothing to sync.`,
        );
      }
      await channel.lockPermissions();
    }
    return `Updated ${fmtChannelWithKind(updated)}${'parent' in updated && updated.parent ? ` in ${fmtChannel(updated.parent)}` : ''}.`;
  },
});

const deleteChannel = defineTool({
  name: 'delete_channel',
  pack: 'channels',
  title: 'Delete a channel',
  description:
    'Permanently deletes a channel, category, thread or forum post with all its messages. Deleting a category ' +
    'leaves its channels uncategorised. Destructive: returns a dry run unless confirm is true.',
  input: {
    channel: z.string().describe('Channel, category or thread: ID, <#mention>, link, or name.'),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Channels (Manage Threads for threads)'],
  async prepare(args, ctx) {
    const channel = await guildChannelArg(ctx, args.guild, args.channel);
    requireBotPermissions(
      channel.guild,
      [channel.isThread() ? 'ManageThreads' : 'ManageChannels'],
      channel,
    );
    const warnings: string[] = [];
    if (channel.type === ChannelType.GuildCategory) {
      const children = (channel as CategoryChannel).children.cache;
      warnings.push(
        children.size
          ? `Its ${children.size} channel(s) are NOT deleted; they move out of the category: ${children.map((c) => fmtChannel(c)).join(', ')}.`
          : 'The category is empty.',
      );
    } else {
      warnings.push('All messages in it are deleted permanently.');
      if ('threads' in channel && channel.threads.cache.size) {
        warnings.push(`Its ${channel.threads.cache.size} cached thread(s) are deleted too.`);
      }
    }
    if (
      channel.id === channel.guild.rulesChannelId ||
      channel.id === channel.guild.publicUpdatesChannelId
    ) {
      warnings.push('This is the server rules or community updates channel.');
    }
    return {
      summary: `delete ${fmtChannelWithKind(channel)} in ${channel.guild.name}`,
      warnings,
      async execute() {
        await channel.delete(args.reason);
        return `Deleted ${fmtChannelWithKind(channel)}.`;
      },
    };
  },
});

type OverwriteTarget = { kind: 'role'; role: Role } | { kind: 'member'; member: GuildMember };

async function overwriteTarget(
  guild: Guild,
  input: string,
  type?: 'role' | 'member',
): Promise<OverwriteTarget> {
  const raw = input.trim();
  if (
    type === 'role' ||
    /^<@&\d+>$/.test(raw) ||
    ['everyone', '@everyone'].includes(raw.toLowerCase())
  ) {
    return { kind: 'role', role: resolveRole(guild, raw) };
  }
  if (type === 'member' || /^<@!?\d+>$/.test(raw))
    return { kind: 'member', member: await resolveMember(guild, raw) };
  if (/^\d{17,20}$/.test(raw)) {
    const role = guild.roles.cache.get(raw);
    if (role) return { kind: 'role', role };
    return { kind: 'member', member: await resolveMember(guild, raw) };
  }
  // A bare name: roles first; fall back to members.
  try {
    return { kind: 'role', role: resolveRole(guild, raw) };
  } catch {
    return { kind: 'member', member: await resolveMember(guild, raw) };
  }
}

const fmtTarget = (t: OverwriteTarget) =>
  t.kind === 'role' ? `role ${fmtRole(t.role)}` : `member ${fmtMember(t.member)}`;

function overwritableChannel(channel: GuildBasedChannel) {
  if (channel.isThread() || !('permissionOverwrites' in channel)) {
    throw new GuildoraError(
      `${fmtChannel(channel)} is a thread; threads use their parent channel's permissions.`,
    );
  }
  return channel;
}

const listOverwrites = defineTool({
  name: 'list_permission_overwrites',
  pack: 'channels',
  title: 'List channel permissions',
  description:
    "Lists a channel's or category's permission overwrites: for each role or member, which permissions are " +
    'explicitly allowed and denied (everything else is inherited from roles).',
  input: {
    channel: z.string().describe('Channel or category: ID, <#mention>, link, or name.'),
    guild: guildField,
  },
  readOnly: true,
  async run(args, ctx) {
    const channel = overwritableChannel(await guildChannelArg(ctx, args.guild, args.channel));
    const memberIds = channel.permissionOverwrites.cache
      .filter((o) => o.type === OverwriteType.Member)
      .map((o) => o.id);
    if (memberIds.length) {
      await channel.guild.members.fetch({ user: memberIds }).catch(() => undefined);
    }
    const lines = channel.permissionOverwrites.cache.map((o) => {
      const who =
        o.type === OverwriteType.Role
          ? (() => {
              const r = channel.guild.roles.cache.get(o.id);
              return r ? `role ${fmtRole(r)}` : `role ${o.id}`;
            })()
          : (() => {
              const m = channel.guild.members.cache.get(o.id);
              return m ? `member ${fmtMember(m)}` : `member ${o.id}`;
            })();
      const allow = permissionNames(o.allow.bitfield);
      const deny = permissionNames(o.deny.bitfield);
      return `${who} · allow: ${allow.join(', ') || '-'} · deny: ${deny.join(', ') || '-'}`;
    });
    const synced =
      'permissionsLocked' in channel && channel.permissionsLocked ? ' (synced with category)' : '';
    return page(`${lines.length} overwrite(s) on ${fmtChannel(channel)}${synced}:`, lines);
  },
});

const permsList = (what: string) =>
  z.array(z.string()).optional().describe(`${what} (permission names, e.g. "SendMessages").`);

const setPermissions = defineTool({
  name: 'set_permissions',
  pack: 'channels',
  title: 'Set channel permissions',
  description:
    'Allows, denies or resets (back to inherited) permissions for a role or member on one channel or category. ' +
    'By default it changes only the listed permissions and keeps the rest of the overwrite; replace: true ' +
    'replaces the whole overwrite. Example: deny ["SendMessages"] for @everyone to make a channel read-only.',
  input: {
    channel: z.string().describe('Channel or category: ID, <#mention>, link, or name.'),
    target: z.string().describe('Role or member: ID, mention, name, or "everyone".'),
    target_type: z
      .enum(['role', 'member'])
      .optional()
      .describe('Only needed if a role and member share the name.'),
    allow: permsList('Permissions to allow'),
    deny: permsList('Permissions to deny'),
    reset: permsList('Permissions to set back to inherited'),
    replace: z.boolean().optional().describe('Replace the whole overwrite instead of merging.'),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Manage Roles (Manage Permissions on the channel)'],
  async run(args, ctx) {
    const channel = overwritableChannel(await guildChannelArg(ctx, args.guild, args.channel));
    requireBotPermissions(channel.guild, ['ManageRoles'], channel);
    const allow = parsePermissions(args.allow ?? [], 'allow');
    const deny = parsePermissions(args.deny ?? [], 'deny');
    const reset = parsePermissions(args.reset ?? [], 'reset');
    if (!allow.length && !deny.length && !reset.length)
      throw new GuildoraError('Pass allow, deny or reset.');
    const clash = allow
      .filter((p) => deny.includes(p) || reset.includes(p))
      .concat(deny.filter((p) => reset.includes(p)));
    if (clash.length)
      throw new GuildoraError(`A permission can only be in one list: ${clash.join(', ')}.`);
    const me = botMember(channel.guild);
    if (!me.permissions.has(PermissionFlagsBits.Administrator)) {
      const mine = channel.permissionsFor(me);
      const cannot = [...allow, ...deny].filter((p) => !mine?.has(PermissionFlagsBits[p]));
      if (cannot.length) {
        throw new GuildoraError(
          `The bot can only set permissions it has in this channel. Missing: ${cannot.join(', ')}.`,
        );
      }
    }
    const target = await overwriteTarget(channel.guild, args.target, args.target_type);
    const id = target.kind === 'role' ? target.role.id : target.member.id;
    const options: PermissionOverwriteOptions = {};
    for (const p of allow) options[p] = true;
    for (const p of deny) options[p] = false;
    for (const p of reset) options[p] = null;
    const meta = {
      type: target.kind === 'role' ? OverwriteType.Role : OverwriteType.Member,
      ...(args.reason ? { reason: args.reason } : {}),
    };
    if (args.replace) await channel.permissionOverwrites.create(id, options, meta);
    else await channel.permissionOverwrites.edit(id, options, meta);
    const ow = channel.permissionOverwrites.cache.get(id);
    const now = ow
      ? ` Now allow: ${permissionNames(ow.allow.bitfield).join(', ') || '-'}; deny: ${permissionNames(ow.deny.bitfield).join(', ') || '-'}.`
      : '';
    return `Updated permissions for ${fmtTarget(target)} on ${fmtChannel(channel)}.${now}`;
  },
});

const deleteOverwrite = defineTool({
  name: 'delete_permission_overwrite',
  pack: 'channels',
  title: 'Remove a permission overwrite',
  description:
    "Removes a role's or member's whole permission overwrite from a channel, so they fall back to their " +
    'role permissions. Destructive: returns a dry run unless confirm is true.',
  input: {
    channel: z.string().describe('Channel or category: ID, <#mention>, link, or name.'),
    target: z.string().describe('Role or member: ID, mention, name, or "everyone".'),
    target_type: z.enum(['role', 'member']).optional(),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Roles (Manage Permissions on the channel)'],
  async prepare(args, ctx) {
    const channel = overwritableChannel(await guildChannelArg(ctx, args.guild, args.channel));
    requireBotPermissions(channel.guild, ['ManageRoles'], channel);
    const target = await overwriteTarget(channel.guild, args.target, args.target_type);
    const id = target.kind === 'role' ? target.role.id : target.member.id;
    const ow = channel.permissionOverwrites.cache.get(id);
    if (!ow) {
      const existing = channel.permissionOverwrites.cache.map((o) => o.id).join(', ') || 'none';
      throw new GuildoraError(
        `${fmtChannel(channel)} has no overwrite for ${fmtTarget(target)}. Overwrite IDs: ${existing}.`,
      );
    }
    return {
      summary: `remove the overwrite for ${fmtTarget(target)} on ${fmtChannel(channel)} (allow: ${permissionNames(ow.allow.bitfield).join(', ') || '-'}; deny: ${permissionNames(ow.deny.bitfield).join(', ') || '-'})`,
      async execute() {
        await channel.permissionOverwrites.delete(id, args.reason);
        return `Removed the overwrite for ${fmtTarget(target)} on ${fmtChannel(channel)}.`;
      },
    };
  },
});

export const channelTools: AnyTool[] = [
  createChannel,
  editChannel,
  deleteChannel,
  listOverwrites,
  setPermissions,
  deleteOverwrite,
];
