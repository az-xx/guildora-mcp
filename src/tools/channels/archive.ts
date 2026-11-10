import { z } from 'zod';
import type { CategoryChannel, Guild, GuildBasedChannel, Message, TextChannel } from 'discord.js';
import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  snowflakeTimestamp,
} from '../../discord/api.js';
import { defineTool } from '../types.js';
import {
  botMember,
  channelArg,
  guildChannelArg,
  guildField,
  reasonField,
  requireBotPermissions,
} from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import {
  formatDurationShort,
  parseDuration,
  parseOffsetCursor,
  permissionNames,
} from '../../discord/parse.js';
import { fmtChannel, page, slicePage, ts } from '../../discord/format.js';
import { mapLimit } from '../core/activity.js';

/** Discord limits: 500 channels per server (categories included, threads not), 50 per category. */
export const SERVER_CHANNEL_LIMIT = 500;
export const CATEGORY_CHANNEL_LIMIT = 50;

const INACTIVE_KINDS = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);
const VOICE_KINDS = new Set<number>([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

/** Channels that count toward the 500-channel limit. */
export function countedChannels(guild: Guild): number {
  return guild.channels.cache.filter((c) => !c.isThread()).size;
}

function lastAt(c: GuildBasedChannel): { at: number; never: boolean } {
  const id = 'lastMessageId' in c ? c.lastMessageId : null;
  if (id) return { at: snowflakeTimestamp(id), never: false };
  return { at: c.createdTimestamp ?? 0, never: true };
}

const MAX_PEOPLE_CHECKS = 150;

export const listInactiveChannels = defineTool({
  name: 'list_inactive_channels',
  pack: 'channels',
  title: 'Find inactive channels',
  description:
    'Lists channels with no messages for a while ("30d" by default), longest idle first, and how many of ' +
    "Discord's 500 channels the server uses. people_only also treats channels where only bots wrote as " +
    'inactive. Use it to clean up before archive_channel or delete_channel.',
  input: {
    guild: guildField,
    inactive_for: z
      .string()
      .optional()
      .describe('Idle at least this long: "14d", "30d" (default), "90d".'),
    category: z.string().optional().describe('Only channels in this category (ID or name).'),
    include_voice: z
      .boolean()
      .optional()
      .describe('Also check voice and stage channels (default false).'),
    people_only: z
      .boolean()
      .optional()
      .describe('Ignore bot messages when judging activity (slower).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max channels (1-200, default 50).'),
    cursor: z.string().optional().describe('next_cursor from a previous call.'),
  },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const idleMs = parseDuration(args.inactive_for ?? '30d', 'inactive_for');
    const threshold = Date.now() - idleMs;
    const categoryId = args.category
      ? (await channelArg(ctx, guild.id, args.category, { kinds: ['category'], label: 'category' }))
          .id
      : undefined;
    const pool = [...guild.channels.cache.values()].filter(
      (c) =>
        !c.isThread() &&
        (INACTIVE_KINDS.has(c.type) || (args.include_voice && VOICE_KINDS.has(c.type))) &&
        (!categoryId || c.parentId === categoryId),
    );

    type Row = { c: GuildBasedChannel; at: number; never: boolean; note?: string };
    const rows: Row[] = [];
    const recent: GuildBasedChannel[] = [];
    for (const c of pool) {
      const { at, never } = lastAt(c);
      if (at < threshold) rows.push({ c, at, never });
      else if (args.people_only && c.isTextBased()) recent.push(c);
    }

    let unchecked = 0;
    if (args.people_only && recent.length) {
      const toCheck = recent.slice(0, MAX_PEOPLE_CHECKS);
      unchecked = recent.length - toCheck.length;
      const results = await mapLimit(toCheck, 5, async (c) => {
        if (!c.isTextBased()) return undefined;
        const msgs = [
          ...(
            await c.messages.fetch({ limit: 50 }).catch(() => new Map<string, Message>())
          ).values(),
        ];
        const person = msgs
          .filter((m) => !m.author.bot)
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
        if (person && person.createdTimestamp >= threshold) return undefined;
        const at = person?.createdTimestamp ?? c.createdTimestamp ?? 0;
        return {
          c,
          at,
          never: !person,
          note: person
            ? `only bots since; last person ${ts(person.createdAt)}`
            : 'only bot messages in the latest 50',
        } as Row;
      });
      rows.push(...results.filter((r): r is Row => Boolean(r)));
    }

    rows.sort((a, b) => a.at - b.at);
    const { items, next } = slicePage(rows, parseOffsetCursor(args.cursor), args.limit ?? 50);
    const lines = items.map(({ c, at, never, note }) => {
      const where = c.parent ? ` in ${fmtChannel(c.parent)}` : '';
      const idle = formatDurationShort(Date.now() - at);
      const detail = note ?? (never ? `no messages; created ${ts(at)}` : `last message ${ts(at)}`);
      return `${fmtChannel(c)}${where} · idle ${idle} · ${detail}`;
    });
    const used = countedChannels(guild);
    const footer = [
      `The server uses ${used}/${SERVER_CHANNEL_LIMIT} channels (categories count; threads do not).`,
      unchecked
        ? `${unchecked} recently active channel(s) were not checked for people-only activity; narrow with category.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    return page(
      `${rows.length} of ${pool.length} channel(s) inactive for ${formatDurationShort(idleMs)}+${args.people_only ? ' (people only)' : ''}:`,
      lines,
      next,
      footer,
    );
  },
});

const ARCHIVE_NAME = /^archive(?:\s+(\d+))?$/i;

interface CategoryPlan {
  existing?: CategoryChannel;
  createName?: string;
  room: number;
}

export function planCategories(
  guild: Guild,
  needed: number,
  explicit?: CategoryChannel,
): CategoryPlan[] {
  if (explicit) {
    const room = CATEGORY_CHANNEL_LIMIT - explicit.children.cache.size;
    if (room < needed) {
      throw new GuildoraError(
        `${fmtChannel(explicit)} has room for ${room} more channel(s) (Discord allows ${CATEGORY_CHANNEL_LIMIT} per category), but ${needed} were given. Archive fewer, or omit archive_category to let Guildora create "Archive 2", "Archive 3"…`,
      );
    }
    return [{ existing: explicit, room }];
  }
  const archives = guild.channels.cache
    .filter(
      (c): c is CategoryChannel =>
        c.type === ChannelType.GuildCategory && ARCHIVE_NAME.test(c.name),
    )
    .sort((a, b) => a.rawPosition - b.rawPosition);
  const plans: CategoryPlan[] = [];
  let left = needed;
  for (const cat of archives.values()) {
    const room = CATEGORY_CHANNEL_LIMIT - cat.children.cache.size;
    if (room > 0 && left > 0) {
      plans.push({ existing: cat, room });
      left -= room;
    }
  }
  const used = new Set(archives.map((c) => Number(ARCHIVE_NAME.exec(c.name)?.[1] ?? 1)));
  let n = 1;
  while (left > 0) {
    while (used.has(n)) n++;
    used.add(n);
    plans.push({ createName: n === 1 ? 'Archive' : `Archive ${n}`, room: CATEGORY_CHANNEL_LIMIT });
    left -= CATEGORY_CHANNEL_LIMIT;
  }
  return plans;
}

function overwriteSummary(c: GuildBasedChannel): string | undefined {
  if (!('permissionOverwrites' in c)) return undefined;
  const parts = c.permissionOverwrites.cache.map((o) => {
    const who =
      o.type === OverwriteType.Role
        ? o.id === c.guild.id
          ? '@everyone'
          : `role ${o.id}`
        : `member ${o.id}`;
    const allow = permissionNames(o.allow.bitfield).join(',') || '-';
    const deny = permissionNames(o.deny.bitfield).join(',') || '-';
    return `${who} allow ${allow} deny ${deny}`;
  });
  return parts.length ? `${fmtChannel(c)}: ${parts.join('; ')}` : undefined;
}

export const archiveChannel = defineTool({
  name: 'archive_channel',
  pack: 'channels',
  title: 'Archive channels',
  description:
    'Moves up to 50 channels into a private "Archive" category (created if missing; "Archive 2" etc. when ' +
    'full) and syncs their permissions so regular members no longer see them. Messages are kept; undo with ' +
    'edit_channel. The result lists the old permission overwrites for restoring. Destructive: dry run unless ' +
    'confirm is true.',
  input: {
    channels: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe('Channels to archive (IDs, mentions or names).'),
    guild: guildField,
    archive_category: z
      .string()
      .optional()
      .describe('Target category (ID or name). Default: "Archive".'),
    sync_permissions: z
      .boolean()
      .optional()
      .describe("Replace the channels' permissions with the archive category's (default true)."),
    reason: reasonField,
  },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Channels', 'Manage Roles'],
  async prepare(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['ManageChannels', 'ManageRoles']);
    const sync = args.sync_permissions ?? true;
    const explicit = args.archive_category
      ? ((await channelArg(ctx, guild.id, args.archive_category, {
          kinds: ['category'],
          label: 'archive_category',
        })) as CategoryChannel)
      : undefined;

    const resolved: GuildBasedChannel[] = [];
    for (const input of args.channels) {
      const c = await guildChannelArg(ctx, guild.id, input);
      if (c.type === ChannelType.GuildCategory || c.isThread()) {
        throw new GuildoraError(
          `${fmtChannel(c)} is a ${c.isThread() ? 'thread' : 'category'}; only channels can be archived.`,
        );
      }
      if (!resolved.some((r) => r.id === c.id)) resolved.push(c);
    }
    const isArchived = (c: GuildBasedChannel) =>
      explicit ? c.parentId === explicit.id : Boolean(c.parent && ARCHIVE_NAME.test(c.parent.name));
    const already = resolved.filter(isArchived);
    const todo = resolved.filter((c) => !isArchived(c));
    if (todo.length === 0)
      throw new GuildoraError('All of these channels are already in an archive category.');

    const plans = planCategories(guild, todo.length, explicit);
    const withMembers = todo.filter(
      (c) =>
        'permissionOverwrites' in c &&
        c.permissionOverwrites.cache.some((o) => o.type === OverwriteType.Member),
    );
    const warnings = [
      `Channels: ${todo.map((c) => fmtChannel(c)).join(', ')}.`,
      `Target: ${plans.map((p) => (p.existing ? fmtChannel(p.existing) : `new private category "${p.createName}"`)).join(', ')}.`,
      'Messages are kept; nothing is deleted.',
    ];
    if (already.length)
      warnings.push(`Skipped (already archived): ${already.map((c) => fmtChannel(c)).join(', ')}.`);
    if (sync && withMembers.length) {
      warnings.push(
        `${withMembers.length} channel(s) give specific members access (e.g. personal or ticket channels); those members lose access. The result lists the old overwrites so they can be restored with set_permissions.`,
      );
    }
    if (!sync)
      warnings.push(
        'Permissions are kept as they are, so whoever sees the channels now still sees them.',
      );

    return {
      summary: `move ${todo.length} channel(s) to an archive category${sync ? ' and hide them from regular members' : ''}`,
      warnings,
      async execute() {
        const me = botMember(guild);
        const targets: { cat: CategoryChannel; room: number }[] = [];
        for (const p of plans) {
          const cat =
            p.existing ??
            ((await guild.channels.create({
              name: p.createName!,
              type: ChannelType.GuildCategory,
              permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
                {
                  id: me.id,
                  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels],
                  type: OverwriteType.Member,
                },
              ],
              ...(args.reason ? { reason: args.reason } : {}),
            })) as CategoryChannel);
          targets.push({ cat, room: p.room });
        }
        const before = todo.map(overwriteSummary).filter((s): s is string => Boolean(s));
        const moved: string[] = [];
        const failed: string[] = [];
        let t = 0;
        for (const c of todo) {
          while (targets[t] && targets[t]!.room <= 0) t++;
          const target = targets[t];
          if (!target) break;
          try {
            await (c as TextChannel).setParent(target.cat, {
              lockPermissions: sync,
              ...(args.reason ? { reason: args.reason } : {}),
            });
            target.room--;
            moved.push(`${fmtChannel(c)} → ${fmtChannel(target.cat)}`);
          } catch (e) {
            failed.push(`${fmtChannel(c)}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const out = [`Archived ${moved.length} channel(s):`, ...moved.map((m) => `- ${m}`)];
        if (failed.length) out.push(`Failed (${failed.length}):`, ...failed.map((f) => `- ${f}`));
        if (sync && before.length)
          out.push(
            'Previous permission overwrites (for restoring):',
            ...before.map((b) => `- ${b}`),
          );
        return out.join('\n');
      },
    };
  },
});
