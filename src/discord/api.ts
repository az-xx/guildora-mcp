/**
 * Lightweight Discord helpers that do not load discord.js.
 *
 * discord.js takes most of a second to import, so modules that run at startup (tool
 * definitions, error mapping, formatting) only import *types* from discord.js and get
 * runtime values (enums, snowflake math, error type guards) from here. discord.js itself
 * is imported lazily in client.ts, after the MCP handshake.
 */
export {
  ApplicationFlags,
  AuditLogEvent,
  ChannelFlags,
  ChannelType,
  ForumLayoutType,
  GatewayIntentBits,
  GuildPremiumTier,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  MessageFlags,
  MessageType,
  OverwriteType,
  PermissionFlagsBits,
  SortOrderType,
  StickerFormatType,
  ThreadAutoArchiveDuration,
} from 'discord-api-types/v10';

const DISCORD_EPOCH = 1420070400000n;

export function snowflakeTimestamp(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** The smallest snowflake at the given time (for before/after cursors). */
export function snowflakeFromTimestamp(ms: number): string {
  const t = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH;
  return (t > 0n ? t << 22n : 0n).toString();
}

/** Shape of @discordjs/rest's DiscordAPIError. */
export interface DiscordApiErrorLike extends Error {
  rawError: { message?: string; code?: number; errors?: unknown };
  code: number | string;
  status: number;
  method: string;
  url: string;
}

/** Shape of @discordjs/rest's RateLimitError. */
export interface RateLimitErrorLike extends Error {
  retryAfter: number;
  timeToReset: number;
  route: string;
  method: string;
  global: boolean;
}

/** Shape of @discordjs/rest's HTTPError (non-JSON 5xx and similar). */
export interface HttpErrorLike extends Error {
  status: number;
  method: string;
  url: string;
}

const isObj = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null;

export function isDiscordApiError(e: unknown): e is DiscordApiErrorLike {
  return (
    e instanceof Error &&
    isObj(e) &&
    'rawError' in e &&
    typeof (e as Record<string, unknown>).status === 'number' &&
    'code' in e
  );
}

export function isRateLimitError(e: unknown): e is RateLimitErrorLike {
  return (
    e instanceof Error &&
    isObj(e) &&
    typeof (e as Record<string, unknown>).retryAfter === 'number' &&
    typeof (e as Record<string, unknown>).route === 'string'
  );
}

export function isHttpError(e: unknown): e is HttpErrorLike {
  return (
    e instanceof Error &&
    e.name === 'HTTPError' &&
    typeof (e as unknown as Record<string, unknown>).status === 'number'
  );
}

/** Discord's error code as a number (DiscordAPIError.code may be a string for OAuth errors). */
export function apiErrorCode(e: DiscordApiErrorLike): number {
  return typeof e.code === 'number' ? e.code : Number(e.code);
}

/** Named colors accepted by parseColor (same values as discord.js Colors). */
export const COLORS: Record<string, number> = {
  Default: 0x000000,
  White: 0xffffff,
  Aqua: 0x1abc9c,
  Green: 0x57f287,
  Blue: 0x3498db,
  Yellow: 0xfee75c,
  Purple: 0x9b59b6,
  LuminousVividPink: 0xe91e63,
  Fuchsia: 0xeb459e,
  Gold: 0xf1c40f,
  Orange: 0xe67e22,
  Red: 0xed4245,
  Grey: 0x95a5a6,
  Navy: 0x34495e,
  DarkAqua: 0x11806a,
  DarkGreen: 0x1f8b4c,
  DarkBlue: 0x206694,
  DarkPurple: 0x71368a,
  DarkVividPink: 0xad1457,
  DarkGold: 0xc27c0e,
  DarkOrange: 0xa84300,
  DarkRed: 0x992d22,
  DarkGrey: 0x979c9f,
  DarkerGrey: 0x7f8c8d,
  LightGrey: 0xbcc0c0,
  DarkNavy: 0x2c3e50,
  Blurple: 0x5865f2,
  Greyple: 0x99aab5,
  DarkButNotBlack: 0x2c2f33,
  NotQuiteBlack: 0x23272a,
};
