import { z } from 'zod';
import type { Invite } from 'discord.js';
import { defineTool, type AnyTool } from '../types.js';
import { guildChannelArg, guildField, reasonField, requireBotPermissions } from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { formatDuration, parseDuration } from '../../discord/parse.js';
import { fmtChannel, fmtUser, page, ts } from '../../discord/format.js';

const MAX_AGE_MS = 7 * 86_400_000;

/** Extracts the code from "abc123", "discord.gg/abc123" or "https://discord.com/invite/abc123". */
export function inviteCode(input: string): string {
  const s = input.trim();
  const m =
    /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg)\/([\w-]+)/i.exec(s);
  const code = m ? m[1]! : s;
  if (!/^[\w-]{2,32}$/.test(code))
    throw new GuildoraError(`"${input}" is not an invite code or link.`);
  return code;
}

function inviteLine(i: Invite): string {
  const age = i.maxAge
    ? `expires ${i.expiresAt ? ts(i.expiresAt) : `after ${formatDuration(i.maxAge * 1000)}`}`
    : 'never expires';
  const uses = `${i.uses ?? '?'}${i.maxUses ? `/${i.maxUses}` : ''} uses`;
  return (
    `${i.url} · ${fmtChannel(i.channel ?? null)} · ${uses} · ${age}` +
    `${i.temporary ? ' · temporary membership' : ''} · by ${i.inviter ? fmtUser(i.inviter) : 'unknown'}`
  );
}

const listInvites = defineTool({
  name: 'list_invites',
  pack: 'invites',
  title: 'List invites',
  description:
    'Lists active invites of the server (or one channel) with uses, limits, expiry and creator.',
  input: {
    guild: guildField,
    channel: z.string().optional().describe('Only invites to this channel.'),
  },
  readOnly: true,
  permissions: ['Manage Server (Manage Channels for one channel)'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    let invites: Invite[];
    if (args.channel) {
      const ch = await guildChannelArg(ctx, guild.id, args.channel);
      if (!('fetchInvites' in ch))
        throw new GuildoraError(`${fmtChannel(ch)} cannot have invites.`);
      invites = [...(await ch.fetchInvites()).values()];
    } else {
      requireBotPermissions(guild, ['ManageGuild']);
      invites = [...(await guild.invites.fetch()).values()];
    }
    return page(`${invites.length} invite(s) in ${guild.name}:`, invites.map(inviteLine));
  },
});

const createInvite = defineTool({
  name: 'create_invite',
  pack: 'invites',
  title: 'Create an invite',
  description:
    'Creates an invite link to a channel. max_age like "1h", "1d" or "7d" (default "1d"; "0" = never expires), ' +
    'max_uses (0 = unlimited). unique: false may return an existing matching invite.',
  input: {
    channel: z.string().describe('Channel the invite opens (ID, mention, link or name).'),
    guild: guildField,
    max_age: z
      .string()
      .optional()
      .describe('Lifetime, e.g. "30m", "1d", "7d" (max), "0" for never.'),
    max_uses: z.number().int().min(0).max(100).optional().describe('0 = unlimited (default).'),
    temporary: z
      .boolean()
      .optional()
      .describe('Kick joiners when they go offline unless given a role.'),
    unique: z.boolean().optional().describe('Always create a new code (default true).'),
    reason: reasonField,
  },
  readOnly: false,
  permissions: ['Create Invite'],
  async run(args, ctx) {
    const ch = await guildChannelArg(ctx, args.guild, args.channel);
    if (!('createInvite' in ch)) throw new GuildoraError(`${fmtChannel(ch)} cannot have invites.`);
    requireBotPermissions(ch.guild, ['CreateInstantInvite'], ch);
    const ageMs = parseDuration(args.max_age ?? '1d', 'max_age');
    if (ageMs > MAX_AGE_MS)
      throw new GuildoraError('max_age can be at most "7d", or "0" for never.');
    const invite = await ch.createInvite({
      maxAge: Math.round(ageMs / 1000),
      maxUses: args.max_uses ?? 0,
      temporary: args.temporary ?? false,
      unique: args.unique ?? true,
      ...(args.reason ? { reason: args.reason } : {}),
    });
    return `Created invite ${inviteLine(invite)}`;
  },
});

const getInvite = defineTool({
  name: 'get_invite',
  pack: 'invites',
  title: 'Inspect an invite',
  description:
    "Shows what any invite code or link points to: server, channel, inviter, expiry and approximate member counts. Works for other servers' public invites too.",
  input: { invite: z.string().describe('Invite code or link, e.g. "discord.gg/abc123".') },
  readOnly: true,
  async run(args, ctx) {
    const invite = await ctx.client.fetchInvite(inviteCode(args.invite));
    const lines = [
      `Invite ${invite.url}`,
      `Server: ${invite.guild ? `${invite.guild.name} (${invite.guild.id})` : 'n/a'}`,
      `Channel: ${fmtChannel(invite.channel ?? null)}`,
      `Inviter: ${invite.inviter ? fmtUser(invite.inviter) : 'unknown'}`,
      `Expires: ${invite.expiresAt ? ts(invite.expiresAt) : 'never'}`,
      `Members: ~${invite.memberCount ?? '?'} (online ~${invite.presenceCount ?? '?'})`,
    ];
    if (invite.guild && ctx.client.guilds.cache.has(invite.guild.id))
      lines.push('The bot is in this server.');
    return lines.join('\n');
  },
});

const deleteInvite = defineTool({
  name: 'delete_invite',
  pack: 'invites',
  title: 'Revoke an invite',
  description:
    'Revokes an invite so the link stops working. Destructive: returns a dry run unless confirm is true.',
  input: { invite: z.string().describe('Invite code or link.'), reason: reasonField },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Channels or Manage Server'],
  async prepare(args, ctx) {
    const invite = await ctx.client.fetchInvite(inviteCode(args.invite));
    if (!invite.guild || !ctx.client.guilds.cache.has(invite.guild.id)) {
      throw new GuildoraError('That invite belongs to a server the bot is not in.');
    }
    return {
      summary: `revoke invite ${inviteLine(invite)} (server ${invite.guild.name})`,
      async execute() {
        await invite.delete(args.reason);
        return `Revoked invite ${invite.code}.`;
      },
    };
  },
});

export const inviteTools: AnyTool[] = [listInvites, createInvite, getInvite, deleteInvite];
