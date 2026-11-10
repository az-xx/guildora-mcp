/**
 * Minimal fakes of discord.js objects. They implement only what the code under test touches,
 * so tests never need a real token or network.
 */
import { Collection, DiscordAPIError } from 'discord.js';
import type { Config } from '../src/config.js';
import type { ToolContext } from '../src/tools/types.js';
import { ChannelType } from '../src/discord/api.js';

export const TOKEN = [
  'MTAwMDAwMDAwMDAwMDAwMDAwMA',
  'GaBcDe',
  'abcdefghijklmnopqrstuvwxyz0123456789AB',
].join('.');

export function apiError(code: number, status: number, message = 'error', errors?: unknown) {
  return new DiscordAPIError(
    { code, message, ...(errors ? { errors } : {}) } as never,
    code,
    status,
    'GET',
    'https://discord.com/api/v10/x',
    { body: undefined, files: undefined },
  );
}

let nextId = 100000000000000000n;
export const id = () => (nextId++).toString();

export interface FakeChannel {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
  guild?: unknown;
}

export function channel(
  name: string,
  type = ChannelType.GuildText,
  parentId: string | null = null,
): FakeChannel {
  return { id: id(), name, type, parentId };
}

export function role(name: string, position: number) {
  return { id: id(), name, position, managed: false };
}

export function member(username: string, opts: { globalName?: string; nickname?: string } = {}) {
  const userId = id();
  return {
    id: userId,
    nickname: opts.nickname ?? null,
    displayName: opts.nickname ?? opts.globalName ?? username,
    user: { id: userId, username, globalName: opts.globalName ?? null, bot: false },
  };
}

export function fakeGuild(parts: {
  name?: string;
  channels?: FakeChannel[];
  roles?: ReturnType<typeof role>[];
  members?: ReturnType<typeof member>[];
  emojis?: { id: string; name: string; animated: boolean }[];
}) {
  const guildId = id();
  const everyone = { id: guildId, name: '@everyone', position: 0, managed: false };
  const roles = new Collection([everyone, ...(parts.roles ?? [])].map((r) => [r.id, r]));
  const members = new Collection((parts.members ?? []).map((m) => [m.id, m]));
  const guild = {
    id: guildId,
    name: parts.name ?? 'Test Server',
    channels: { cache: new Collection((parts.channels ?? []).map((c) => [c.id, c])) },
    roles: { cache: roles, everyone },
    emojis: { cache: new Collection((parts.emojis ?? []).map((e) => [e.id, e])) },
    stickers: { cache: new Collection() },
    members: {
      cache: new Collection(),
      async fetch(memberId: string) {
        const m = members.get(memberId);
        if (!m) throw apiError(10007, 404, 'Unknown Member');
        return m;
      },
      async search({ query }: { query: string }) {
        const q = query.toLowerCase();
        return members.filter(
          (m) =>
            m.user.username.toLowerCase().startsWith(q) ||
            (m.nickname ?? '').toLowerCase().startsWith(q),
        );
      },
    },
  };
  for (const c of parts.channels ?? []) c.guild = guild;
  return guild;
}

export function fakeClient(guilds: ReturnType<typeof fakeGuild>[]) {
  const allChannels = new Collection<string, FakeChannel>();
  for (const g of guilds)
    for (const c of g.channels.cache.values()) allChannels.set(c.id, c as FakeChannel);
  const archived = new Collection<string, FakeChannel>();
  return {
    guilds: { cache: new Collection(guilds.map((g) => [g.id, g])) },
    channels: {
      cache: allChannels,
      async fetch(channelId: string) {
        const c = archived.get(channelId);
        if (!c) throw apiError(10003, 404, 'Unknown Channel');
        return c;
      },
    },
    users: {
      async fetch(userId: string) {
        for (const g of guilds) {
          try {
            return (await g.members.fetch(userId)).user;
          } catch {
            /* next guild */
          }
        }
        throw apiError(10013, 404, 'Unknown User');
      },
    },
    /** Channels only reachable through the API, like archived threads. */
    archived,
    user: { id: '1' },
  };
}

export function config(overrides: Partial<Config> = {}): Config {
  return {
    token: TOKEN,
    defaultGuildId: undefined,
    packs: ['core'],
    readOnly: false,
    transport: 'stdio',
    host: '127.0.0.1',
    port: 8085,
    httpToken: undefined,
    logLevel: 'error',
    scanLimit: 1000,
    exportDir: 'guildora-exports-test',
    ...overrides,
  };
}

export function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    client: {} as never,
    config: config(),
    intents: { members: true, messageContent: true },
    guild: async () => {
      throw new Error('no guild in this test');
    },
    ...overrides,
  };
}
