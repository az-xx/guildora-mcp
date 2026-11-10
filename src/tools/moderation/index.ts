import { z } from 'zod';
import type { Collection, Message, Snowflake, User } from 'discord.js';
import { AuditLogEvent, PermissionFlagsBits } from '../../discord/api.js';
import { defineTool, type AnyTool } from '../types.js';
import {
  botMember,
  guildChannelArg,
  guildField,
  memberField,
  reasonField,
  requireBotPermissions,
  requireMemberBelowBot,
} from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { resolveMember, resolveUser } from '../../discord/resolve.js';
import { formatDuration, isSnowflake, parseDuration } from '../../discord/parse.js';
import { fmtChannel, fmtMember, fmtUser, page, truncate, ts } from '../../discord/format.js';

const MAX_TIMEOUT_MS = 28 * 86_400_000;
const MAX_BAN_DELETE_MS = 7 * 86_400_000;
const BULK_MAX_AGE_MS = 14 * 86_400_000;

const kickMember = defineTool({
  name: 'kick_member',
  pack: 'moderation',
  title: 'Kick a member',
  description:
    'Removes a member from the server; they can rejoin with an invite. Destructive: returns a dry run unless ' +
    'confirm is true. Use ban_member to keep them out, timeout_member to mute them temporarily.',
  input: { member: memberField(), guild: guildField, reason: reasonField },
  readOnly: false,
  destructive: true,
  permissions: ['Kick Members'],
  async prepare(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const m = await resolveMember(guild, args.member);
    requireBotPermissions(guild, ['KickMembers']);
    requireMemberBelowBot(m, 'kicked');
    return {
      summary: `kick ${fmtMember(m)} from ${guild.name}${args.reason ? ` (reason: ${args.reason})` : ''}`,
      async execute() {
        await m.kick(args.reason);
        return `Kicked ${fmtMember(m)} from ${guild.name}.`;
      },
    };
  },
});

const banMember = defineTool({
  name: 'ban_member',
  pack: 'moderation',
  title: 'Ban a user',
  description:
    'Bans a user so they cannot rejoin; works for current members and for users who already left (pass their ' +
    'user ID). Optionally deletes their recent messages (delete_messages up to "7d"). Destructive: returns a dry ' +
    'run unless confirm is true.',
  input: {
    user: z.string().describe('User: ID, <@mention>, or a member name.'),
    guild: guildField,
    delete_messages: z
      .string()
      .optional()
      .describe(
        'Delete their messages from this far back, e.g. "1h", "1d", "7d" (max). Default: none.',
      ),
    reason: reasonField,
  },
  readOnly: false,
  destructive: true,
  permissions: ['Ban Members'],
  async prepare(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['BanMembers']);
    const user = await resolveUser(ctx.client, guild, args.user);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) requireMemberBelowBot(member, 'banned');
    const deleteMs = args.delete_messages
      ? parseDuration(args.delete_messages, 'delete_messages')
      : 0;
    if (deleteMs > MAX_BAN_DELETE_MS)
      throw new GuildoraError('delete_messages can be at most "7d".');
    const existing = await guild.bans.fetch(user.id).catch(() => null);
    if (existing) throw new GuildoraError(`${fmtUser(user)} is already banned from ${guild.name}.`);
    const warnings: string[] = [];
    if (!member)
      warnings.push(`${fmtUser(user)} is not currently a member; the ban stops them from joining.`);
    if (deleteMs)
      warnings.push(
        `Their messages from the last ${formatDuration(deleteMs)} will be deleted in all channels.`,
      );
    return {
      summary: `ban ${fmtUser(user)} from ${guild.name}${args.reason ? ` (reason: ${args.reason})` : ''}`,
      warnings,
      async execute() {
        await guild.bans.create(user.id, {
          deleteMessageSeconds: Math.floor(deleteMs / 1000),
          ...(args.reason ? { reason: args.reason } : {}),
        });
        return `Banned ${fmtUser(user)} from ${guild.name}.`;
      },
    };
  },
});

const unbanMember = defineTool({
  name: 'unban_member',
  pack: 'moderation',
  title: 'Unban a user',
  description:
    "Lifts a ban so the user can rejoin with an invite. Accepts a user ID or the banned user's name.",
  input: {
    user: z.string().describe('User ID, <@mention>, or username from the ban list.'),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Ban Members'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['BanMembers']);
    const raw = args.user
      .trim()
      .replace(/^<@!?(\d+)>$/, '$1')
      .replace(/^@/, '');
    let userId = raw;
    if (!isSnowflake(raw)) {
      const bans = await guild.bans.fetch({ limit: 1000 });
      const hits = [...bans.values()].filter(
        (b) =>
          b.user.username.toLowerCase() === raw.toLowerCase() ||
          b.user.globalName?.toLowerCase() === raw.toLowerCase(),
      );
      if (hits.length === 0)
        throw new GuildoraError(`No banned user named "${args.user}". Use list_bans to see bans.`);
      if (hits.length > 1) {
        throw new GuildoraError(
          `"${args.user}" matches several bans: ${hits.map((b) => fmtUser(b.user)).join(', ')}. Pass the ID.`,
        );
      }
      userId = hits[0]!.user.id;
    }
    const user = await guild.bans.remove(userId, args.reason);
    return `Unbanned ${user ? fmtUser(user) : userId} from ${guild.name}.`;
  },
});

const listBans = defineTool({
  name: 'list_bans',
  pack: 'moderation',
  title: 'List bans',
  description: 'Lists banned users with their ban reasons, in pages (pass next_cursor as cursor).',
  input: {
    guild: guildField,
    limit: z.number().int().min(1).max(100).optional().describe('Max bans (1-100, default 50).'),
    cursor: z.string().optional().describe('next_cursor from a previous call.'),
  },
  readOnly: true,
  permissions: ['Ban Members'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['BanMembers']);
    const limit = args.limit ?? 50;
    if (args.cursor && !isSnowflake(args.cursor)) throw new GuildoraError('Invalid cursor.');
    const bans = await guild.bans.fetch({ limit, ...(args.cursor ? { after: args.cursor } : {}) });
    const list = [...bans.values()].sort((a, b) =>
      BigInt(a.user.id) < BigInt(b.user.id) ? -1 : 1,
    );
    return page(
      `${list.length} ban(s) in ${guild.name}:`,
      list.map(
        (b) => `${fmtUser(b.user)} · reason: ${b.reason ? truncate(b.reason, 200) : 'none'}`,
      ),
      list.length === limit ? list.at(-1)!.user.id : undefined,
    );
  },
});

const timeoutMember = defineTool({
  name: 'timeout_member',
  pack: 'moderation',
  title: 'Time out a member',
  description:
    'Times a member out (they cannot send messages, react or join voice) for a duration such as "10m", "1h" or ' +
    '"7d" (max 28 days). duration "0" removes an existing timeout.',
  input: {
    member: memberField(),
    duration: z
      .string()
      .describe('How long: "60s", "10m", "2h", "7d" (max "28d"). "0" or "none" ends the timeout.'),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Moderate Members (Timeout Members)'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const m = await resolveMember(guild, args.member);
    requireBotPermissions(guild, ['ModerateMembers']);
    requireMemberBelowBot(m, 'timed out');
    const ms = parseDuration(args.duration);
    if (ms > MAX_TIMEOUT_MS) throw new GuildoraError('Timeouts can last at most 28 days ("28d").');
    if (m.permissions.has(PermissionFlagsBits.Administrator))
      throw new GuildoraError(
        `${fmtMember(m)} is an Administrator; Discord does not allow timing them out.`,
      );
    await m.timeout(ms === 0 ? null : ms, args.reason);
    return ms === 0
      ? `Removed the timeout from ${fmtMember(m)}.`
      : `Timed out ${fmtMember(m)} for ${formatDuration(ms)} (until ${ts(Date.now() + ms)}).`;
  },
});

const setNickname = defineTool({
  name: 'set_nickname',
  pack: 'moderation',
  title: 'Set a nickname',
  description:
    "Sets a member's server nickname, or resets it with an empty string. Works for the bot itself too.",
  input: {
    member: memberField('Member (or "me" for the bot)'),
    nickname: z.string().max(32).describe('New nickname (max 32 characters). "" resets it.'),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Manage Nicknames (Change Nickname for the bot itself)'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const isMe = ['me', 'bot', 'self'].includes(args.member.trim().toLowerCase());
    const m = isMe ? botMember(guild) : await resolveMember(guild, args.member);
    if (m.id !== ctx.client.user.id) {
      requireBotPermissions(guild, ['ManageNicknames']);
      requireMemberBelowBot(m, 'renamed');
    }
    await m.setNickname(args.nickname === '' ? null : args.nickname, args.reason);
    return args.nickname === ''
      ? `Reset the nickname of ${m.user.username}.`
      : `Set the nickname of @${m.user.username} (${m.id}) to "${args.nickname}".`;
  },
});

const bulkDelete = defineTool({
  name: 'bulk_delete_messages',
  pack: 'moderation',
  title: 'Bulk delete messages',
  description:
    'Deletes many recent messages in one channel at once: scans the last `scan` messages (max 100) and deletes ' +
    'those matching the filters (author, text). Pinned messages and messages older than 14 days are skipped ' +
    '(Discord limit). Destructive: the dry run lists what would go and gives an up_to ID to confirm exactly that set.',
  input: {
    channel: z.string().describe('Channel or thread: ID, <#mention>, link, or name.'),
    guild: guildField,
    scan: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('How many recent messages to look at (1-100, default 50).'),
    author: z.string().optional().describe('Only messages by this user (ID, mention or name).'),
    contains: z
      .string()
      .optional()
      .describe('Only messages whose text contains this (case-insensitive).'),
    up_to: z
      .string()
      .optional()
      .describe('Only messages at or before this message ID (use the value from the dry run).'),
    include_pinned: z.boolean().optional().describe('Also delete pinned messages (default false).'),
    reason: reasonField,
  },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Messages', 'Read Message History'],
  async prepare(args, ctx) {
    const channel = await guildChannelArg(ctx, args.guild, args.channel, {
      kinds: ['text', 'announcement', 'thread', 'voice', 'stage'],
    });
    if (!channel.isTextBased()) throw new GuildoraError(`${fmtChannel(channel)} has no messages.`);
    requireBotPermissions(channel.guild, ['ManageMessages', 'ReadMessageHistory'], channel);
    const authorId = args.author
      ? (await resolveUser(ctx.client, channel.guild, args.author)).id
      : undefined;
    if (args.up_to && !isSnowflake(args.up_to))
      throw new GuildoraError('up_to must be a message ID.');
    const fetchOpts = {
      limit: args.scan ?? 50,
      ...(args.up_to ? { before: (BigInt(args.up_to) + 1n).toString() } : {}),
    };
    const fetched: Collection<Snowflake, Message> = await channel.messages.fetch(fetchOpts);
    const now = Date.now();
    let tooOld = 0;
    let pinned = 0;
    const targets = [...fetched.values()].filter((m) => {
      if (authorId && m.author.id !== authorId) return false;
      if (args.contains && !m.content.toLowerCase().includes(args.contains.toLowerCase()))
        return false;
      if (m.pinned && !args.include_pinned) {
        pinned++;
        return false;
      }
      if (now - m.createdTimestamp > BULK_MAX_AGE_MS - 60_000) {
        tooOld++;
        return false;
      }
      return true;
    });
    if (targets.length === 0) {
      throw new GuildoraError(
        `No deletable messages matched among the last ${fetched.size} in ${fmtChannel(channel)}` +
          `${tooOld ? ` (${tooOld} too old for bulk delete)` : ''}${pinned ? ` (${pinned} pinned skipped)` : ''}.`,
      );
    }
    const byAuthor = new Map<string, number>();
    for (const m of targets)
      byAuthor.set(m.author.username, (byAuthor.get(m.author.username) ?? 0) + 1);
    const newest = targets.reduce((a, b) => (BigInt(a.id) > BigInt(b.id) ? a : b));
    const oldest = targets.reduce((a, b) => (BigInt(a.id) < BigInt(b.id) ? a : b));
    const warnings = [
      `By author: ${[...byAuthor.entries()].map(([u, n]) => `@${u} ${n}`).join(', ')}.`,
      `Range: ${ts(oldest.createdAt)} to ${ts(newest.createdAt)}. To delete exactly this set, confirm with "up_to": "${newest.id}".`,
    ];
    if (tooOld)
      warnings.push(`${tooOld} matching message(s) are older than 14 days and will be skipped.`);
    if (pinned)
      warnings.push(`${pinned} pinned message(s) skipped (set include_pinned to delete them).`);
    return {
      summary: `delete ${targets.length} message(s) in ${fmtChannel(channel)}`,
      warnings,
      async execute() {
        const deleted = await channel.bulkDelete(
          targets.map((m) => m.id),
          true,
        );
        return `Deleted ${deleted.size} message(s) in ${fmtChannel(channel)}.`;
      },
    };
  },
});

const AUDIT_ACTIONS = Object.keys(AuditLogEvent).filter((k) => Number.isNaN(Number(k)));

interface AuditEntry {
  id: string;
  action: number;
  createdAt: Date;
  target: unknown;
  targetId: string | null;
  executor: User | null | (Pick<User, 'id' | 'bot'> & { username: string | null });
  executorId: string | null;
  reason: string | null;
  changes: readonly { key: string; old?: unknown; new?: unknown }[];
}

function fmtAuditEntry(e: AuditEntry): string {
  const action = AuditLogEvent[e.action] ?? String(e.action);
  const target =
    e.target && typeof e.target === 'object' && 'username' in e.target
      ? fmtUser(e.target as never)
      : e.target && typeof e.target === 'object' && 'name' in e.target
        ? `${String((e.target as { name: unknown }).name)} (${e.targetId})`
        : (e.targetId ?? 'n/a');
  const parts = [
    `[${ts(e.createdAt)}] ${e.executor ? fmtUser(e.executor) : (e.executorId ?? 'unknown')} · ${action} · target: ${target}`,
  ];
  if (e.reason) parts.push(`reason: ${truncate(e.reason, 200)}`);
  const changes = e.changes
    .slice(0, 4)
    .map((c) => `${c.key}: ${JSON.stringify(c.old ?? null)} → ${JSON.stringify(c.new ?? null)}`);
  if (changes.length) parts.push(`changes: ${truncate(changes.join('; '), 300)}`);
  return `${parts.join(' · ')} · entry ${e.id}`;
}

const getAuditLog = defineTool({
  name: 'get_audit_log',
  pack: 'moderation',
  title: 'Read the audit log',
  description:
    'Reads recent audit log entries (who did what, to whom, why), newest first. Filter by action (e.g. ' +
    'MemberBanAdd, MemberKick, MessageDelete, ChannelCreate, RoleUpdate, MemberRoleUpdate) and/or by the user ' +
    'who did it. Page with next_cursor.',
  input: {
    guild: guildField,
    action: z
      .string()
      .optional()
      .describe('Audit log action name, e.g. "MemberBanAdd", "MessageDelete".'),
    user: z
      .string()
      .optional()
      .describe('Only actions performed by this user (ID, mention or name).'),
    limit: z.number().int().min(1).max(100).optional().describe('Max entries (1-100, default 25).'),
    cursor: z.string().optional().describe('next_cursor from a previous call.'),
  },
  readOnly: true,
  permissions: ['View Audit Log'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['ViewAuditLog']);
    let type: number | undefined;
    if (args.action) {
      const key = AUDIT_ACTIONS.find(
        (a) => a.toLowerCase() === args.action!.replace(/[\s_]/g, '').toLowerCase(),
      );
      if (!key) {
        const near = AUDIT_ACTIONS.filter((a) =>
          a.toLowerCase().includes(args.action!.toLowerCase().slice(0, 5)),
        ).slice(0, 10);
        throw new GuildoraError(
          `Unknown audit log action "${args.action}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`,
        );
      }
      type = AuditLogEvent[key as keyof typeof AuditLogEvent];
    }
    const userId = args.user ? (await resolveUser(ctx.client, guild, args.user)).id : undefined;
    if (args.cursor && !isSnowflake(args.cursor)) throw new GuildoraError('Invalid cursor.');
    const limit = args.limit ?? 25;
    const logs = await guild.fetchAuditLogs({
      limit,
      ...(type !== undefined ? { type } : {}),
      ...(userId ? { user: userId } : {}),
      ...(args.cursor ? { before: args.cursor } : {}),
    });
    const entries = [...logs.entries.values()];
    return page(
      `${entries.length} audit log entr${entries.length === 1 ? 'y' : 'ies'} in ${guild.name}, newest first:`,
      entries.map((e) => fmtAuditEntry(e as AuditEntry)),
      entries.length === limit ? entries.at(-1)!.id : undefined,
    );
  },
});

export const moderationTools: AnyTool[] = [
  kickMember,
  banMember,
  unbanMember,
  listBans,
  timeoutMember,
  setNickname,
  bulkDelete,
  getAuditLog,
];
