import { z } from 'zod';
import type {
  Guild,
  GuildScheduledEvent,
  GuildScheduledEventCreateOptions,
  StageChannel,
  VoiceChannel,
} from 'discord.js';
import {
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
} from '../../discord/api.js';
import { defineTool, type AnyTool } from '../types.js';
import {
  channelArg,
  guildField,
  memberField,
  reasonField,
  requireBotPermissions,
  requireMemberBelowBot,
} from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { pickByName, resolveMember } from '../../discord/resolve.js';
import { isSnowflake, parseDate } from '../../discord/parse.js';
import { fmtChannel, fmtMember, fmtUser, page, truncate, ts } from '../../discord/format.js';
import { loadFile, uploadLimit } from '../../discord/files.js';

// ---------------------------------------------------------------------------- voice members

const moveMember = defineTool({
  name: 'move_member',
  pack: 'voice',
  title: 'Move a member to a voice channel',
  description: 'Moves a member who is connected to voice into another voice or stage channel.',
  input: {
    member: memberField(),
    channel: z.string().describe('Target voice or stage channel (ID, mention, link or name).'),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Move Members', 'Connect (target channel)'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const m = await resolveMember(guild, args.member);
    if (!m.voice.channel)
      throw new GuildoraError(`${fmtMember(m)} is not connected to a voice channel.`);
    const target = (await channelArg(ctx, guild.id, args.channel, {
      kinds: ['voice', 'stage'],
      label: 'channel',
    })) as VoiceChannel | StageChannel;
    requireBotPermissions(guild, ['MoveMembers', 'Connect'], target);
    const from = m.voice.channel;
    await m.voice.setChannel(target, args.reason);
    return `Moved ${fmtMember(m)} from ${fmtChannel(from)} to ${fmtChannel(target)}.`;
  },
});

const disconnectMember = defineTool({
  name: 'disconnect_member',
  pack: 'voice',
  title: 'Disconnect a member from voice',
  description: 'Disconnects a member from their current voice or stage channel. They can rejoin.',
  input: { member: memberField(), guild: guildField, reason: reasonField },
  readOnly: false,
  idempotent: true,
  permissions: ['Move Members'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const m = await resolveMember(guild, args.member);
    const from = m.voice.channel;
    if (!from) return `${fmtMember(m)} is not connected to voice.`;
    requireBotPermissions(guild, ['MoveMembers'], from);
    await m.voice.disconnect(args.reason);
    return `Disconnected ${fmtMember(m)} from ${fmtChannel(from)}.`;
  },
});

const setVoiceState = defineTool({
  name: 'set_voice_state',
  pack: 'voice',
  title: 'Server mute or deafen a member',
  description:
    'Server-mutes/unmutes and/or server-deafens/undeafens a member in voice. The setting stays until changed, ' +
    'even after they reconnect.',
  input: {
    member: memberField(),
    mute: z.boolean().optional().describe('true mutes their microphone, false unmutes.'),
    deafen: z.boolean().optional().describe('true deafens them, false undeafens.'),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Mute Members', 'Deafen Members'],
  async run(args, ctx) {
    if (args.mute === undefined && args.deafen === undefined)
      throw new GuildoraError('Pass mute and/or deafen.');
    const guild = await ctx.guild(args.guild);
    const m = await resolveMember(guild, args.member);
    if (!m.voice.channel) {
      throw new GuildoraError(
        `${fmtMember(m)} is not in voice; Discord only allows this while they are connected.`,
      );
    }
    requireMemberBelowBot(m, 'muted or deafened');
    const done: string[] = [];
    if (args.mute !== undefined) {
      requireBotPermissions(guild, ['MuteMembers'], m.voice.channel);
      await m.voice.setMute(args.mute, args.reason);
      done.push(args.mute ? 'muted' : 'unmuted');
    }
    if (args.deafen !== undefined) {
      requireBotPermissions(guild, ['DeafenMembers'], m.voice.channel);
      await m.voice.setDeaf(args.deafen, args.reason);
      done.push(args.deafen ? 'deafened' : 'undeafened');
    }
    return `Server-${done.join(' and ')} ${fmtMember(m)}.`;
  },
});

// ---------------------------------------------------------------------------- scheduled events

const STATUS_NAMES: Record<number, string> = {
  [GuildScheduledEventStatus.Scheduled]: 'scheduled',
  [GuildScheduledEventStatus.Active]: 'active',
  [GuildScheduledEventStatus.Completed]: 'completed',
  [GuildScheduledEventStatus.Canceled]: 'canceled',
};
const TYPE_NAMES: Record<number, string> = {
  [GuildScheduledEventEntityType.StageInstance]: 'stage',
  [GuildScheduledEventEntityType.Voice]: 'voice',
  [GuildScheduledEventEntityType.External]: 'external',
};

function eventLine(e: GuildScheduledEvent): string {
  const where = e.channel ? fmtChannel(e.channel) : (e.entityMetadata?.location ?? 'n/a');
  return (
    `"${e.name}" (${e.id}) · ${TYPE_NAMES[e.entityType] ?? e.entityType} · ${STATUS_NAMES[e.status] ?? e.status}` +
    ` · ${ts(e.scheduledStartAt)}${e.scheduledEndAt ? ` → ${ts(e.scheduledEndAt)}` : ''} · where: ${where}` +
    ` · interested: ${e.userCount ?? '?'}${e.description ? ` · ${truncate(e.description, 120)}` : ''}`
  );
}

async function resolveEvent(guild: Guild, input: string): Promise<GuildScheduledEvent> {
  const events = await guild.scheduledEvents.fetch();
  const raw = input.trim();
  if (isSnowflake(raw)) {
    const e = events.get(raw);
    if (!e) throw new GuildoraError(`No scheduled event with ID ${raw}. Use list_events.`);
    return e;
  }
  return pickByName(
    [...events.values()].map((e) => ({ item: e, names: [e.name], label: `"${e.name}" (${e.id})` })),
    raw,
    'event',
    'Use list_events to see scheduled events.',
  );
}

const listEvents = defineTool({
  name: 'list_events',
  pack: 'voice',
  title: 'List scheduled events',
  description:
    "Lists the server's scheduled events (upcoming and active) with type, status, times, location and interest count.",
  input: { guild: guildField },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const events = await guild.scheduledEvents.fetch({ withUserCount: true });
    const sorted = [...events.values()].sort(
      (a, b) => (a.scheduledStartTimestamp ?? 0) - (b.scheduledStartTimestamp ?? 0),
    );
    return page(`${sorted.length} scheduled event(s) in ${guild.name}:`, sorted.map(eventLine));
  },
});

const eventFields = {
  description: z.string().max(1000).optional(),
  start: z.string().describe('Start time, ISO 8601 with time zone, e.g. "2026-12-01T18:00:00Z".'),
  end: z.string().optional().describe('End time (ISO 8601). Required for external events.'),
  channel: z.string().optional().describe('Voice or stage channel (for voice/stage events).'),
  location: z.string().max(100).optional().describe('Place or link (for external events).'),
  image: z
    .object({ url: z.url().optional(), base64: z.string().optional(), path: z.string().optional() })
    .optional()
    .describe('Cover image.'),
};

const createEvent = defineTool({
  name: 'create_event',
  pack: 'voice',
  title: 'Create a scheduled event',
  description:
    'Schedules a server event: type "voice" or "stage" (in a channel) or "external" (a location or link, needs ' +
    'an end time). Times are ISO 8601 and must be in the future. Returns the event ID and link.',
  input: {
    name: z.string().min(1).max(100),
    type: z.enum(['voice', 'stage', 'external']),
    guild: guildField,
    ...eventFields,
    reason: reasonField,
  },
  readOnly: false,
  permissions: ['Create Events / Manage Events'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const start = parseDate(args.start, 'start');
    if (start.getTime() < Date.now()) throw new GuildoraError(`start ${ts(start)} is in the past.`);
    const end = args.end ? parseDate(args.end, 'end') : undefined;
    if (end && end <= start) throw new GuildoraError('end must be after start.');
    const options: GuildScheduledEventCreateOptions = {
      name: args.name,
      scheduledStartTime: start,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      ...(end ? { scheduledEndTime: end } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    };
    if (args.type === 'external') {
      if (!args.location) throw new GuildoraError('External events need a "location".');
      if (!end) throw new GuildoraError('External events need an "end" time.');
      options.entityMetadata = { location: args.location };
    } else {
      if (!args.channel) throw new GuildoraError(`${args.type} events need a "channel".`);
      const ch = await channelArg(ctx, guild.id, args.channel, {
        kinds: [args.type],
        label: 'channel',
      });
      options.entityType =
        args.type === 'stage'
          ? GuildScheduledEventEntityType.StageInstance
          : GuildScheduledEventEntityType.Voice;
      options.channel = ch.id;
    }
    if (args.image) {
      options.image = (
        await loadFile(args.image, {
          allowLocalPaths: ctx.config.transport === 'stdio',
          maxBytes: uploadLimit(undefined),
        })
      ).attachment;
    }
    const e = await guild.scheduledEvents.create(options);
    return `Created event ${eventLine(e)} ${e.url}`;
  },
});

const editEvent = defineTool({
  name: 'edit_event',
  pack: 'voice',
  title: 'Edit or start/end an event',
  description:
    'Changes a scheduled event\'s name, description, times, channel or location, or its status: "active" ' +
    'starts it, "completed" ends it, "canceled" cancels a scheduled one.',
  input: {
    event: z.string().describe('Event ID or name.'),
    guild: guildField,
    name: z.string().min(1).max(100).optional(),
    status: z.enum(['active', 'completed', 'canceled']).optional(),
    ...eventFields,
    start: eventFields.start.optional(),
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Manage Events'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const e = await resolveEvent(guild, args.event);
    const edit: Record<string, unknown> = {};
    if (args.name) edit.name = args.name;
    if (args.description !== undefined) edit.description = args.description;
    if (args.start) edit.scheduledStartTime = parseDate(args.start, 'start');
    if (args.end) edit.scheduledEndTime = parseDate(args.end, 'end');
    if (args.location) edit.entityMetadata = { location: args.location };
    if (args.channel)
      edit.channel = (
        await channelArg(ctx, guild.id, args.channel, { kinds: ['voice', 'stage'] })
      ).id;
    if (args.status) {
      edit.status = {
        active: GuildScheduledEventStatus.Active,
        completed: GuildScheduledEventStatus.Completed,
        canceled: GuildScheduledEventStatus.Canceled,
      }[args.status];
    }
    if (args.image) {
      edit.image = (
        await loadFile(args.image, {
          allowLocalPaths: ctx.config.transport === 'stdio',
          maxBytes: uploadLimit(undefined),
        })
      ).attachment;
    }
    if (args.reason) edit.reason = args.reason;
    if (Object.keys(edit).filter((k) => k !== 'reason').length === 0)
      throw new GuildoraError('Nothing to change.');
    const updated = await e.edit(edit);
    return `Updated event ${eventLine(updated)}`;
  },
});

const deleteEvent = defineTool({
  name: 'delete_event',
  pack: 'voice',
  title: 'Delete a scheduled event',
  description:
    'Permanently deletes a scheduled event (use edit_event status "canceled" to cancel it visibly instead). ' +
    'Destructive: returns a dry run unless confirm is true.',
  input: { event: z.string().describe('Event ID or name.'), guild: guildField },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Events'],
  async prepare(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const e = await resolveEvent(guild, args.event);
    return {
      summary: `delete event ${eventLine(e)}`,
      async execute() {
        await e.delete();
        return `Deleted event "${e.name}" (${e.id}).`;
      },
    };
  },
});

const listEventUsers = defineTool({
  name: 'list_event_users',
  pack: 'voice',
  title: 'List people interested in an event',
  description: 'Lists users who marked themselves interested in a scheduled event, in pages.',
  input: {
    event: z.string().describe('Event ID or name.'),
    guild: guildField,
    limit: z.number().int().min(1).max(100).optional().describe('Max users (1-100, default 100).'),
    cursor: z.string().optional().describe('next_cursor from a previous call.'),
  },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const e = await resolveEvent(guild, args.event);
    const limit = args.limit ?? 100;
    if (args.cursor && !isSnowflake(args.cursor)) throw new GuildoraError('Invalid cursor.');
    const subs = await e.fetchSubscribers({
      limit,
      withMember: true,
      ...(args.cursor ? { after: args.cursor } : {}),
    });
    const list = [...subs.values()];
    return page(
      `${list.length} interested user(s) for "${e.name}":`,
      list.map((s) => (s.member ? fmtMember(s.member) : fmtUser(s.user))),
      list.length === limit ? list.at(-1)!.user.id : undefined,
    );
  },
});

export const voiceTools: AnyTool[] = [
  moveMember,
  disconnectMember,
  setVoiceState,
  listEvents,
  createEvent,
  editEvent,
  deleteEvent,
  listEventUsers,
];
