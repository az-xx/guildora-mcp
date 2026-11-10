import { z } from 'zod';
import type { GuildBasedChannel, GuildMember, PermissionOverwrites, Role } from 'discord.js';
import { ChannelType, OverwriteType, PermissionFlagsBits } from '../../discord/api.js';
import { defineTool } from '../types.js';
import { guildChannelArg, guildField } from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { resolveMember, resolveRole } from '../../discord/resolve.js';
import { permissionNames } from '../../discord/parse.js';
import { fmtChannel, fmtMember, fmtRole } from '../../discord/format.js';

type Perm = keyof typeof PermissionFlagsBits;

const TEXT_PERMS: Perm[] = [
  'ViewChannel',
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'ReadMessageHistory',
  'AttachFiles',
  'EmbedLinks',
  'AddReactions',
  'MentionEveryone',
  'ManageMessages',
  'PinMessages',
  'ManageThreads',
  'ManageChannels',
  'ManageRoles',
];
const VOICE_PERMS: Perm[] = [
  'ViewChannel',
  'Connect',
  'Speak',
  'Stream',
  'UseVAD',
  'SendMessages',
  'MuteMembers',
  'DeafenMembers',
  'MoveMembers',
  'ManageChannels',
];

const NO_VIEW =
  'Without ViewChannel they cannot see the channel at all, so the other permissions have no effect here.';

/** The permissions worth showing for a channel type. */
export function keyPerms(type: ChannelType): Perm[] {
  return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice
    ? VOICE_PERMS
    : TEXT_PERMS;
}

/** "ViewChannel ✓ · SendMessages ✗ …" for the key permissions. */
export function permLine(has: (p: bigint) => boolean, perms: Perm[]): string {
  return perms.map((p) => `${p} ${has(PermissionFlagsBits[p]) ? 'yes' : 'NO'}`).join(' · ');
}

function overwriteText(o: PermissionOverwrites, label: string): string {
  const allow = permissionNames(o.allow.bitfield);
  const deny = permissionNames(o.deny.bitfield);
  return `${label}: allow ${allow.join(', ') || '-'}; deny ${deny.join(', ') || '-'}`;
}

/** Overwrites on the channel that apply to this member or role, in Discord's evaluation order. */
function applicableOverwrites(
  channel: GuildBasedChannel,
  roles: Role[],
  member?: GuildMember,
): string[] {
  if (!('permissionOverwrites' in channel)) return [];
  const cache = channel.permissionOverwrites.cache;
  const out: string[] = [];
  const everyone = cache.get(channel.guild.id);
  if (everyone) out.push(overwriteText(everyone, '@everyone'));
  for (const r of roles) {
    const o = cache.get(r.id);
    if (o && r.id !== channel.guild.id) out.push(overwriteText(o, fmtRole(r)));
  }
  if (member) {
    const o = cache.get(member.id);
    if (o && o.type === OverwriteType.Member) out.push(overwriteText(o, 'member-specific'));
  }
  return out;
}

export const checkAccess = defineTool({
  name: 'check_access',
  pack: 'core',
  title: 'Check who can access a channel',
  description:
    'Explains channel access after roles and overwrites are combined. With "member" or "role": what they can ' +
    'and cannot do there, and which overwrites cause it. Without either: who can see the channel (roles, ' +
    'specific members, and a member count when available). Use it to check private ticket or staff channels.',
  input: {
    channel: z.string().describe('Channel, category or thread: ID, <#mention>, link, or name.'),
    member: z.string().optional().describe('Check this member (ID, mention or name).'),
    role: z.string().optional().describe('Check this role (ID, mention or name).'),
    guild: guildField,
  },
  readOnly: true,
  async run(args, ctx) {
    if (args.member && args.role)
      throw new GuildoraError('Pass either "member" or "role", not both.');
    const target = await guildChannelArg(ctx, args.guild, args.channel);
    const guild = target.guild;
    // Threads inherit their parent's permissions (private threads also need membership).
    const channel = (target.isThread() ? target.parent : target) as GuildBasedChannel | null;
    if (!channel) throw new GuildoraError(`The parent of ${fmtChannel(target)} is not available.`);
    const header = [
      `Access to ${fmtChannel(target)}${target.isThread() ? ` (permissions come from ${fmtChannel(channel)})` : ''}:`,
    ];
    if (target.isThread() && target.type === ChannelType.PrivateThread) {
      header.push(
        'This is a private thread: only its members and people with Manage Threads can see it.',
      );
    }
    const perms = keyPerms(channel.type);

    if (args.member) {
      const m = await resolveMember(guild, args.member);
      const p = channel.permissionsFor(m);
      const roles = [...m.roles.cache.values()].sort((a, b) => b.position - a.position);
      const lines = [...header, `Member: ${fmtMember(m)}`];
      if (m.id === guild.ownerId) lines.push('They own the server: they can do everything.');
      else if (m.permissions.has(PermissionFlagsBits.Administrator)) {
        lines.push(
          `They have Administrator (via ${roles
            .filter((r) => r.permissions.has(PermissionFlagsBits.Administrator))
            .map(fmtRole)
            .join(', ')}): overwrites do not apply.`,
        );
      }
      lines.push(permLine((b) => Boolean(p?.has(b)), perms));
      if (!p?.has(PermissionFlagsBits.ViewChannel)) lines.push(NO_VIEW);
      const ow = applicableOverwrites(channel, roles, m);
      lines.push(
        ow.length
          ? `Overwrites that apply:\n${ow.map((o) => `- ${o}`).join('\n')}`
          : 'No overwrites apply; access comes from their roles only.',
      );
      return lines.join('\n');
    }

    if (args.role) {
      const r = resolveRole(guild, args.role);
      const p = channel.permissionsFor(r);
      const lines = [
        ...header,
        `Role: ${fmtRole(r)} (alone, without other roles a member may have)`,
      ];
      if (r.permissions.has(PermissionFlagsBits.Administrator))
        lines.push('This role has Administrator: overwrites do not apply.');
      lines.push(permLine((b) => p.has(b), perms));
      if (!p.has(PermissionFlagsBits.ViewChannel)) lines.push(NO_VIEW);
      const ow = applicableOverwrites(channel, r.id === guild.id ? [] : [r]);
      lines.push(
        ow.length
          ? `Overwrites that apply:\n${ow.map((o) => `- ${o}`).join('\n')}`
          : 'No overwrites apply.',
      );
      return lines.join('\n');
    }

    const view = PermissionFlagsBits.ViewChannel;
    const roles = [...guild.roles.cache.values()].sort((a, b) => b.position - a.position);
    const everyoneSees = channel.permissionsFor(guild.roles.everyone).has(view);
    const lines = [...header];
    if (everyoneSees) {
      lines.push(
        '@everyone can see it: it is visible to all members (unless a member-specific overwrite denies them).',
      );
    } else {
      const admin = roles
        .filter((r) => r.permissions.has(PermissionFlagsBits.Administrator))
        .map(fmtRole);
      const viewers = roles
        .filter(
          (r) =>
            r.id !== guild.id &&
            !r.permissions.has(PermissionFlagsBits.Administrator) &&
            channel.permissionsFor(r).has(view),
        )
        .map(fmtRole);
      lines.push('@everyone cannot see it.');
      lines.push(`Roles that can see it: ${viewers.join(', ') || 'none'}.`);
      lines.push(`Always (Administrator): ${admin.join(', ') || 'none'}, and the server owner.`);
    }
    if ('permissionOverwrites' in channel) {
      const memberOws = channel.permissionOverwrites.cache.filter(
        (o) => o.type === OverwriteType.Member,
      );
      if (memberOws.size) {
        await guild.members.fetch({ user: [...memberOws.keys()] }).catch(() => undefined);
        const names = memberOws.map((o) => {
          const m = guild.members.cache.get(o.id);
          const who = m ? fmtMember(m) : o.id;
          return `${who} ${o.allow.has(view) ? '(allowed)' : o.deny.has(view) ? '(denied)' : '(other permissions)'}`;
        });
        lines.push(`Member-specific overwrites: ${names.join(', ')}.`);
      }
    }
    if (ctx.intents.members && guild.memberCount <= 5000) {
      const all = await guild.members.fetch();
      const can = all.filter((m) => channel.permissionsFor(m)?.has(view));
      const people = can.filter((m) => !m.user.bot);
      lines.push(
        `${people.size} of ${all.filter((m) => !m.user.bot).size} people can see it` +
          `${people.size <= 15 ? `: ${people.map(fmtMember).join(', ')}` : ''} (plus ${can.size - people.size} bot(s)).`,
      );
    }
    return lines.join('\n');
  },
});
