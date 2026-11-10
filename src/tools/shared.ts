import { z } from 'zod';
import type {
  APIEmbed,
  Channel,
  Guild,
  GuildBasedChannel,
  GuildMember,
  Message,
  Role,
  SendableChannels,
  TextBasedChannel,
} from 'discord.js';
import { GuildoraError } from '../mcp/errors.js';
import { PermissionFlagsBits } from '../discord/api.js';
import {
  isSnowflake,
  parseColor,
  parseDate,
  parseDiscordLink,
  snowflakeAt,
} from '../discord/parse.js';
import { resolveChannel, resolveUser, type ResolveChannelOptions } from '../discord/resolve.js';
import { fmtChannel, fmtRole } from '../discord/format.js';
import { loadFile, uploadLimit, type LoadedFile } from '../discord/files.js';
import type { ToolContext } from './types.js';

// ---------------------------------------------------------------------------- common fields

export const guildField = z
  .string()
  .optional()
  .describe('Server ID or name. Optional if DISCORD_GUILD_ID is set or the bot is in one server.');

export const limitField = (def: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Max items to return (1-${max}, default ${def}).`);

export const cursorField = z
  .string()
  .optional()
  .describe('The next_cursor value from a previous call.');

export const reasonField = z
  .string()
  .max(512)
  .optional()
  .describe('Reason recorded in the audit log.');

export const channelField = (what = 'Channel') =>
  z.string().describe(`${what}: ID, <#mention>, link, or name ("general", "#general").`);

export const memberField = (what = 'Member') =>
  z
    .string()
    .describe(`${what}: user ID, <@mention>, or name (username, display name or nickname).`);

export const roleField = (what = 'Role') =>
  z.string().describe(`${what}: ID, <@&mention>, or name ("Moderators", "@Moderators").`);

// ---------------------------------------------------------------------------- resolution

const NEEDS_NO_GUILD = /^(?:<#\d{17,20}>|\d{17,20}|<?https?:\/\/\S+)$/;

/** Resolves a channel, looking up the server only when the input is a name. */
export async function channelArg(
  ctx: ToolContext,
  guildInput: string | undefined,
  input: string,
  opts: ResolveChannelOptions = {},
): Promise<Channel> {
  const guild = NEEDS_NO_GUILD.test(input.trim()) ? undefined : await ctx.guild(guildInput);
  return resolveChannel(ctx.client, guild, input, opts);
}

export async function guildChannelArg(
  ctx: ToolContext,
  guildInput: string | undefined,
  input: string,
  opts: ResolveChannelOptions = {},
): Promise<GuildBasedChannel> {
  const c = await channelArg(ctx, guildInput, input, opts);
  if (!('guild' in c) || !c.guild)
    throw new GuildoraError(`${fmtChannel(c)} is not a server channel.`);
  return c as GuildBasedChannel;
}

export const messageTargetFields = {
  channel: z
    .string()
    .optional()
    .describe('Channel or thread: ID, <#mention>, link, or name. Archived threads by ID or link.'),
  user: z
    .string()
    .optional()
    .describe('Instead of channel: a user (ID, <@mention> or name) whose DM channel to use.'),
  guild: guildField,
};

/** Resolves the channel for message tools: a server channel/thread, or a user's DM channel. */
export async function messageChannelArg(
  ctx: ToolContext,
  args: { channel?: string | undefined; user?: string | undefined; guild?: string | undefined },
): Promise<TextBasedChannel> {
  if (args.channel && args.user)
    throw new GuildoraError('Pass either "channel" or "user", not both.');
  if (args.user) {
    const guild = NEEDS_NO_GUILD.test(args.user.trim()) ? undefined : await ctx.guild(args.guild);
    const user = await resolveUser(ctx.client, guild, args.user);
    if (user.id === ctx.client.user.id) throw new GuildoraError('The bot cannot DM itself.');
    return user.createDM();
  }
  if (!args.channel) throw new GuildoraError('Pass "channel" (or "user" for a DM).');
  const c = await channelArg(ctx, args.guild, args.channel);
  if (!c.isTextBased()) {
    const hint =
      c.isThreadOnly?.() === true
        ? ' It is a forum/media channel: its posts are threads. Use list_threads to find a post, then pass the post ID.'
        : '';
    throw new GuildoraError(`${fmtChannel(c)} cannot hold messages.${hint}`);
  }
  return c;
}

export function sendable(channel: TextBasedChannel): SendableChannels {
  if (!channel.isSendable())
    throw new GuildoraError(`The bot cannot send messages in ${fmtChannel(channel)}.`);
  return channel;
}

export const messageField = z
  .string()
  .describe(
    'Message ID or message link (https://discord.com/channels/...). With a link, channel is optional.',
  );

/** Fetches a message from an ID (+ channel/user) or a message link. */
export async function messageArg(
  ctx: ToolContext,
  args: {
    message: string;
    channel?: string | undefined;
    user?: string | undefined;
    guild?: string | undefined;
  },
): Promise<Message> {
  const link = parseDiscordLink(args.message);
  let channel: TextBasedChannel;
  let id: string;
  if (link) {
    if (!link.messageId) throw new GuildoraError('That link points to a channel, not a message.');
    id = link.messageId;
    channel = await messageChannelArg(ctx, { channel: link.channelId });
  } else {
    id = args.message.trim();
    if (!isSnowflake(id)) {
      throw new GuildoraError(
        `"${args.message}" is not a message ID or link. Use read_messages to find message IDs.`,
      );
    }
    channel = await messageChannelArg(ctx, args);
  }
  return channel.messages.fetch(id);
}

/** Accepts a message ID or an ISO date, returns a snowflake usable as a cursor. */
export function cursorSnowflake(input: string | undefined, field: string): string | undefined {
  if (input === undefined || input.trim() === '') return undefined;
  const s = input.trim();
  if (isSnowflake(s)) return s;
  const link = parseDiscordLink(s);
  if (link?.messageId) return link.messageId;
  return snowflakeAt(parseDate(s, field));
}

// ---------------------------------------------------------------------------- permissions & hierarchy

export function botMember(guild: Guild): GuildMember {
  const me = guild.members.me;
  if (!me)
    throw new GuildoraError(
      `The bot's member data for ${guild.name} is not loaded yet; try again.`,
    );
  return me;
}

type PermissionKey = keyof typeof PermissionFlagsBits;

const spaced = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2');

/** Throws a clear error if the bot lacks a permission (server-wide or in a channel). */
export function requireBotPermissions(
  guild: Guild,
  perms: PermissionKey[],
  channel?: GuildBasedChannel,
): void {
  const me = botMember(guild);
  const have = channel ? channel.permissionsFor(me) : me.permissions;
  const missing = perms.filter((p) => !have?.has(PermissionFlagsBits[p]));
  if (missing.length > 0) {
    const where = channel ? ` in ${fmtChannel(channel)}` : ` in ${guild.name}`;
    throw new GuildoraError(
      `The bot is missing ${missing.map(spaced).join(', ')}${where}. ` +
        'Grant it in Server Settings > Roles (bot role) or in the channel permissions.',
    );
  }
}

/** The bot can only manage roles strictly below its own highest role. */
export function requireRoleBelowBot(guild: Guild, role: Role, action: string): void {
  const me = botMember(guild);
  if (role.managed) {
    throw new GuildoraError(
      `${fmtRole(role)} is managed by an integration or bot and cannot be ${action}.`,
    );
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    throw new GuildoraError(
      `${fmtRole(role)} (position ${role.position}) is not below the bot's highest role ${fmtRole(me.roles.highest)} ` +
        `(position ${me.roles.highest.position}), so it cannot be ${action}. ` +
        'Drag the bot role above it in Server Settings > Roles.',
    );
  }
}

/** Checks the hierarchy for actions on a member (kick, ban, timeout, nickname, roles). */
export function requireMemberBelowBot(member: GuildMember, action: string): void {
  const guild = member.guild;
  if (member.id === guild.ownerId) throw new GuildoraError(`The server owner cannot be ${action}.`);
  if (member.id === guild.client.user.id)
    throw new GuildoraError(`The bot cannot be ${action} by itself.`);
  const me = botMember(guild);
  if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    throw new GuildoraError(
      `${member.displayName}'s highest role ${fmtRole(member.roles.highest)} is not below the bot's highest role ` +
        `${fmtRole(me.roles.highest)}, so they cannot be ${action}. Move the bot role higher in Server Settings > Roles.`,
    );
  }
}

// ---------------------------------------------------------------------------- embeds & files

export const embedSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  url: z.url().optional(),
  color: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Hex like "#5865F2" or a color name.'),
  fields: z
    .array(
      z.object({
        name: z.string().max(256),
        value: z.string().max(1024),
        inline: z.boolean().optional(),
      }),
    )
    .max(25)
    .optional(),
  footer: z.string().max(2048).optional(),
  author: z.string().max(256).optional(),
  image_url: z.url().optional(),
  thumbnail_url: z.url().optional(),
  timestamp: z.string().optional().describe('ISO 8601 time shown in the footer, or "now".'),
});

export const embedsField = z
  .array(embedSchema)
  .max(10)
  .optional()
  .describe('Up to 10 rich embeds.');

export function buildEmbeds(
  embeds: z.infer<typeof embedSchema>[] | undefined,
): APIEmbed[] | undefined {
  if (!embeds) return undefined;
  return embeds.map((e) => {
    const b: APIEmbed = {};
    if (e.title) b.title = e.title;
    if (e.description) b.description = e.description;
    if (e.url) b.url = e.url;
    if (e.color !== undefined) b.color = parseColor(e.color);
    if (e.fields?.length)
      b.fields = e.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline ?? false }));
    if (e.footer) b.footer = { text: e.footer };
    if (e.author) b.author = { name: e.author };
    if (e.image_url) b.image = { url: e.image_url };
    if (e.thumbnail_url) b.thumbnail = { url: e.thumbnail_url };
    if (e.timestamp) {
      b.timestamp = (
        e.timestamp === 'now' ? new Date() : parseDate(e.timestamp, 'timestamp')
      ).toISOString();
    }
    if (!b.title && !b.description && !b.fields?.length && !b.image && !b.author) {
      throw new GuildoraError(
        'Each embed needs at least a title, description, fields, author or image.',
      );
    }
    return b;
  });
}

export const fileSchema = z.object({
  path: z.string().optional().describe('Local file path (stdio mode only).'),
  url: z.url().optional().describe('Public https URL to download.'),
  base64: z.string().optional().describe('File contents as base64 or a data: URI.'),
  name: z.string().max(200).optional().describe('File name shown in Discord, e.g. "report.pdf".'),
});

export const filesField = z.array(fileSchema).max(10).optional().describe('Up to 10 attachments.');

export async function loadFiles(
  ctx: ToolContext,
  files: z.infer<typeof fileSchema>[] | undefined,
  guild: Guild | null,
): Promise<LoadedFile[] | undefined> {
  if (!files?.length) return undefined;
  const maxBytes = uploadLimit(guild?.premiumTier);
  const out: LoadedFile[] = [];
  for (const f of files) {
    out.push(await loadFile(f, { allowLocalPaths: ctx.config.transport === 'stdio', maxBytes }));
  }
  const total = out.reduce((n, f) => n + f.attachment.length, 0);
  if (total > maxBytes) {
    throw new GuildoraError(
      `The files total more than this server's upload limit; send fewer or smaller files.`,
    );
  }
  return out;
}

export function guildOf(channel: TextBasedChannel): Guild | null {
  return 'guild' in channel && channel.guild ? channel.guild : null;
}
