import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { Guild, GuildBasedChannel } from 'discord.js';
import { OverwriteType } from '../../discord/api.js';
import { defineTool } from '../types.js';
import { guildField } from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { channelKind } from '../../discord/resolve.js';
import { formatColor, permissionNames } from '../../discord/parse.js';
import { bytes, ts } from '../../discord/format.js';
import { dateStamp, safeFileName, writeExport } from './files.js';

export interface SnapOverwrite {
  id: string;
  type: 'role' | 'member';
  name: string | null;
  allow: string[];
  deny: string[];
}

export interface SnapChannel {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  slowmode: number;
  synced: boolean;
  overwrites: SnapOverwrite[];
}

export interface SnapRole {
  id: string;
  name: string;
  position: number;
  color: string;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
  permissions: string[];
}

export interface Snapshot {
  guildora_snapshot: 1;
  taken_at: string;
  guild: {
    id: string;
    name: string;
    owner_id: string;
    verification_level: number;
    features: string[];
    system_channel_id: string | null;
    rules_channel_id: string | null;
    member_count: number;
  };
  roles: SnapRole[];
  channels: SnapChannel[];
  emojis: { id: string; name: string | null; animated: boolean }[];
  stickers: { id: string; name: string }[];
}

function snapChannel(c: GuildBasedChannel, guild: Guild): SnapChannel {
  const overwrites: SnapOverwrite[] =
    'permissionOverwrites' in c
      ? c.permissionOverwrites.cache.map((o) => ({
          id: o.id,
          type: o.type === OverwriteType.Role ? 'role' : 'member',
          name:
            o.type === OverwriteType.Role
              ? (guild.roles.cache.get(o.id)?.name ?? null)
              : (guild.members.cache.get(o.id)?.user.username ?? null),
          allow: permissionNames(o.allow.bitfield),
          deny: permissionNames(o.deny.bitfield),
        }))
      : [];
  return {
    id: c.id,
    name: c.name,
    type: channelKind(c.type),
    parent_id: c.parentId ?? null,
    position: 'rawPosition' in c ? c.rawPosition : 0,
    topic: 'topic' in c ? (c.topic ?? null) : null,
    nsfw: 'nsfw' in c ? Boolean(c.nsfw) : false,
    slowmode: 'rateLimitPerUser' in c ? (c.rateLimitPerUser ?? 0) : 0,
    synced: 'permissionsLocked' in c ? Boolean(c.permissionsLocked) : false,
    overwrites,
  };
}

export function takeSnapshot(guild: Guild): Snapshot {
  return {
    guildora_snapshot: 1,
    taken_at: new Date().toISOString(),
    guild: {
      id: guild.id,
      name: guild.name,
      owner_id: guild.ownerId,
      verification_level: guild.verificationLevel,
      features: [...guild.features].sort(),
      system_channel_id: guild.systemChannelId,
      rules_channel_id: guild.rulesChannelId,
      member_count: guild.memberCount,
    },
    roles: [...guild.roles.cache.values()]
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        position: r.position,
        color: formatColor(r.colors.primaryColor),
        hoist: r.hoist,
        mentionable: r.mentionable,
        managed: r.managed,
        permissions: permissionNames(r.permissions.bitfield),
      })),
    channels: [...guild.channels.cache.values()]
      .filter((c) => !c.isThread())
      .sort(
        (a, b) =>
          ('rawPosition' in a ? a.rawPosition : 0) - ('rawPosition' in b ? b.rawPosition : 0),
      )
      .map((c) => snapChannel(c, guild)),
    emojis: [...guild.emojis.cache.values()].map((e) => ({
      id: e.id,
      name: e.name,
      animated: Boolean(e.animated),
    })),
    stickers: [...guild.stickers.cache.values()].map((s) => ({ id: s.id, name: s.name })),
  };
}

function listDiff(before: string[], after: string[]): string {
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  return [
    added.length ? `+${added.join(', +')}` : '',
    removed.length ? `-${removed.join(', -')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Human-readable differences between two snapshots of the same server. */
export function diffSnapshots(old: Snapshot, cur: Snapshot): string[] {
  const out: string[] = [];
  const g = (k: keyof Snapshot['guild'], label: string) => {
    if (JSON.stringify(old.guild[k]) !== JSON.stringify(cur.guild[k])) {
      out.push(
        `Server ${label}: ${JSON.stringify(old.guild[k])} → ${JSON.stringify(cur.guild[k])}`,
      );
    }
  };
  g('name', 'name');
  g('verification_level', 'verification level');
  g('features', 'features');
  g('system_channel_id', 'system channel');
  g('rules_channel_id', 'rules channel');
  if (old.guild.member_count !== cur.guild.member_count) {
    out.push(`Members: ${old.guild.member_count} → ${cur.guild.member_count}`);
  }

  const oldRoles = new Map(old.roles.map((r) => [r.id, r]));
  const curRoles = new Map(cur.roles.map((r) => [r.id, r]));
  for (const r of cur.roles) if (!oldRoles.has(r.id)) out.push(`Role added: @${r.name} (${r.id})`);
  for (const r of old.roles)
    if (!curRoles.has(r.id)) out.push(`Role removed: @${r.name} (${r.id})`);
  for (const r of cur.roles) {
    const o = oldRoles.get(r.id);
    if (!o) continue;
    const changes: string[] = [];
    if (o.name !== r.name) changes.push(`renamed from @${o.name}`);
    const perms = listDiff(o.permissions, r.permissions);
    if (perms) changes.push(`permissions ${perms}`);
    if (o.color !== r.color) changes.push(`color ${o.color} → ${r.color}`);
    if (o.hoist !== r.hoist) changes.push(r.hoist ? 'now hoisted' : 'no longer hoisted');
    if (o.mentionable !== r.mentionable)
      changes.push(r.mentionable ? 'now mentionable' : 'no longer mentionable');
    if (changes.length) out.push(`Role @${r.name} (${r.id}): ${changes.join('; ')}`);
  }
  const moved = cur.roles.filter(
    (r) => oldRoles.get(r.id) && oldRoles.get(r.id)!.position !== r.position,
  ).length;
  if (moved) out.push(`${moved} role(s) changed position in the role list.`);

  const oldCh = new Map(old.channels.map((c) => [c.id, c]));
  const curCh = new Map(cur.channels.map((c) => [c.id, c]));
  const chName = (id: string | null, map: Map<string, SnapChannel>) =>
    id ? (map.get(id)?.name ?? id) : 'no category';
  for (const c of cur.channels) {
    if (!oldCh.has(c.id))
      out.push(`Channel added: #${c.name} (${c.id}) [${c.type}] in ${chName(c.parent_id, curCh)}`);
  }
  for (const c of old.channels) {
    if (!curCh.has(c.id)) out.push(`Channel removed: #${c.name} (${c.id}) [${c.type}]`);
  }
  for (const c of cur.channels) {
    const o = oldCh.get(c.id);
    if (!o) continue;
    const changes: string[] = [];
    if (o.name !== c.name) changes.push(`renamed from #${o.name}`);
    if (o.parent_id !== c.parent_id)
      changes.push(`moved from ${chName(o.parent_id, oldCh)} to ${chName(c.parent_id, curCh)}`);
    if (o.topic !== c.topic) changes.push('topic changed');
    if (o.nsfw !== c.nsfw) changes.push(c.nsfw ? 'now NSFW' : 'no longer NSFW');
    if (o.slowmode !== c.slowmode) changes.push(`slowmode ${o.slowmode}s → ${c.slowmode}s`);
    const oldOw = new Map(o.overwrites.map((w) => [w.id, w]));
    const curOw = new Map(c.overwrites.map((w) => [w.id, w]));
    const label = (w: SnapOverwrite) => `${w.type} ${w.name ?? w.id}`;
    for (const w of c.overwrites) {
      const prev = oldOw.get(w.id);
      if (!prev)
        changes.push(
          `overwrite added for ${label(w)} (allow ${w.allow.join(',') || '-'}; deny ${w.deny.join(',') || '-'})`,
        );
      else {
        const a = listDiff(prev.allow, w.allow);
        const d = listDiff(prev.deny, w.deny);
        if (a || d)
          changes.push(
            `overwrite for ${label(w)}: ${[a && `allow ${a}`, d && `deny ${d}`].filter(Boolean).join('; ')}`,
          );
      }
    }
    for (const w of o.overwrites)
      if (!curOw.has(w.id)) changes.push(`overwrite removed for ${label(w)}`);
    if (changes.length) out.push(`Channel #${c.name} (${c.id}): ${changes.join('; ')}`);
  }

  const oldEmoji = new Set(old.emojis.map((e) => e.id));
  const curEmoji = new Set(cur.emojis.map((e) => e.id));
  const emojiAdded = cur.emojis.filter((e) => !oldEmoji.has(e.id)).length;
  const emojiRemoved = old.emojis.filter((e) => !curEmoji.has(e.id)).length;
  if (emojiAdded || emojiRemoved) out.push(`Emoji: ${emojiAdded} added, ${emojiRemoved} removed.`);
  return out;
}

function isSnapshot(x: unknown): x is Snapshot {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { guildora_snapshot?: unknown }).guildora_snapshot === 1
  );
}

const MAX_DIFF_LINES = 150;

export const serverSnapshot = defineTool({
  name: 'server_snapshot',
  pack: 'insights',
  title: 'Snapshot or compare server structure',
  description:
    "Saves the server's structure as JSON (settings, roles with permissions, categories and channels with " +
    'their permission overwrites, emoji) to GUILDORA_EXPORT_DIR, e.g. before reorganising. With compare_with ' +
    '(a previous snapshot file), it also lists everything that changed since then. Messages are not included.',
  input: {
    guild: guildField,
    compare_with: z
      .string()
      .optional()
      .describe('Path of an earlier snapshot file to compare against.'),
    save: z.boolean().optional().describe('Write the new snapshot file (default true).'),
    path: z.string().optional().describe('File path (relative to the export folder, or absolute).'),
  },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    if (ctx.intents.members) {
      // Load members named in overwrites so the snapshot shows names, not just IDs.
      const ids = new Set<string>();
      for (const c of guild.channels.cache.values()) {
        if ('permissionOverwrites' in c) {
          for (const o of c.permissionOverwrites.cache.values())
            if (o.type === OverwriteType.Member) ids.add(o.id);
        }
      }
      if (ids.size)
        await guild.members.fetch({ user: [...ids].slice(0, 100) }).catch(() => undefined);
    }
    const snap = takeSnapshot(guild);
    const lines = [
      `Snapshot of ${guild.name}: ${snap.roles.length} roles, ${snap.channels.length} channels and categories, ${snap.emojis.length} emoji, ${snap.stickers.length} stickers.`,
    ];

    if (args.compare_with) {
      if (ctx.config.transport !== 'stdio')
        throw new GuildoraError(
          'compare_with reads a local file, which is only possible in stdio mode.',
        );
      const file = isAbsolute(args.compare_with)
        ? args.compare_with
        : resolve(ctx.config.exportDir, args.compare_with);
      let old: unknown;
      try {
        old = JSON.parse(await readFile(file, 'utf8'));
      } catch (e) {
        throw new GuildoraError(
          `Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!isSnapshot(old)) throw new GuildoraError(`${file} is not a Guildora server snapshot.`);
      if (old.guild.id !== guild.id) {
        throw new GuildoraError(`${file} is a snapshot of "${old.guild.name}", not ${guild.name}.`);
      }
      const diff = diffSnapshots(old, snap);
      lines.push(
        diff.length
          ? `${diff.length} change(s) since ${ts(new Date(old.taken_at))}:`
          : `No changes since ${ts(new Date(old.taken_at))}.`,
        ...diff.slice(0, MAX_DIFF_LINES).map((d) => `- ${d}`),
      );
      if (diff.length > MAX_DIFF_LINES) lines.push(`… and ${diff.length - MAX_DIFF_LINES} more.`);
    }

    if (args.save ?? true) {
      const json = JSON.stringify(snap, null, 2);
      const path = await writeExport(
        ctx,
        `snapshot-${safeFileName(guild.name)}-${dateStamp()}.json`,
        json,
        args.path,
      );
      lines.push(
        path
          ? `Saved to ${path} (${bytes(Buffer.byteLength(json))}). Compare later with compare_with: "${path}".`
          : 'Not saved: files are only written in stdio mode.',
      );
    }
    return lines.join('\n');
  },
});
