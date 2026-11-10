import { z } from 'zod';
import type { GuildMember } from 'discord.js';
import { defineTool } from '../types.js';
import { cursorField, guildField, limitField, memberField } from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { resolveMember, resolveRole } from '../../discord/resolve.js';
import { isSnowflake, permissionNames } from '../../discord/parse.js';
import { fmtChannel, fmtMember, fmtRole, page, ts } from '../../discord/format.js';

function memberLine(m: GuildMember): string {
  const roles = [...m.roles.cache.values()]
    .filter((r) => r.id !== m.guild.id)
    .sort((a, b) => b.position - a.position);
  const shown = roles.slice(0, 5).map((r) => `@${r.name}`);
  if (roles.length > 5) shown.push(`+${roles.length - 5}`);
  const extra = [shown.length ? `roles: ${shown.join(', ')}` : 'no roles'];
  if (m.joinedAt) extra.push(`joined ${ts(m.joinedAt).slice(0, 10)}`);
  if (m.communicationDisabledUntilTimestamp && m.communicationDisabledUntilTimestamp > Date.now()) {
    extra.push(`timed out until ${ts(m.communicationDisabledUntilTimestamp)}`);
  }
  return `${fmtMember(m)} · ${extra.join(' · ')}`;
}

const MAX_ROLE_SCAN_PAGES = 10;

export const listMembers = defineTool({
  name: 'list_members',
  pack: 'core',
  title: 'List or search members',
  description:
    'Lists server members with IDs, roles and join date. With "query", searches usernames and nicknames that ' +
    'start with the text (no special intent needed). Without a query it pages through all members, which ' +
    'needs the Server Members intent. "role" keeps only members with that role. Use get_member for one member.',
  input: {
    guild: guildField,
    query: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Username or nickname prefix to search for.'),
    role: z.string().optional().describe('Only members with this role (ID, mention or name).'),
    limit: limitField(50, 100),
    cursor: cursorField,
  },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const limit = args.limit ?? 50;
    const role = args.role ? resolveRole(guild, args.role) : undefined;
    const hasRole = (m: GuildMember) => !role || m.roles.cache.has(role.id);

    if (args.query) {
      const found = await guild.members.search({ query: args.query.replace(/^@/, ''), limit: 100 });
      const matches = [...found.values()].filter(hasRole).slice(0, limit);
      return page(
        `${matches.length} member(s) matching "${args.query}"${role ? ` with ${fmtRole(role)}` : ''} in ${guild.name}:`,
        matches.map(memberLine),
      );
    }

    if (!ctx.intents.members) {
      throw new GuildoraError(
        'Listing all members needs the Server Members intent, which is off for this bot. Pass "query" to ' +
          'search by name instead, or enable it: Developer Portal > your app > Bot > Server Members Intent.',
      );
    }
    if (args.cursor !== undefined && !isSnowflake(args.cursor)) {
      throw new GuildoraError(
        'Invalid cursor: pass the next_cursor value from the previous result.',
      );
    }

    const out: GuildMember[] = [];
    const pageSize = role ? 1000 : limit;
    let after = args.cursor;
    let exhausted = false;
    for (let i = 0; i < (role ? MAX_ROLE_SCAN_PAGES : 1); i++) {
      const batch = await guild.members.list({ limit: pageSize, ...(after ? { after } : {}) });
      const sorted = [...batch.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      let stoppedEarly = false;
      for (const [idx, m] of sorted.entries()) {
        after = m.id;
        if (hasRole(m)) out.push(m);
        if (out.length >= limit) {
          stoppedEarly = idx < sorted.length - 1;
          break;
        }
      }
      if (batch.size < pageSize && !stoppedEarly) {
        exhausted = true;
        break;
      }
      if (out.length >= limit) break;
    }
    return page(
      `${out.length} member(s) of ${guild.name} (${guild.memberCount} total)${role ? ` with ${fmtRole(role)}` : ''}:`,
      out.map(memberLine),
      exhausted ? undefined : after,
    );
  },
});

export const getMember = defineTool({
  name: 'get_member',
  pack: 'core',
  title: 'Get member details',
  description:
    'Full details of one server member: names, account and join dates, all roles, timeout, voice channel, ' +
    'boosting, key permissions, and whether the bot can kick/ban/timeout them (role hierarchy).',
  input: { member: memberField(), guild: guildField },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const m = await resolveMember(guild, args.member);
    const roles = [...m.roles.cache.values()]
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position);
    const lines = [
      `${fmtMember(m)}`,
      `Username: ${m.user.username} · Global name: ${m.user.globalName ?? 'none'} · Nickname: ${m.nickname ?? 'none'}`,
      `Account created: ${ts(m.user.createdAt)} · Joined: ${ts(m.joinedAt)}`,
      `Roles (${roles.length}): ${roles.map(fmtRole).join(', ') || 'none'}`,
    ];
    if (
      m.communicationDisabledUntilTimestamp &&
      m.communicationDisabledUntilTimestamp > Date.now()
    ) {
      lines.push(`Timed out until: ${ts(m.communicationDisabledUntilTimestamp)}`);
    }
    if (m.voice.channel) {
      lines.push(
        `In voice: ${fmtChannel(m.voice.channel)}${m.voice.serverMute ? ' (server muted)' : ''}${m.voice.serverDeaf ? ' (server deafened)' : ''}`,
      );
    }
    if (m.premiumSince) lines.push(`Boosting since: ${ts(m.premiumSince)}`);
    if (m.pending) lines.push('Pending: has not passed membership screening');
    const perms = permissionNames(m.permissions.bitfield);
    lines.push(
      `Permissions: ${perms.length > 12 ? `${perms.slice(0, 12).join(', ')} +${perms.length - 12} more` : perms.join(', ') || 'none'}`,
    );
    lines.push(
      `Bot can: kick ${m.kickable ? 'yes' : 'no'}, ban ${m.bannable ? 'yes' : 'no'}, timeout ${m.moderatable ? 'yes' : 'no'}, manage nickname/roles ${m.manageable ? 'yes' : 'no'}`,
    );
    return lines.join('\n');
  },
});
