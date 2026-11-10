/**
 * Live smoke test against a real Discord server. Skipped unless DISCORD_TOKEN and
 * GUILDORA_TEST_GUILD_ID are set (in the environment or a local .env file).
 * Optional GUILDORA_TEST_CHANNEL_ID also sends, reads and deletes one message there.
 *
 *   npm run test:live
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { DiscordConnection } from '../../src/discord/client.js';
import { resolveGuild } from '../../src/discord/resolve.js';
import { createLogger } from '../../src/logger.js';
import { executeTool } from '../../src/tools/execute.js';
import { ALL_TOOLS } from '../../src/tools/registry.js';
import type { ToolContext } from '../../src/tools/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const guildId = process.env.GUILDORA_TEST_GUILD_ID;
const channelId = process.env.GUILDORA_TEST_CHANNEL_ID;
const enabled = Boolean(process.env.DISCORD_TOKEN && guildId);

const run = async (ctx: ToolContext, name: string, args: Record<string, unknown>) => {
  const tool = ALL_TOOLS.find((t) => t.name === name)!;
  const res = await executeTool(tool, args, async () => ctx);
  const text = (res.content[0] as { text: string }).text;
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return text;
};

describe.skipIf(!enabled)('live Discord smoke test', () => {
  let discord: DiscordConnection;
  let ctx: ToolContext;

  beforeAll(async () => {
    const config = loadConfig({ ...process.env, DISCORD_GUILD_ID: guildId, GUILDORA_PACKS: 'all' });
    discord = new DiscordConnection(config, createLogger('warn'));
    await discord.start();
    const client = await discord.waitReady();
    ctx = {
      client,
      config,
      intents: discord.intents,
      guild: async (i) => resolveGuild(client, i, guildId),
    };
  });

  afterAll(async () => {
    await discord?.destroy();
  });

  it('reads server info, channels, roles and threads', async () => {
    expect(await run(ctx, 'get_server_info', {})).toContain(`(${guildId})`);
    expect(await run(ctx, 'list_channels', {})).toMatch(/channel\(s\)/);
    expect(await run(ctx, 'list_roles', {})).toContain('@everyone');
    expect(await run(ctx, 'list_threads', {})).toMatch(/active thread/);
  });

  it.skipIf(!channelId)('sends, reads, reacts to and deletes a message', async () => {
    const sent = await run(ctx, 'send_message', {
      channel: channelId,
      content: 'guildora live test',
    });
    const id = /Sent message (\d+)/.exec(sent)![1]!;
    expect(await run(ctx, 'get_message', { channel: channelId, message: id })).toContain(
      'guildora live test',
    );
    await run(ctx, 'add_reaction', { channel: channelId, message: id, emoji: '✅' });
    expect(await run(ctx, 'delete_message', { channel: channelId, message: id })).toContain(
      'DRY RUN',
    );
    expect(
      await run(ctx, 'delete_message', { channel: channelId, message: id, confirm: true }),
    ).toContain('Deleted');
  });
});
