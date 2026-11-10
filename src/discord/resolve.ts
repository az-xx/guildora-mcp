import type {
  Channel,
  Client,
  Guild,
  GuildEmoji,
  GuildMember,
  Role,
  Sticker,
  User,
} from 'discord.js';
import { GuildoraError } from '../mcp/errors.js';
import { ChannelType, apiErrorCode, isDiscordApiError } from './api.js';
import { isSnowflake, parseDiscordLink } from './parse.js';

// ---------------------------------------------------------------------------- name matching

interface Candidate<T> {
  item: T;
  /** Names this item answers to (display name, username, ...). */
  names: (string | null | undefined)[];
  /** How to show it in an error, e.g. "#general (123) [text]". */
  label: string;
}

const exactKey = (s: string) => s.trim().toLowerCase();
/** Ignores case, emoji, punctuation and separators: "💬・General-Chat" → "generalchat". */
const looseKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const MAX_CANDIDATES = 10;

function listLabels<T>(cands: Candidate<T>[]): string {
  const shown = cands.slice(0, MAX_CANDIDATES).map((c) => `- ${c.label}`);
  if (cands.length > MAX_CANDIDATES) shown.push(`- … and ${cands.length - MAX_CANDIDATES} more`);
  return shown.join('\n');
}

/**
 * Picks one item by name. Order: exact (case-insensitive) match, then loose match (ignoring
 * emoji and punctuation). Several matches → an error listing them, so the caller can pass an ID.
 */
export function pickByName<T>(
  candidates: Candidate<T>[],
  query: string,
  what: string,
  listHint: string,
): T {
  const q = exactKey(query);
  const exact = candidates.filter((c) => c.names.some((n) => n && exactKey(n) === q));
  if (exact.length === 1) return exact[0]!.item;
  if (exact.length > 1) throw ambiguous(exact, query, what);

  const lq = looseKey(query);
  if (lq.length > 0) {
    const loose = candidates.filter((c) => c.names.some((n) => n && looseKey(n) === lq));
    if (loose.length === 1) return loose[0]!.item;
    if (loose.length > 1) throw ambiguous(loose, query, what);

    const partial = candidates.filter((c) => c.names.some((n) => n && looseKey(n).includes(lq)));
    if (partial.length > 0) {
      throw new GuildoraError(
        `No ${what} is named "${query}". Did you mean one of these? Pass its ID or exact name:\n${listLabels(partial)}`,
      );
    }
  }
  throw new GuildoraError(`No ${what} named "${query}" was found. ${listHint}`);
}

function ambiguous<T>(cands: Candidate<T>[], query: string, what: string): GuildoraError {
  return new GuildoraError(
    `"${query}" matches ${cands.length} ${what}s. Pass the ID of the one you mean:\n${listLabels(cands)}`,
  );
}

function isUnknown(e: unknown): boolean {
  return (
    isDiscordApiError(e) && (e.status === 404 || [10003, 10007, 10013].includes(apiErrorCode(e)))
  );
}

/** Extracts an ID from "<#123>", "<@123>", "<@!123>", "<@&123>" or a bare ID. */
function mentionId(input: string, kind: 'channel' | 'user' | 'role'): string | undefined {
  const s = input.trim();
  if (isSnowflake(s)) return s;
  const re = { channel: /^<#(\d{17,20})>$/, user: /^<@!?(\d{17,20})>$/, role: /^<@&(\d{17,20})>$/ }[
    kind
  ];
  return re.exec(s)?.[1];
}

// ---------------------------------------------------------------------------- guilds

export function resolveGuild(client: Client, input: string | undefined, defaultId?: string): Guild {
  const guilds = [...client.guilds.cache.values()];
  const list = () => guilds.map((g) => `- ${g.name} (${g.id})`).join('\n') || '- (none)';
  if (input === undefined || input.trim() === '') {
    if (defaultId) {
      const g = client.guilds.cache.get(defaultId);
      if (!g) {
        throw new GuildoraError(
          `DISCORD_GUILD_ID is ${defaultId}, but the bot is not in that server. Servers the bot is in:\n${list()}`,
        );
      }
      return g;
    }
    if (guilds.length === 1) return guilds[0]!;
    if (guilds.length === 0) {
      throw new GuildoraError(
        'The bot is not in any server yet. Invite it with an OAuth2 URL (see the README), then try again.',
      );
    }
    throw new GuildoraError(
      `The bot is in ${guilds.length} servers; pass "guild" (ID or name) or set DISCORD_GUILD_ID. Servers:\n${list()}`,
    );
  }
  const s = input.trim();
  if (isSnowflake(s)) {
    const g = client.guilds.cache.get(s);
    if (!g)
      throw new GuildoraError(
        `The bot is not in a server with ID ${s}. Servers the bot is in:\n${list()}`,
      );
    return g;
  }
  return pickByName(
    guilds.map((g) => ({ item: g, names: [g.name], label: `${g.name} (${g.id})` })),
    s,
    'server',
    `Servers the bot is in:\n${list()}`,
  );
}

// ---------------------------------------------------------------------------- channels

export type ChannelKind =
  'text' | 'voice' | 'category' | 'announcement' | 'stage' | 'forum' | 'media' | 'thread';

export const CHANNEL_KINDS: Record<ChannelKind, ChannelType[]> = {
  text: [ChannelType.GuildText],
  voice: [ChannelType.GuildVoice],
  category: [ChannelType.GuildCategory],
  announcement: [ChannelType.GuildAnnouncement],
  stage: [ChannelType.GuildStageVoice],
  forum: [ChannelType.GuildForum],
  media: [ChannelType.GuildMedia],
  thread: [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread],
};

export function channelKind(type: ChannelType): ChannelKind | 'dm' | 'other' {
  for (const [kind, types] of Object.entries(CHANNEL_KINDS) as [ChannelKind, ChannelType[]][]) {
    if (types.includes(type)) return kind;
  }
  if (type === ChannelType.DM || type === ChannelType.GroupDM) return 'dm';
  return 'other';
}

/** Channels that can hold messages directly (send/read). */
export const MESSAGE_KINDS: ChannelKind[] = ['text', 'announcement', 'thread', 'voice', 'stage'];

export interface ResolveChannelOptions {
  /** Allowed kinds; all kinds when omitted. */
  kinds?: ChannelKind[];
  /** What the tool calls this argument, for error messages. */
  label?: string;
}

function channelLabel(c: Channel): string {
  const name = 'name' in c && c.name ? c.name : c.id;
  const prefix = c.type === ChannelType.GuildCategory ? '' : '#';
  return `${prefix}${name} (${c.id}) [${channelKind(c.type)}]`;
}

/**
 * Resolves a channel from an ID, a mention (<#id>), a link, or a name ("general", "#general").
 * IDs work for any channel the bot can see, including archived threads (fetched from the API).
 * Names are matched within the given server.
 */
export async function resolveChannel(
  client: Client,
  guild: Guild | undefined,
  input: string,
  opts: ResolveChannelOptions = {},
): Promise<Channel> {
  const raw = input.trim();
  const id = mentionId(raw, 'channel') ?? parseDiscordLink(raw)?.channelId;
  let channel: Channel | undefined;

  if (id) {
    channel = client.channels.cache.get(id) ?? undefined;
    if (!channel) {
      try {
        channel = (await client.channels.fetch(id)) ?? undefined;
      } catch (e) {
        if (!isUnknown(e) && !(isDiscordApiError(e) && apiErrorCode(e) === 50001)) throw e;
      }
    }
    if (!channel) {
      throw new GuildoraError(
        `No channel with ID ${id} is visible to the bot. It may be deleted, or the bot lacks View Channel there.`,
      );
    }
  } else {
    if (!guild) {
      throw new GuildoraError(
        `Pass a channel ID or link, or a server, to look up "${raw}" by name.`,
      );
    }
    const name = raw.replace(/^#/, '');
    const allowed = opts.kinds?.flatMap((k) => CHANNEL_KINDS[k]);
    const pool = [...guild.channels.cache.values()].filter(
      (c) => !allowed || allowed.includes(c.type),
    );
    channel = pickByName(
      pool.map((c) => ({ item: c as Channel, names: [c.name], label: channelLabel(c as Channel) })),
      name,
      opts.kinds?.length === 1 ? `${opts.kinds[0]} channel` : 'channel',
      'Use list_channels to see channel names and IDs. Archived threads must be passed by ID or link (list_threads shows them).',
    );
  }

  if (opts.kinds && !opts.kinds.some((k) => CHANNEL_KINDS[k].includes(channel.type))) {
    throw new GuildoraError(
      `${channelLabel(channel)} is a ${channelKind(channel.type)} channel, but ${opts.label ?? 'this argument'} must be: ${opts.kinds.join(', ')}.`,
    );
  }
  return channel;
}

// ---------------------------------------------------------------------------- members & users

function memberLabel(m: GuildMember): string {
  const nick = m.nickname ? `, nick "${m.nickname}"` : '';
  return `${m.displayName} (@${m.user.username}, ${m.id}${nick})`;
}

/**
 * Resolves a server member from an ID, a mention (<@id>), "@name" or a name. Names match the
 * username, global display name, server nickname or shown name.
 */
export async function resolveMember(guild: Guild, input: string): Promise<GuildMember> {
  const raw = input.trim();
  const id = mentionId(raw, 'user');
  if (id) {
    try {
      return await guild.members.fetch(id);
    } catch (e) {
      if (isUnknown(e)) {
        throw new GuildoraError(
          `User ${id} is not a member of ${guild.name}. (To ban or unban someone who left, pass their user ID to ban_member/unban_member.)`,
        );
      }
      throw e;
    }
  }
  const name = raw.replace(/^@/, '').replace(/#\d{4}$/, '');
  const found = new Map<string, GuildMember>();
  for (const m of guild.members.cache.values()) found.set(m.id, m);
  try {
    const results = await guild.members.search({ query: name, limit: 100 });
    for (const m of results.values()) found.set(m.id, m);
  } catch {
    // Searching is best-effort; the cache may still contain the member.
  }
  return pickByName(
    [...found.values()].map((m) => ({
      item: m,
      names: [m.user.username, m.user.globalName, m.nickname, m.displayName],
      label: memberLabel(m),
    })),
    name,
    'member',
    `Use list_members with a query to search ${guild.name}. Discord name search matches the start of usernames and nicknames.`,
  );
}

/** Resolves a user who may not be a member (e.g. for bans or DMs). Names need a server. */
export async function resolveUser(
  client: Client,
  guild: Guild | undefined,
  input: string,
): Promise<User> {
  const id = mentionId(input, 'user');
  if (id) {
    try {
      return await client.users.fetch(id);
    } catch (e) {
      if (isUnknown(e)) throw new GuildoraError(`No Discord user has the ID ${id}.`);
      throw e;
    }
  }
  if (!guild) throw new GuildoraError(`Pass a user ID, or a server to look up "${input}" by name.`);
  return (await resolveMember(guild, input)).user;
}

// ---------------------------------------------------------------------------- roles

export function resolveRole(guild: Guild, input: string): Role {
  const raw = input.trim();
  const id = mentionId(raw, 'role');
  if (id) {
    const role = guild.roles.cache.get(id);
    if (!role)
      throw new GuildoraError(
        `No role with ID ${id} in ${guild.name}. Use list_roles to see roles.`,
      );
    return role;
  }
  const name = raw.replace(/^@/, '');
  if (['everyone', '@everyone'].includes(name.toLowerCase())) return guild.roles.everyone;
  return pickByName(
    [...guild.roles.cache.values()].map((r) => ({
      item: r,
      names: [r.name],
      label: `@${r.name} (${r.id})`,
    })),
    name,
    'role',
    'Use list_roles to see role names and IDs.',
  );
}

// ---------------------------------------------------------------------------- emoji & stickers

const CUSTOM_EMOJI_RE = /^<(a?):([\w~]{1,32}):(\d{17,20})>$/;

/** True if the string contains no letters or digits, i.e. it is a Unicode emoji. */
export function isUnicodeEmoji(s: string): boolean {
  return (
    /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s) &&
    !/[\p{L}\p{N}]/u.test(s.replace(/️/g, ''))
  );
}

/** Resolves a server emoji from "<:name:id>", ":name:", a name or an ID. */
export function resolveGuildEmoji(guild: Guild, input: string): GuildEmoji {
  const raw = input.trim();
  const custom = CUSTOM_EMOJI_RE.exec(raw);
  const id = custom?.[3] ?? (isSnowflake(raw) ? raw : undefined);
  if (id) {
    const emoji = guild.emojis.cache.get(id);
    if (!emoji)
      throw new GuildoraError(
        `No emoji with ID ${id} in ${guild.name}. Use list_emoji to see emoji.`,
      );
    return emoji;
  }
  const name = raw.replace(/^:|:$/g, '');
  return pickByName(
    [...guild.emojis.cache.values()].map((e) => ({
      item: e,
      names: [e.name],
      label: `:${e.name}: (${e.id})${e.animated ? ' animated' : ''}`,
    })),
    name,
    'emoji',
    'Use list_emoji to see the server emoji.',
  );
}

/**
 * Resolves an emoji for reactions: Unicode emoji pass through; custom emoji can be given as
 * "<:name:id>", ":name:", a name or an ID (looked up in the server). Returns a value for react().
 */
export function resolveReactionEmoji(guild: Guild | undefined, input: string): string {
  const raw = input.trim();
  if (isUnicodeEmoji(raw)) return raw;
  const custom = CUSTOM_EMOJI_RE.exec(raw);
  if (custom) return `${custom[1] ? 'a' : ''}:${custom[2]}:${custom[3]}`;
  if (!guild) {
    throw new GuildoraError(
      `"${input}" is not a Unicode emoji. For a custom emoji pass "<:name:id>", or use it in a server channel.`,
    );
  }
  const e = resolveGuildEmoji(guild, raw);
  return `${e.animated ? 'a' : ''}:${e.name}:${e.id}`;
}

export function resolveSticker(guild: Guild, input: string): Sticker {
  const raw = input.trim();
  if (isSnowflake(raw)) {
    const s = guild.stickers.cache.get(raw);
    if (!s)
      throw new GuildoraError(`No sticker with ID ${raw} in ${guild.name}. Use list_stickers.`);
    return s;
  }
  return pickByName(
    [...guild.stickers.cache.values()].map((s) => ({
      item: s,
      names: [s.name],
      label: `${s.name} (${s.id})`,
    })),
    raw,
    'sticker',
    'Use list_stickers to see the server stickers.',
  );
}
