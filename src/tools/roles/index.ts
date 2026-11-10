import { z } from 'zod';
import type { Guild, GuildMember, Role } from 'discord.js';
import { PermissionFlagsBits } from '../../discord/api.js';
import { defineTool, type AnyTool } from '../types.js';
import {
  botMember,
  guildField,
  memberField,
  reasonField,
  requireBotPermissions,
  requireRoleBelowBot,
  roleField,
} from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { resolveMember, resolveRole } from '../../discord/resolve.js';
import {
  formatColor,
  parseColor,
  parsePermissions,
  permissionBits,
  permissionNames,
} from '../../discord/parse.js';
import { fmtMember, fmtRole } from '../../discord/format.js';

const permissionsField = (what: string) =>
  z
    .array(z.string())
    .optional()
    .describe(
      `${what}: Discord permission names, e.g. ["ViewChannel", "SendMessages", "ManageMessages"].`,
    );

/** The bot cannot grant permissions it does not have itself (unless it is an Administrator). */
function requireBotHas(guild: Guild, bits: bigint): void {
  const me = botMember(guild);
  if (me.permissions.has(PermissionFlagsBits.Administrator)) return;
  const missing = permissionNames(bits & ~me.permissions.bitfield);
  if (missing.length) {
    throw new GuildoraError(
      `The bot cannot grant permissions it does not have: ${missing.join(', ')}.`,
    );
  }
}

function describeRole(r: Role): string {
  const perms = permissionNames(r.permissions.bitfield);
  return (
    `${fmtRole(r)} · pos ${r.position} · ${formatColor(r.colors.primaryColor)}` +
    `${r.hoist ? ' · hoisted' : ''}${r.mentionable ? ' · mentionable' : ''}` +
    ` · perms: ${perms.length ? perms.join(', ') : 'none'}`
  );
}

const createRole = defineTool({
  name: 'create_role',
  pack: 'roles',
  title: 'Create a role',
  description:
    'Creates a role with a name, color ("#5865F2" or a name like "Blurple"), permission names, and display ' +
    'options. New roles appear just above @everyone unless position is set. Returns the new role ID.',
  input: {
    name: z.string().min(1).max(100),
    guild: guildField,
    color: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Hex like "#5865F2", or a color name.'),
    permissions: permissionsField('Permissions to grant'),
    hoist: z.boolean().optional().describe('Show members separately in the member list.'),
    mentionable: z.boolean().optional().describe('Allow anyone to @mention the role.'),
    position: z.number().int().min(1).optional().describe('Position (1 = just above @everyone).'),
    reason: reasonField,
  },
  readOnly: false,
  permissions: ['Manage Roles'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['ManageRoles']);
    const bits = args.permissions ? permissionBits(parsePermissions(args.permissions)) : 0n;
    requireBotHas(guild, bits);
    const role = await guild.roles.create({
      name: args.name,
      permissions: bits,
      ...(args.color !== undefined ? { colors: { primaryColor: parseColor(args.color) } } : {}),
      ...(args.hoist !== undefined ? { hoist: args.hoist } : {}),
      ...(args.mentionable !== undefined ? { mentionable: args.mentionable } : {}),
      ...(args.position !== undefined ? { position: args.position } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
    return `Created role ${describeRole(role)}`;
  },
});

const editRole = defineTool({
  name: 'edit_role',
  pack: 'roles',
  title: 'Edit a role',
  description:
    'Changes a role\'s name, color, hoist, mentionable flag, position or permissions. "permissions" replaces ' +
    'the whole set; add_permissions/remove_permissions change only those. Works on @everyone for permissions. ' +
    'The bot can only edit roles below its highest role.',
  input: {
    role: roleField(),
    guild: guildField,
    name: z.string().min(1).max(100).optional(),
    color: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Hex like "#5865F2", a color name, or "none".'),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    position: z.number().int().min(1).optional(),
    permissions: permissionsField('Replace all permissions with'),
    add_permissions: permissionsField('Permissions to add'),
    remove_permissions: permissionsField('Permissions to remove'),
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Manage Roles'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['ManageRoles']);
    const role = resolveRole(guild, args.role);
    const isEveryone = role.id === guild.id;
    if (!isEveryone) requireRoleBelowBot(guild, role, 'edited');
    if (
      isEveryone &&
      (args.name || args.color !== undefined || args.hoist !== undefined || args.position)
    ) {
      throw new GuildoraError(
        '@everyone can only have its permissions or mentionable flag changed.',
      );
    }
    if (args.permissions && (args.add_permissions || args.remove_permissions)) {
      throw new GuildoraError(
        'Use either permissions (replace) or add_permissions/remove_permissions, not both.',
      );
    }
    let bits: bigint | undefined;
    if (args.permissions) bits = permissionBits(parsePermissions(args.permissions));
    if (args.add_permissions || args.remove_permissions) {
      bits = role.permissions.bitfield;
      if (args.add_permissions)
        bits |= permissionBits(parsePermissions(args.add_permissions, 'add_permissions'));
      if (args.remove_permissions)
        bits &= ~permissionBits(parsePermissions(args.remove_permissions, 'remove_permissions'));
    }
    if (bits !== undefined) requireBotHas(guild, bits & ~role.permissions.bitfield);
    const edit = {
      ...(args.name ? { name: args.name } : {}),
      ...(args.color !== undefined ? { colors: { primaryColor: parseColor(args.color) } } : {}),
      ...(args.hoist !== undefined ? { hoist: args.hoist } : {}),
      ...(args.mentionable !== undefined ? { mentionable: args.mentionable } : {}),
      ...(args.position !== undefined ? { position: args.position } : {}),
      ...(bits !== undefined ? { permissions: bits } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    };
    if (Object.keys(edit).filter((k) => k !== 'reason').length === 0) {
      throw new GuildoraError('Nothing to change: pass at least one field to edit.');
    }
    const updated = await role.edit(edit);
    return `Updated role ${describeRole(updated)}`;
  },
});

const deleteRole = defineTool({
  name: 'delete_role',
  pack: 'roles',
  title: 'Delete a role',
  description:
    'Permanently deletes a role; members lose it. Destructive: returns a dry run (with how many members have ' +
    'it, when known) unless confirm is true.',
  input: { role: roleField(), guild: guildField, reason: reasonField },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Roles'],
  async prepare(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['ManageRoles']);
    const role = resolveRole(guild, args.role);
    if (role.id === guild.id) throw new GuildoraError('@everyone cannot be deleted.');
    requireRoleBelowBot(guild, role, 'deleted');
    const warnings: string[] = [];
    // Members are not cached at startup; load them (small servers only) for an accurate count.
    if (ctx.intents.members && guild.memberCount <= 5000) {
      await guild.members.fetch();
      warnings.push(`${role.members.size} member(s) have this role.`);
    }
    if (role.permissions.has(PermissionFlagsBits.Administrator))
      warnings.push('This role has Administrator.');
    return {
      summary: `delete role ${fmtRole(role)} in ${guild.name}`,
      warnings,
      async execute() {
        await role.delete(args.reason);
        return `Deleted role @${role.name} (${role.id}).`;
      },
    };
  },
});

const rolesField = z
  .array(z.string())
  .min(1)
  .max(20)
  .describe('Roles: IDs, <@&mentions> or names, e.g. ["Moderators"].');

async function memberAndRoles(
  guild: Guild,
  memberInput: string,
  roleInputs: string[],
  action: string,
): Promise<{ member: GuildMember; roles: Role[] }> {
  requireBotPermissions(guild, ['ManageRoles']);
  const member = await resolveMember(guild, memberInput);
  const roles = roleInputs.map((r) => resolveRole(guild, r));
  for (const r of roles) {
    if (r.id === guild.id)
      throw new GuildoraError('@everyone is implicit and cannot be added or removed.');
    requireRoleBelowBot(guild, r, action);
  }
  return { member, roles };
}

const addMemberRole = defineTool({
  name: 'add_member_role',
  pack: 'roles',
  title: 'Give roles to a member',
  description: 'Gives one or more roles to a member. Roles they already have are skipped.',
  input: { member: memberField(), roles: rolesField, guild: guildField, reason: reasonField },
  readOnly: false,
  idempotent: true,
  permissions: ['Manage Roles'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const { member, roles } = await memberAndRoles(guild, args.member, args.roles, 'assigned');
    const toAdd = roles.filter((r) => !member.roles.cache.has(r.id));
    if (toAdd.length) await member.roles.add(toAdd, args.reason);
    const skipped = roles.filter((r) => !toAdd.includes(r));
    return (
      `${toAdd.length ? `Gave ${toAdd.map(fmtRole).join(', ')} to ${fmtMember(member)}.` : `${fmtMember(member)} already has those roles.`}` +
      `${skipped.length && toAdd.length ? ` Already had: ${skipped.map(fmtRole).join(', ')}.` : ''}`
    );
  },
});

const removeMemberRole = defineTool({
  name: 'remove_member_role',
  pack: 'roles',
  title: 'Take roles from a member',
  description: 'Removes one or more roles from a member. Roles they do not have are skipped.',
  input: { member: memberField(), roles: rolesField, guild: guildField, reason: reasonField },
  readOnly: false,
  idempotent: true,
  permissions: ['Manage Roles'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const { member, roles } = await memberAndRoles(guild, args.member, args.roles, 'removed');
    const toRemove = roles.filter((r) => member.roles.cache.has(r.id));
    if (toRemove.length) await member.roles.remove(toRemove, args.reason);
    return toRemove.length
      ? `Removed ${toRemove.map(fmtRole).join(', ')} from ${fmtMember(member)}.`
      : `${fmtMember(member)} has none of those roles.`;
  },
});

export const roleTools: AnyTool[] = [
  createRole,
  editRole,
  deleteRole,
  addMemberRole,
  removeMemberRole,
];
