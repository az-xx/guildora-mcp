import { describe, expect, it } from 'vitest';
import {
  isUnicodeEmoji,
  pickByName,
  resolveChannel,
  resolveGuild,
  resolveGuildEmoji,
  resolveMember,
  resolveReactionEmoji,
  resolveRole,
  resolveUser,
} from '../src/discord/resolve.js';
import { ChannelType } from '../src/discord/api.js';
import { GuildoraError } from '../src/mcp/errors.js';
import { channel, fakeClient, fakeGuild, member, role } from './helpers.js';

function setup() {
  const info = channel('Info', ChannelType.GuildCategory);
  const general = channel('general', ChannelType.GuildText, info.id);
  const generalVoice = channel('General', ChannelType.GuildVoice);
  const chat = channel('💬・off-topic');
  const dupA = channel('logs');
  const dupB = channel('logs');
  const forum = channel('help', ChannelType.GuildForum);
  const mods = role('Moderators', 5);
  const admins = role('Admins', 10);
  const alice = member('alice', { globalName: 'Alice A', nickname: 'Ally' });
  const bob = member('bob');
  const bobby = member('bobby');
  const guild = fakeGuild({
    channels: [info, general, generalVoice, chat, dupA, dupB, forum],
    roles: [mods, admins],
    members: [alice, bob, bobby],
    emojis: [{ id: '400000000000000001', name: 'party', animated: false }],
  });
  const client = fakeClient([guild]);
  return {
    guild,
    client,
    info,
    general,
    generalVoice,
    chat,
    dupA,
    dupB,
    forum,
    mods,
    admins,
    alice,
    bob,
    bobby,
  };
}

describe('pickByName', () => {
  const cands = [
    { item: 1, names: ['general'], label: '#general' },
    { item: 2, names: ['General Chat'], label: '#general-chat' },
  ];

  it('prefers exact case-insensitive matches', () => {
    expect(pickByName(cands, 'GENERAL', 'channel', '')).toBe(1);
  });

  it('falls back to loose matching that ignores separators', () => {
    expect(pickByName(cands, 'general-chat', 'channel', '')).toBe(2);
  });

  it('suggests partial matches when nothing matches', () => {
    expect(() => pickByName(cands, 'gen', 'channel', '')).toThrow(/Did you mean.*#general/s);
  });
});

describe('resolveChannel', () => {
  it('resolves IDs, mentions, links and #names', async () => {
    const { client, guild, general } = setup();
    const c = client as never;
    const g = guild as never;
    expect(await resolveChannel(c, g, general.id)).toBe(general);
    expect(await resolveChannel(c, g, `<#${general.id}>`)).toBe(general);
    expect(
      await resolveChannel(c, undefined, `https://discord.com/channels/${guild.id}/${general.id}`),
    ).toBe(general);
    expect(await resolveChannel(c, g, '#general', { kinds: ['text'] })).toBe(general);
  });

  it('ignores emoji and separators in names', async () => {
    const { client, guild, chat } = setup();
    expect(await resolveChannel(client as never, guild as never, 'off topic')).toBe(chat);
  });

  it('lists candidates when a name is ambiguous', async () => {
    const { client, guild, dupA, dupB } = setup();
    const err = await resolveChannel(client as never, guild as never, 'logs').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GuildoraError);
    expect((err as Error).message).toContain('matches 2 channels');
    expect((err as Error).message).toContain(dupA.id);
    expect((err as Error).message).toContain(dupB.id);
  });

  it('uses the type filter to disambiguate "general" (text) from "General" (voice)', async () => {
    const { client, guild, general, generalVoice } = setup();
    expect(
      await resolveChannel(client as never, guild as never, 'general', { kinds: ['voice'] }),
    ).toBe(generalVoice);
    expect(
      await resolveChannel(client as never, guild as never, 'general', { kinds: ['text'] }),
    ).toBe(general);
  });

  it('explains when the channel has the wrong type', async () => {
    const { client, guild, forum } = setup();
    await expect(
      resolveChannel(client as never, guild as never, forum.id, {
        kinds: ['text'],
        label: 'channel',
      }),
    ).rejects.toThrow(/is a forum channel, but channel must be: text/);
  });

  it('fetches channels missing from the cache (archived threads) without any prior call', async () => {
    const { client, guild } = setup();
    const thread = channel('old-thread', ChannelType.PublicThread);
    client.archived.set(thread.id, thread);
    expect(await resolveChannel(client as never, guild as never, thread.id)).toBe(thread);
  });

  it('reports unknown IDs clearly', async () => {
    const { client } = setup();
    await expect(resolveChannel(client as never, undefined, '123456789012345678')).rejects.toThrow(
      /No channel with ID/,
    );
  });

  it('needs a server to resolve names', async () => {
    const { client } = setup();
    await expect(resolveChannel(client as never, undefined, 'general')).rejects.toThrow(
      /Pass a channel ID or link/,
    );
  });
});

describe('resolveRole', () => {
  it('resolves IDs, mentions, names and @everyone', () => {
    const { guild, mods } = setup();
    const g = guild as never;
    expect(resolveRole(g, mods.id)).toBe(mods);
    expect(resolveRole(g, `<@&${mods.id}>`)).toBe(mods);
    expect(resolveRole(g, '@moderators')).toBe(mods);
    expect(resolveRole(g, 'everyone')).toBe(guild.roles.everyone);
  });

  it('suggests roles on a near miss', () => {
    const { guild } = setup();
    expect(() => resolveRole(guild as never, 'Mod')).toThrow(/Did you mean.*Moderators/s);
  });
});

describe('resolveMember / resolveUser', () => {
  it('resolves by ID, mention, username, global name and nickname', async () => {
    const { guild, alice } = setup();
    const g = guild as never;
    expect(await resolveMember(g, alice.id)).toBe(alice);
    expect(await resolveMember(g, `<@!${alice.id}>`)).toBe(alice);
    expect(await resolveMember(g, '@alice')).toBe(alice);
    expect(await resolveMember(g, 'Ally')).toBe(alice);
  });

  it('prefers the exact name over a prefix match', async () => {
    const { guild, bob } = setup();
    expect(await resolveMember(guild as never, 'bob')).toBe(bob);
  });

  it('explains that a user ID is not a member', async () => {
    const { guild } = setup();
    await expect(resolveMember(guild as never, '123456789012345678')).rejects.toThrow(
      /is not a member/,
    );
  });

  it('resolves users by ID without a server', async () => {
    const { client, alice } = setup();
    expect(await resolveUser(client as never, undefined, alice.id)).toBe(alice.user);
    await expect(resolveUser(client as never, undefined, 'alice')).rejects.toThrow(
      /Pass a user ID/,
    );
  });
});

describe('resolveGuild', () => {
  it('uses the only server, the default, an ID or a name', () => {
    const { client, guild } = setup();
    const c = client as never;
    expect(resolveGuild(c, undefined)).toBe(guild);
    expect(resolveGuild(c, undefined, guild.id)).toBe(guild);
    expect(resolveGuild(c, 'test server')).toBe(guild);
  });

  it('asks for a server when the bot is in several', () => {
    const a = fakeGuild({ name: 'A' });
    const b = fakeGuild({ name: 'B' });
    const client = fakeClient([a, b]);
    expect(() => resolveGuild(client as never, undefined)).toThrow(/in 2 servers.*A \(/s);
  });

  it('explains a wrong DISCORD_GUILD_ID', () => {
    const { client } = setup();
    expect(() => resolveGuild(client as never, undefined, '999999999999999999')).toThrow(
      /DISCORD_GUILD_ID is 999999999999999999/,
    );
  });
});

describe('emoji', () => {
  it('detects Unicode emoji', () => {
    expect(isUnicodeEmoji('👍')).toBe(true);
    expect(isUnicodeEmoji('❤️')).toBe(true);
    expect(isUnicodeEmoji('🇺🇸')).toBe(true);
    expect(isUnicodeEmoji('party')).toBe(false);
  });

  it('resolves reaction emoji from Unicode, <:name:id>, :name: and names', () => {
    const { guild } = setup();
    const g = guild as never;
    expect(resolveReactionEmoji(g, '👍')).toBe('👍');
    expect(resolveReactionEmoji(undefined, '<a:dance:400000000000000002>')).toBe(
      'a:dance:400000000000000002',
    );
    expect(resolveReactionEmoji(g, ':party:')).toBe(':party:400000000000000001');
    expect(resolveGuildEmoji(g, 'party').id).toBe('400000000000000001');
  });
});
