import { COLORS, PermissionFlagsBits, snowflakeFromTimestamp, snowflakeTimestamp } from './api.js';
import { GuildoraError } from '../mcp/errors.js';

export const SNOWFLAKE_RE = /^\d{17,20}$/;

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_RE.test(value);
}

export interface MessageLink {
  guildId: string | undefined; // undefined for DMs (@me)
  channelId: string;
  messageId: string | undefined;
}

const LINK_RE =
  /^<?https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(@me|\d{17,20})\/(\d{17,20})(?:\/(\d{17,20}))?\/?>?$/i;

/** Parses https://discord.com/channels/<guild|@me>/<channel>[/<message>]. */
export function parseDiscordLink(input: string): MessageLink | undefined {
  const m = LINK_RE.exec(input.trim());
  if (!m) return undefined;
  return {
    guildId: m[1] === '@me' ? undefined : m[1],
    channelId: m[2]!,
    messageId: m[3],
  };
}

// ---------------------------------------------------------------------------- durations

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  w: 604_800_000,
  wk: 604_800_000,
};

/**
 * Parses a duration: "90" (seconds), "10m", "1h30m", "7d", "2w". "0", "none" and "off" mean 0.
 * Returns milliseconds.
 */
export function parseDuration(input: string | number, field = 'duration'): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0)
      throw new GuildoraError(`${field} must be ≥ 0 seconds.`);
    return Math.round(input * 1000);
  }
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (['0', 'none', 'off', 'no', ''].includes(s)) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|sec|s|min|m|hr|h|day|d|wk|w)s?/g;
  let total = 0;
  let consumed = '';
  for (const match of s.matchAll(re)) {
    total += Number(match[1]) * UNIT_MS[match[2]!]!;
    consumed += match[0];
  }
  if (consumed !== s || total === 0) {
    throw new GuildoraError(
      `Could not parse ${field} "${input}". Use seconds or a duration such as "30s", "10m", "2h", "7d", "1h30m".`,
    );
  }
  return Math.round(total);
}

/** Like formatDuration, but only the two largest units: "28d21h", "3h5m", "45s". */
export function formatDurationShort(ms: number): string {
  const full = formatDuration(ms);
  const parts = full.match(/d+[dhms]/g) ?? [full];
  return parts.slice(0, 2).join('');
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const parts: string[] = [];
  const units: [string, number][] = [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ];
  let rest = ms;
  for (const [u, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${u}`);
      rest -= n * size;
    }
  }
  return parts.join('') || `${ms}ms`;
}

// ---------------------------------------------------------------------------- dates

/** Parses an ISO 8601 date/time (or a message ID/snowflake) into a Date. */
export function parseDate(input: string, field = 'date'): Date {
  const s = input.trim();
  if (isSnowflake(s)) return new Date(snowflakeTimestamp(s));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new GuildoraError(
      `Could not parse ${field} "${input}". Use ISO 8601, e.g. "2026-11-10T18:00:00Z" or "2026-11-10".`,
    );
  }
  return d;
}

/** A snowflake that sorts at the given time, for before/after cursors. */
export function snowflakeAt(date: Date): string {
  return snowflakeFromTimestamp(date.getTime());
}

// ---------------------------------------------------------------------------- colors

const COLOR_NAMES = new Map<string, number>(
  Object.entries(COLORS).map(([k, v]) => [k.toLowerCase(), v]),
);

/** Parses "#ff8800", "ff8800", "0xff8800", a decimal number, or a name such as "Blurple". */
export function parseColor(input: string | number): number {
  if (typeof input === 'number') {
    if (Number.isInteger(input) && input >= 0 && input <= 0xffffff) return input;
    throw new GuildoraError('color must be between 0 and 16777215 (0xFFFFFF).');
  }
  const s = input.trim().toLowerCase();
  if (s === 'none' || s === 'default') return 0;
  const hex = /^(?:#|0x)?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    return parseInt(h, 16);
  }
  if (/^\d+$/.test(s)) return parseColor(Number(s));
  const named = COLOR_NAMES.get(s.replace(/[\s_-]/g, ''));
  if (named !== undefined) return named;
  throw new GuildoraError(
    `Unknown color "${input}". Use a hex value such as "#5865F2" or a name such as "Blurple", "Red", "Green".`,
  );
}

export function formatColor(color: number): string {
  return color === 0 ? 'default' : `#${color.toString(16).padStart(6, '0').toUpperCase()}`;
}

// ---------------------------------------------------------------------------- permissions

type PermissionName = keyof typeof PermissionFlagsBits;

const normalizePerm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

const PERMISSION_LOOKUP = new Map<string, PermissionName>();
for (const name of Object.keys(PermissionFlagsBits) as PermissionName[]) {
  PERMISSION_LOOKUP.set(normalizePerm(name), name);
}
// Common aliases from the Discord UI and older API names.
const ALIASES: Record<string, PermissionName> = {
  manageserver: 'ManageGuild',
  readmessages: 'ViewChannel',
  viewchannels: 'ViewChannel',
  sendmessage: 'SendMessages',
  messagesend: 'SendMessages',
  createinvite: 'CreateInstantInvite',
  timeoutmembers: 'ModerateMembers',
  manageemojis: 'ManageGuildExpressions',
  manageemojisandstickers: 'ManageGuildExpressions',
  manageexpressions: 'ManageGuildExpressions',
  createexpressions: 'CreateGuildExpressions',
  voiceconnect: 'Connect',
  voicespeak: 'Speak',
  usevad: 'UseVAD',
  usevoiceactivity: 'UseVAD',
  admin: 'Administrator',
};
for (const [alias, name] of Object.entries(ALIASES)) PERMISSION_LOOKUP.set(alias, name);

/** Converts names such as "ManageMessages", "MANAGE_MESSAGES" or "Manage Messages". */
export function parsePermissions(
  names: readonly string[],
  field = 'permissions',
): PermissionName[] {
  const out: PermissionName[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const name = PERMISSION_LOOKUP.get(normalizePerm(raw));
    if (name) {
      if (!out.includes(name)) out.push(name);
    } else unknown.push(raw);
  }
  if (unknown.length > 0) {
    const suggestions = unknown
      .flatMap((u) => {
        const n = normalizePerm(u);
        return [...PERMISSION_LOOKUP.entries()]
          .filter(([k]) => k.includes(n) || (n.length >= 4 && n.includes(k)))
          .map(([, v]) => v);
      })
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 8);
    throw new GuildoraError(
      `Unknown ${field}: ${unknown.join(', ')}.` +
        (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '') +
        ' Use Discord permission names such as ViewChannel, SendMessages, ManageMessages, ManageRoles.',
    );
  }
  return out;
}

export function permissionBits(names: readonly PermissionName[]): bigint {
  return names.reduce((acc, n) => acc | PermissionFlagsBits[n], 0n);
}

/** Lists permission names in a bitfield. Administrator collapses to just "Administrator". */
export function permissionNames(bits: bigint): string[] {
  if ((bits & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) {
    return ['Administrator'];
  }
  return (Object.keys(PermissionFlagsBits) as PermissionName[]).filter(
    (n) =>
      (bits & PermissionFlagsBits[n]) === PermissionFlagsBits[n] && PermissionFlagsBits[n] !== 0n,
  );
}

// ---------------------------------------------------------------------------- cursors

/** Offset cursors for lists served from the cache. */
export function parseOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) {
    throw new GuildoraError(
      `Invalid cursor "${cursor}". Pass the next_cursor value from the previous result.`,
    );
  }
  return n;
}
