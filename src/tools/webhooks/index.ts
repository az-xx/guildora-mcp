import { z } from 'zod';
import type { Guild, Webhook } from 'discord.js';
import { defineTool, type AnyTool } from '../types.js';
import {
  buildEmbeds,
  embedsField,
  filesField,
  guildChannelArg,
  guildField,
  loadFiles,
  reasonField,
  requireBotPermissions,
} from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { pickByName } from '../../discord/resolve.js';
import { isSnowflake } from '../../discord/parse.js';
import { fmtChannel, fmtUser, page, ts } from '../../discord/format.js';
import { loadFile, uploadLimit } from '../../discord/files.js';

const WEBHOOK_KINDS = ['text', 'announcement', 'forum', 'media', 'voice', 'stage'] as (
  'text' | 'announcement' | 'forum' | 'media' | 'voice' | 'stage'
)[];

/** Never includes the token or URL: webhook secrets stay inside Guildora. */
function webhookLine(w: Webhook): string {
  const kind = w.isIncoming()
    ? 'incoming'
    : w.isChannelFollower()
      ? 'channel follower'
      : 'application';
  return `"${w.name}" (${w.id}) · ${kind} · in ${fmtChannel(w.channel ?? null)} · created by ${w.owner ? fmtUser(w.owner as never) : 'unknown'} · ${ts(w.createdAt)}`;
}

async function guildWebhooks(guild: Guild): Promise<Webhook[]> {
  requireBotPermissions(guild, ['ManageWebhooks']);
  return [...(await guild.fetchWebhooks()).values()];
}

async function resolveWebhook(guild: Guild, input: string, channelId?: string): Promise<Webhook> {
  let hooks = await guildWebhooks(guild);
  if (channelId) hooks = hooks.filter((w) => w.channelId === channelId);
  const raw = input.trim();
  if (isSnowflake(raw)) {
    const w = hooks.find((h) => h.id === raw);
    if (!w)
      throw new GuildoraError(`No webhook with ID ${raw} in ${guild.name}. Use list_webhooks.`);
    return w;
  }
  return pickByName(
    hooks.map((w) => ({ item: w, names: [w.name], label: webhookLine(w) })),
    raw,
    'webhook',
    'Use list_webhooks to see webhooks.',
  );
}

const listWebhooks = defineTool({
  name: 'list_webhooks',
  pack: 'webhooks',
  title: 'List webhooks',
  description:
    'Lists webhooks in the server or one channel with ID, name, type, channel and creator. Webhook URLs and ' +
    'tokens are never shown; send through a webhook with send_webhook_message by ID or name.',
  input: {
    guild: guildField,
    channel: z.string().optional().describe('Only webhooks of this channel.'),
  },
  readOnly: true,
  permissions: ['Manage Webhooks'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    let hooks = await guildWebhooks(guild);
    if (args.channel) {
      const ch = await guildChannelArg(ctx, guild.id, args.channel);
      hooks = hooks.filter((w) => w.channelId === ch.id);
    }
    return page(`${hooks.length} webhook(s) in ${guild.name}:`, hooks.map(webhookLine));
  },
});

const createWebhook = defineTool({
  name: 'create_webhook',
  pack: 'webhooks',
  title: 'Create a webhook',
  description:
    'Creates an incoming webhook in a channel, optionally with an avatar. Returns its ID (not the secret URL); ' +
    'use send_webhook_message to post through it.',
  input: {
    channel: z.string().describe('Channel (ID, mention, link or name).'),
    name: z.string().min(1).max(80),
    guild: guildField,
    avatar_url: z.url().optional().describe('https URL of an avatar image.'),
    reason: reasonField,
  },
  readOnly: false,
  permissions: ['Manage Webhooks'],
  async run(args, ctx) {
    const channel = await guildChannelArg(ctx, args.guild, args.channel, {
      kinds: WEBHOOK_KINDS,
      label: 'channel',
    });
    requireBotPermissions(channel.guild, ['ManageWebhooks'], channel);
    if (/clyde|discord/i.test(args.name))
      throw new GuildoraError('Webhook names cannot contain "clyde" or "discord".');
    const avatar = args.avatar_url
      ? (
          await loadFile(
            { url: args.avatar_url },
            { allowLocalPaths: false, maxBytes: uploadLimit(undefined) },
          )
        ).attachment
      : undefined;
    if (!('createWebhook' in channel))
      throw new GuildoraError(`${fmtChannel(channel)} does not support webhooks.`);
    const hook = await channel.createWebhook({
      name: args.name,
      ...(avatar ? { avatar } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
    return `Created webhook ${webhookLine(hook)}.`;
  },
});

const deleteWebhook = defineTool({
  name: 'delete_webhook',
  pack: 'webhooks',
  title: 'Delete a webhook',
  description:
    'Deletes a webhook; anything using its URL stops working. Destructive: returns a dry run unless confirm is true.',
  input: {
    webhook: z.string().describe('Webhook ID or name.'),
    channel: z.string().optional().describe('Channel, to disambiguate names.'),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Webhooks'],
  async prepare(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const channelId = args.channel
      ? (await guildChannelArg(ctx, guild.id, args.channel)).id
      : undefined;
    const hook = await resolveWebhook(guild, args.webhook, channelId);
    return {
      summary: `delete webhook ${webhookLine(hook)}`,
      warnings: ['Integrations posting through this webhook will stop working.'],
      async execute() {
        await hook.delete(args.reason);
        return `Deleted webhook "${hook.name}" (${hook.id}).`;
      },
    };
  },
});

const sendWebhookMessage = defineTool({
  name: 'send_webhook_message',
  pack: 'webhooks',
  title: 'Send a message through a webhook',
  description:
    'Posts a message through a webhook (chosen by ID or name), optionally with a custom display name and ' +
    "avatar, embeds and files. thread posts into a thread or forum post of the webhook's channel. The " +
    'webhook token is looked up internally and never exposed.',
  input: {
    webhook: z.string().describe('Webhook ID or name.'),
    channel: z.string().optional().describe('Channel, to disambiguate webhook names.'),
    guild: guildField,
    content: z.string().max(2000).optional(),
    username: z.string().max(80).optional().describe('Display name for this message.'),
    avatar_url: z.url().optional().describe('Avatar URL for this message.'),
    embeds: embedsField,
    files: filesField,
    thread: z.string().optional().describe("Thread or forum post ID inside the webhook's channel."),
    thread_name: z
      .string()
      .max(100)
      .optional()
      .describe('Forum webhooks: create a new post with this title.'),
  },
  readOnly: false,
  permissions: ['Manage Webhooks (to look up the webhook)'],
  async run(args, ctx) {
    if (!args.content && !args.embeds?.length && !args.files?.length)
      throw new GuildoraError('Provide content, embeds or files.');
    const guild = await ctx.guild(args.guild);
    const channelId = args.channel
      ? (await guildChannelArg(ctx, guild.id, args.channel)).id
      : undefined;
    const hook = await resolveWebhook(guild, args.webhook, channelId);
    if (!hook.token) {
      throw new GuildoraError(
        `Webhook "${hook.name}" is not an incoming webhook the bot can post with (no token available).`,
      );
    }
    if (args.thread && !isSnowflake(args.thread))
      throw new GuildoraError('thread must be a thread ID.');
    const files = await loadFiles(ctx, args.files, guild);
    const embeds = buildEmbeds(args.embeds);
    const msg = await hook.send({
      ...(args.content ? { content: args.content } : {}),
      ...(args.username ? { username: args.username } : {}),
      ...(args.avatar_url ? { avatarURL: args.avatar_url } : {}),
      ...(embeds ? { embeds } : {}),
      ...(files ? { files } : {}),
      ...(args.thread ? { threadId: args.thread } : {}),
      ...(args.thread_name ? { threadName: args.thread_name } : {}),
      allowedMentions: { parse: ['users', 'roles'] },
    });
    return `Sent message ${msg.id} through webhook "${hook.name}" in ${fmtChannel(hook.channel ?? null)}.`;
  },
});

export const webhookTools: AnyTool[] = [
  listWebhooks,
  createWebhook,
  deleteWebhook,
  sendWebhookMessage,
];
