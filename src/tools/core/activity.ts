import { z } from 'zod';
import type { Guild, GuildBasedChannel, GuildMember, Message, TextBasedChannel } from 'discord.js';
import { ChannelType, PermissionFlagsBits, snowflakeTimestamp } from '../../discord/api.js';
import { defineTool, type ToolContext } from '../types.js';
import { channelArg, guildField } from '../shared.js';
import { resolveRole } from '../../discord/resolve.js';
import {
  formatDurationShort,
  parseDate,
  parseDuration,
  parseOffsetCursor,
  snowflakeAt,
} from '../../discord/parse.js';
import { fmtChannel, fmtUser, page, truncate, ts } from '../../discord/format.js';

export type MessageChannel = GuildBasedChannel & TextBasedChannel;

const CONCURRENCY = 5;

/** Runs fn over items with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** "24h", "7d" (ago) or an ISO date → Date. */
export function parseSince(input: string | undefined, fallback: string): Date {
  const raw = (input ?? fallback).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return parseDate(raw, 'since');
  return new Date(Date.now() - parseDuration(raw, 'since'));
}

/** Last activity of a channel from the cache (no API call): its last message, else its creation. */
export function lastActivity(c: {
  lastMessageId?: string | null;
  createdTimestamp?: number | null;
}): number {
  if (c.lastMessageId) return snowflakeTimestamp(c.lastMessageId);
  return c.createdTimestamp ?? 0;
}

const scopeField = z
  .string()
  .optional()
  .describe(
    'Limit to a category, channel, forum or thread (ID or name). Default: the whole server.',
  );

/** Text-based channels and active threads in scope that the bot can read. */
export async function channelsInScope(
  ctx: ToolContext,
  guild: Guild,
  scope: string | undefined,
): Promise<MessageChannel[]> {
  const { threads } = await guild.channels.fetchActiveThreads();
  const all: GuildBasedChannel[] = [...guild.channels.cache.values(), ...threads.values()];
  let picked: GuildBasedChannel[];
  if (!scope) {
    picked = all;
  } else {
    const target = (await channelArg(ctx, guild.id, scope)) as GuildBasedChannel;
    if (target.type === ChannelType.GuildCategory) {
      picked = all.filter(
        (c) => c.parentId === target.id || (c.isThread() && c.parent?.parentId === target.id),
      );
    } else if (target.isThread()) {
      picked = [target];
    } else {
      picked = all.filter((c) => c.id === target.id || (c.isThread() && c.parentId === target.id));
    }
  }
  const me = guild.members.me;
  const seen = new Set<string>();
  return picked.filter((c): c is MessageChannel => {
    if (seen.has(c.id) || !c.isTextBased()) return false;
    seen.add(c.id);
    const perms = me ? c.permissionsFor(me) : null;
    return Boolean(
      perms?.has(PermissionFlagsBits.ViewChannel) &&
      perms.has(PermissionFlagsBits.ReadMessageHistory),
    );
  });
}

function where(c: MessageChannel): string {
  const parent = c.parent;
  return parent ? ` in ${fmtChannel(parent)}` : '';
}

function snippet(m: Message): string {
  const text = m.content.replace(/\s+/g, ' ').trim();
  if (text) return `"${truncate(text, 120)}"`;
  if (m.attachments.size) return `[${m.attachments.size} attachment(s)]`;
  if (m.embeds.length) return '[embed]';
  return '[no text]';
}

// ---------------------------------------------------------------------------- recent_activity

export const recentActivity = defineTool({
  name: 'recent_activity',
  pack: 'core',
  title: 'Recent activity across channels',
  description:
    'Shows which channels and threads had messages from people since a time ("24h" by default, or "7d", an ' +
    'ISO date), newest first, with how many messages and people and the latest message (include_bots adds ' +
    'bot activity). Use it to see what is going on without opening channels one by one; then read_messages.',
  input: {
    guild: guildField,
    since: z
      .string()
      .optional()
      .describe('How far back: "2h", "24h" (default), "7d", or an ISO date.'),
    scope: scopeField,
    include_bots: z
      .boolean()
      .optional()
      .describe('Also count bot and webhook messages (default false: people only).'),
    limit: z.number().int().min(1).max(50).optional().describe('Max channels (1-50, default 20).'),
    cursor: z.string().optional().describe('next_cursor from a previous call.'),
  },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const since = parseSince(args.since, '24h');
    const sinceId = snowflakeAt(since);
    const active = (await channelsInScope(ctx, guild, args.scope))
      .filter((c) => lastActivity(c) >= since.getTime() && c.lastMessageId)
      .sort((a, b) => lastActivity(b) - lastActivity(a));
    const offset = parseOffsetCursor(args.cursor);
    const limit = args.limit ?? 20;
    // Bot-only channels are filtered out after fetching, so keep scanning until the page is full.
    const maxScan = Math.max(limit * 3, 60);
    const describeChannel = async (c: MessageChannel) => {
      const batch = [...(await c.messages.fetch({ after: sinceId, limit: 100 })).values()];
      const msgs = args.include_bots ? batch : batch.filter((m) => !m.author.bot);
      if (msgs.length === 0) return undefined;
      const latest = msgs.reduce((a, b) => (a.createdTimestamp > b.createdTimestamp ? a : b));
      const people = new Set(msgs.filter((m) => !m.author.bot).map((m) => m.author.id)).size;
      const count = batch.length === 100 ? '100+' : String(msgs.length);
      const line =
        `${fmtChannel(c)}${where(c)} · ${count} msg(s), ${people} ${people === 1 ? 'person' : 'people'}` +
        ` · last [${ts(latest.createdAt)}] ${fmtUser(latest.author)}: ${snippet(latest)}`;
      return { line, at: latest.createdTimestamp };
    };
    const found: { line: string; at: number }[] = [];
    let scanned = offset;
    while (found.length < limit && scanned < active.length && scanned - offset < maxScan) {
      const chunk = active.slice(scanned, scanned + CONCURRENCY);
      const rows = await mapLimit(chunk, CONCURRENCY, describeChannel);
      for (const row of rows) {
        if (found.length >= limit) break;
        scanned++;
        if (row) found.push(row);
      }
    }
    const lines = found.sort((a, b) => b.at - a.at).map((r) => r.line);
    const next = scanned < active.length ? String(scanned) : undefined;
    const kind = args.include_bots ? '' : ' with messages from people';
    return page(
      `${lines.length} channel(s)/thread(s)${kind} since ${ts(since)} (checked ${scanned - offset} of ${active.length} with any activity):`,
      lines,
      next,
    );
  },
});

// ---------------------------------------------------------------------------- list_unanswered

/** Permissions that mark someone as staff when no staff roles are given. */
const STAFF_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
];

export interface WaitingRun {
  /** Messages since the last staff reply (newest first), people only unless bots count as staff. */
  messages: Message[];
  /** True if no staff reply was found in the fetched window. */
  noStaffInWindow: boolean;
}

/**
 * Looks at messages newest first and returns the trailing run of non-staff messages, or undefined
 * if the newest human message is from staff (answered) or there are no human messages.
 */
export function waitingRun(
  newestFirst: Message[],
  isStaff: (m: Message) => boolean,
  botsCountAsStaff: boolean,
): WaitingRun | undefined {
  const run: Message[] = [];
  for (const m of newestFirst) {
    if (m.author.bot) {
      if (botsCountAsStaff) break;
      continue;
    }
    if (isStaff(m)) break;
    run.push(m);
  }
  if (run.length === 0) return undefined;
  const answeredInWindow = newestFirst.some(
    (m) => (m.author.bot && botsCountAsStaff) || (!m.author.bot && isStaff(m)),
  );
  return { messages: run, noStaffInWindow: !answeredInWindow };
}

const MAX_SCAN = 150;
const WINDOW = 25;

export const listUnanswered = defineTool({
  name: 'list_unanswered',
  pack: 'core',
  title: 'Find conversations waiting for staff',
  description:
    'Finds channels, tickets, threads and forum posts where the latest message from a person is not from staff, ' +
    'i.e. someone is waiting for a reply; sorted by longest wait. Staff = members with staff_roles, or by default ' +
    'anyone with Administrator, Manage Server, Manage Channels, Manage Messages or Timeout Members. Bot messages are ' +
    'ignored unless bot_replies_count is true.',
  input: {
    guild: guildField,
    scope: scopeField,
    staff_roles: z
      .array(z.string())
      .optional()
      .describe('Roles whose members count as staff (IDs or names).'),
    since: z
      .string()
      .optional()
      .describe('Only conversations active within this window (default "30d").'),
    min_wait: z
      .string()
      .optional()
      .describe('Only those waiting at least this long, e.g. "2h". Default: any.'),
    bot_replies_count: z
      .boolean()
      .optional()
      .describe('Treat messages from bots as answers (default false).'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (1-50, default 25).'),
    cursor: z
      .string()
      .optional()
      .describe('next_cursor from a previous call (continues the scan).'),
  },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const since = parseSince(args.since, '30d');
    const minWait = args.min_wait ? parseDuration(args.min_wait, 'min_wait') : 0;
    const staffRoleIds = args.staff_roles?.map((r) => resolveRole(guild, r).id);
    const candidates = (await channelsInScope(ctx, guild, args.scope))
      .filter((c) => c.lastMessageId && lastActivity(c) >= since.getTime())
      .sort((a, b) => lastActivity(b) - lastActivity(a));
    const offset = parseOffsetCursor(args.cursor);
    const batch = candidates.slice(offset, offset + MAX_SCAN);
    if (candidates.length === 0) {
      return `No channels or threads in scope had messages since ${ts(since)}.`;
    }

    const memberCache = new Map<string, GuildMember | null>();
    const member = async (id: string) => {
      if (!memberCache.has(id))
        memberCache.set(id, await guild.members.fetch(id).catch(() => null));
      return memberCache.get(id)!;
    };
    const staffIn = (c: MessageChannel, m: GuildMember | null) => {
      if (!m) return false;
      if (m.id === guild.ownerId) return true;
      if (staffRoleIds) return staffRoleIds.some((r) => m.roles.cache.has(r));
      const perms = c.permissionsFor(m);
      return STAFF_PERMS.some((p) => perms?.has(p));
    };

    const found = await mapLimit(batch, CONCURRENCY, async (c) => {
      const msgs = [...(await c.messages.fetch({ limit: WINDOW })).values()].sort(
        (a, b) => b.createdTimestamp - a.createdTimestamp,
      );
      const authors = new Map<string, boolean>();
      for (const m of msgs) {
        if (!m.author.bot && !authors.has(m.author.id))
          authors.set(m.author.id, staffIn(c, await member(m.author.id)));
      }
      const run = waitingRun(
        msgs,
        (m) => authors.get(m.author.id) === true,
        args.bot_replies_count === true,
      );
      if (!run) return undefined;
      const first = run.messages.at(-1)!;
      const waitMs = Date.now() - first.createdTimestamp;
      if (waitMs < minWait) return undefined;
      return { c, run, waitMs, last: run.messages[0]! };
    });

    const results = found
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .sort((a, b) => b.waitMs - a.waitMs);
    const limit = args.limit ?? 25;
    const lines = results.slice(0, limit).map(({ c, run, waitMs, last }) => {
      const count =
        run.noStaffInWindow && run.messages.length >= WINDOW
          ? `${WINDOW}+`
          : String(run.messages.length);
      return (
        `${fmtChannel(c)}${where(c)} · waiting ${formatDurationShort(waitMs)} · ${count} msg(s) since the last staff reply` +
        `${run.noStaffInWindow ? ' (no staff reply in the last 25 messages)' : ''}` +
        ` · last [${ts(last.createdAt)}] ${fmtUser(last.author)}: ${snippet(last)}`
      );
    });
    const scannedTo = offset + batch.length;
    const more = scannedTo < candidates.length;
    const rule = staffRoleIds
      ? 'staff = members of the given roles'
      : 'staff = moderators/admins by permission';
    if (results.length > limit)
      lines.push(`… and ${results.length - limit} more in this scan (raise limit).`);
    return page(
      `${results.length} conversation(s) waiting for staff (scanned ${batch.length} of ${candidates.length} active since ${ts(since)}; ${rule}):`,
      lines,
      more ? String(scannedTo) : undefined,
      more ? `More channels remain; pass cursor "${scannedTo}" to scan the next ones.` : undefined,
    );
  },
});
