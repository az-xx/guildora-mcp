import { z } from 'zod';
import type { Message } from 'discord.js';
import { defineTool } from '../types.js';
import { guildField } from '../shared.js';
import {
  channelsInScope,
  lastActivity,
  mapLimit,
  parseSince,
  type MessageChannel,
} from '../core/activity.js';
import { snowflakeAt } from '../../discord/parse.js';
import { fmtChannel, ts } from '../../discord/format.js';

export interface StatsInput {
  channelId: string;
  authorId: string;
  authorName: string;
  bot: boolean;
  timestamp: number;
}

export interface Stats {
  total: number;
  people: number;
  bots: number;
  activePeople: number;
  byChannel: Map<string, { total: number; people: number }>;
  byAuthor: Map<string, { name: string; count: number; bot: boolean }>;
  byDay: Map<string, number>;
  byHour: number[];
}

/** Aggregates message records into totals, per-channel, per-author, per-day and per-hour counts. */
export function aggregate(records: StatsInput[]): Stats {
  const s: Stats = {
    total: 0,
    people: 0,
    bots: 0,
    activePeople: 0,
    byChannel: new Map(),
    byAuthor: new Map(),
    byDay: new Map(),
    byHour: new Array<number>(24).fill(0),
  };
  for (const r of records) {
    s.total++;
    if (r.bot) s.bots++;
    else s.people++;
    const ch = s.byChannel.get(r.channelId) ?? { total: 0, people: 0 };
    ch.total++;
    if (!r.bot) ch.people++;
    s.byChannel.set(r.channelId, ch);
    const a = s.byAuthor.get(r.authorId) ?? { name: r.authorName, count: 0, bot: r.bot };
    a.count++;
    s.byAuthor.set(r.authorId, a);
    const d = new Date(r.timestamp);
    const day = d.toISOString().slice(0, 10);
    s.byDay.set(day, (s.byDay.get(day) ?? 0) + 1);
    s.byHour[d.getUTCHours()]!++;
  }
  s.activePeople = [...s.byAuthor.values()].filter((a) => !a.bot).length;
  return s;
}

const n = (x: number) => x.toLocaleString('en-US');

export const messageStats = defineTool({
  name: 'message_stats',
  pack: 'insights',
  title: 'Message statistics',
  description:
    'Counts messages over a period ("7d" by default) for the server or a category/channel: totals for people ' +
    'and bots, the busiest channels, the most active people, messages per day and the busiest hours (UTC). ' +
    'Counts are exact up to max_messages and say where a cap was hit.',
  input: {
    guild: guildField,
    since: z.string().optional().describe('Period: "24h", "7d" (default), "30d", or an ISO date.'),
    scope: z
      .string()
      .optional()
      .describe('Only this category, channel, forum or thread (ID or name).'),
    top: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('How many top channels and people to list (default 10).'),
    max_messages: z
      .number()
      .int()
      .min(100)
      .max(20_000)
      .optional()
      .describe('Stop counting after this many messages in total (default 5000).'),
  },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const since = parseSince(args.since, '7d');
    const sinceId = snowflakeAt(since);
    const cap = args.max_messages ?? 5000;
    const top = args.top ?? 10;
    const channels = (await channelsInScope(ctx, guild, args.scope)).filter(
      (c) => c.lastMessageId && lastActivity(c) >= since.getTime(),
    );

    const records: StatsInput[] = [];
    const capped = new Set<string>();
    let stopped = false;
    await mapLimit(channels, 5, async (c: MessageChannel) => {
      let after = sinceId;
      while (!stopped) {
        const batch = await c.messages.fetch({ after, limit: 100 }).catch(() => undefined);
        if (!batch || batch.size === 0) return;
        const list = [...batch.values()] as Message[];
        for (const m of list) {
          if (records.length >= cap) {
            stopped = true;
            capped.add(c.id);
            return;
          }
          records.push({
            channelId: c.id,
            authorId: m.author.id,
            authorName: m.author.username,
            bot: m.author.bot || m.webhookId !== null,
            timestamp: m.createdTimestamp,
          });
        }
        if (batch.size < 100) return;
        after = list.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), after);
      }
      if (stopped) capped.add(c.id);
    });

    const s = aggregate(records);
    const byId = new Map(channels.map((c) => [c.id, c]));
    const lines = [
      `Messages in ${guild.name} since ${ts(since)}: ${n(s.total)}${stopped ? '+' : ''} (${n(s.people)} from people, ${n(s.bots)} from bots and webhooks), ${n(s.activePeople)} people active, ${s.byChannel.size} channel(s) with messages.`,
    ];
    if (stopped) {
      lines.push(
        `Counting stopped at max_messages (${n(cap)}); totals are a lower bound. Raise max_messages or narrow scope/since for exact numbers.`,
      );
    }
    const topChannels = [...s.byChannel.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, top);
    lines.push('', `Busiest channels:`);
    for (const [id, v] of topChannels) {
      const c = byId.get(id);
      lines.push(
        `- ${c ? fmtChannel(c) : id} — ${n(v.total)}${capped.has(id) ? '+' : ''} (${n(v.people)} from people)`,
      );
    }
    const topPeople = [...s.byAuthor.entries()]
      .filter(([, a]) => !a.bot)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, top);
    lines.push('', 'Most active people:');
    for (const [id, a] of topPeople) lines.push(`- @${a.name} (${id}) — ${n(a.count)}`);
    if (!topPeople.length) lines.push('- (none)');
    const bots = [...s.byAuthor.entries()]
      .filter(([, a]) => a.bot)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3);
    if (bots.length)
      lines.push(
        `Top bots: ${bots.map(([id, a]) => `@${a.name} (${id}) ${n(a.count)}`).join(', ')}`,
      );
    lines.push(
      '',
      `Per day (UTC): ${
        [...s.byDay.entries()]
          .sort()
          .map(([d, v]) => `${d.slice(5)} ${n(v)}`)
          .join(' · ') || 'none'
      }`,
    );
    const hours = s.byHour
      .map((v, h) => ({ h, v }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 5);
    lines.push(
      `Busiest hours (UTC): ${hours.map((x) => `${String(x.h).padStart(2, '0')}:00 (${n(x.v)})`).join(', ') || 'none'}`,
    );
    return lines.join('\n');
  },
});
