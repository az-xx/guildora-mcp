import { z } from 'zod';
import type { GuildEmoji, Sticker } from 'discord.js';
import { StickerFormatType } from '../../discord/api.js';
import { defineTool, type AnyTool } from '../types.js';
import {
  cursorField,
  fileSchema,
  guildField,
  reasonField,
  requireBotPermissions,
} from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import {
  isUnicodeEmoji,
  resolveGuildEmoji,
  resolveRole,
  resolveSticker,
} from '../../discord/resolve.js';
import { parseOffsetCursor } from '../../discord/parse.js';
import { bytes, fmtRole, page, slicePage } from '../../discord/format.js';
import { loadFile } from '../../discord/files.js';

const EMOJI_MAX = 256 * 1024;
const STICKER_MAX = 512 * 1024;
const EMOJI_NAME = /^[\w]{2,32}$/;

function emojiLine(e: GuildEmoji): string {
  const roles = e.roles.cache.map(fmtRole);
  return (
    `${e.toString()} :${e.name}: (${e.id})${e.animated ? ' · animated' : ''}${e.managed ? ' · managed' : ''}` +
    `${e.available === false ? ' · unavailable (boost level)' : ''}${roles.length ? ` · only for ${roles.join(', ')}` : ''}`
  );
}

const FORMAT_NAMES: Record<number, string> = {
  [StickerFormatType.PNG]: 'png',
  [StickerFormatType.APNG]: 'apng',
  [StickerFormatType.Lottie]: 'lottie',
  [StickerFormatType.GIF]: 'gif',
};

function stickerLine(s: Sticker): string {
  return `${s.name} (${s.id}) · ${FORMAT_NAMES[s.format] ?? s.format} · tags: ${s.tags ?? '-'}${s.description ? ` · ${s.description}` : ''}`;
}

const listEmoji = defineTool({
  name: 'list_emoji',
  pack: 'emoji',
  title: 'List custom emoji',
  description:
    "Lists the server's custom emoji with the code to use in messages (<:name:id>), animated/managed flags and role restrictions.",
  input: {
    guild: guildField,
    query: z.string().optional().describe('Only emoji whose name contains this.'),
    limit: z.number().int().min(1).max(250).optional().describe('Max emoji (1-250, default 100).'),
    cursor: cursorField,
  },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    let list = [...(await guild.emojis.fetch()).values()].sort((a, b) =>
      (a.name ?? '').localeCompare(b.name ?? ''),
    );
    if (args.query)
      list = list.filter((e) => e.name?.toLowerCase().includes(args.query!.toLowerCase()));
    const { items, next } = slicePage(list, parseOffsetCursor(args.cursor), args.limit ?? 100);
    return page(`${list.length} custom emoji in ${guild.name}:`, items.map(emojiLine), next);
  },
});

const imageField = fileSchema.describe(
  'Image: path (stdio only), https url, or base64. PNG/JPG/GIF/WebP, max 256 KB.',
);

const createEmoji = defineTool({
  name: 'create_emoji',
  pack: 'emoji',
  title: 'Upload a custom emoji',
  description:
    'Uploads a custom emoji from an image (max 256 KB). Name 2-32 letters, digits or underscores. Optionally ' +
    'restrict it to roles. Returns the emoji code to use in messages.',
  input: {
    name: z.string().describe('Emoji name, e.g. "party_parrot".'),
    image: imageField,
    guild: guildField,
    roles: z.array(z.string()).optional().describe('Only these roles can use it.'),
    reason: reasonField,
  },
  readOnly: false,
  permissions: ['Create Expressions'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['CreateGuildExpressions']);
    const name = args.name
      .trim()
      .replace(/^:|:$/g, '')
      .replace(/[\s-]+/g, '_');
    if (!EMOJI_NAME.test(name))
      throw new GuildoraError('Emoji names must be 2-32 letters, digits or underscores.');
    const file = await loadFile(args.image, {
      allowLocalPaths: ctx.config.transport === 'stdio',
      maxBytes: EMOJI_MAX,
    });
    const roles = args.roles?.map((r) => resolveRole(guild, r).id);
    const emoji = await guild.emojis.create({
      attachment: file.attachment,
      name,
      ...(roles?.length ? { roles } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
    return `Created emoji ${emojiLine(emoji)} (${bytes(file.attachment.length)}).`;
  },
});

const editEmoji = defineTool({
  name: 'edit_emoji',
  pack: 'emoji',
  title: 'Rename or restrict an emoji',
  description: 'Renames a custom emoji and/or sets which roles can use it ([] = everyone).',
  input: {
    emoji: z.string().describe('Emoji: <:name:id>, :name:, name or ID.'),
    guild: guildField,
    name: z.string().optional(),
    roles: z
      .array(z.string())
      .optional()
      .describe('Roles that can use it; [] removes the restriction.'),
    reason: reasonField,
  },
  readOnly: false,
  idempotent: true,
  permissions: ['Manage Expressions'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['ManageGuildExpressions']);
    const emoji = resolveGuildEmoji(guild, args.emoji);
    if (args.name === undefined && args.roles === undefined)
      throw new GuildoraError('Pass name and/or roles.');
    const name = args.name?.trim().replace(/[\s-]+/g, '_');
    if (name !== undefined && !EMOJI_NAME.test(name))
      throw new GuildoraError('Emoji names must be 2-32 letters, digits or underscores.');
    const updated = await emoji.edit({
      ...(name ? { name } : {}),
      ...(args.roles ? { roles: args.roles.map((r) => resolveRole(guild, r).id) } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
    return `Updated emoji ${emojiLine(updated)}.`;
  },
});

const deleteEmoji = defineTool({
  name: 'delete_emoji',
  pack: 'emoji',
  title: 'Delete a custom emoji',
  description:
    'Permanently deletes a custom emoji. Destructive: returns a dry run unless confirm is true.',
  input: {
    emoji: z.string().describe('Emoji: <:name:id>, :name:, name or ID.'),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Expressions'],
  async prepare(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['ManageGuildExpressions']);
    const emoji = resolveGuildEmoji(guild, args.emoji);
    if (emoji.managed)
      throw new GuildoraError(
        `:${emoji.name}: is managed by an integration and cannot be deleted.`,
      );
    return {
      summary: `delete emoji ${emojiLine(emoji)} from ${guild.name}`,
      async execute() {
        await emoji.delete(args.reason);
        return `Deleted emoji :${emoji.name}: (${emoji.id}).`;
      },
    };
  },
});

const listStickers = defineTool({
  name: 'list_stickers',
  pack: 'emoji',
  title: 'List stickers',
  description:
    "Lists the server's custom stickers with ID, format, related emoji tag and description.",
  input: { guild: guildField },
  readOnly: true,
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    const list = [...(await guild.stickers.fetch()).values()];
    return page(`${list.length} sticker(s) in ${guild.name}:`, list.map(stickerLine));
  },
});

const createSticker = defineTool({
  name: 'create_sticker',
  pack: 'emoji',
  title: 'Upload a sticker',
  description:
    'Uploads a custom sticker from a PNG, APNG, GIF (max 512 KB, 320x320) or Lottie JSON file. "tag" is the ' +
    'Unicode emoji it relates to (used for suggestions).',
  input: {
    name: z.string().min(2).max(30),
    tag: z.string().describe('Related Unicode emoji, e.g. "😂".'),
    file: fileSchema.describe('Sticker file: path (stdio only), https url, or base64.'),
    description: z.string().max(100).optional(),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  permissions: ['Create Expressions'],
  async run(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['CreateGuildExpressions']);
    if (!isUnicodeEmoji(args.tag))
      throw new GuildoraError('tag must be a Unicode emoji such as "😂".');
    const file = await loadFile(args.file, {
      allowLocalPaths: ctx.config.transport === 'stdio',
      maxBytes: STICKER_MAX,
    });
    const sticker = await guild.stickers.create({
      file: { attachment: file.attachment, name: file.name },
      name: args.name,
      tags: args.tag,
      ...(args.description ? { description: args.description } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
    return `Created sticker ${stickerLine(sticker)}.`;
  },
});

const deleteSticker = defineTool({
  name: 'delete_sticker',
  pack: 'emoji',
  title: 'Delete a sticker',
  description:
    'Permanently deletes a custom sticker. Destructive: returns a dry run unless confirm is true.',
  input: {
    sticker: z.string().describe('Sticker name or ID.'),
    guild: guildField,
    reason: reasonField,
  },
  readOnly: false,
  destructive: true,
  permissions: ['Manage Expressions'],
  async prepare(args, ctx) {
    const guild = await ctx.guild(args.guild);
    requireBotPermissions(guild, ['ManageGuildExpressions']);
    const sticker = resolveSticker(guild, args.sticker);
    return {
      summary: `delete sticker ${stickerLine(sticker)} from ${guild.name}`,
      async execute() {
        await sticker.delete(args.reason);
        return `Deleted sticker ${sticker.name} (${sticker.id}).`;
      },
    };
  },
});

export const emojiTools: AnyTool[] = [
  listEmoji,
  createEmoji,
  editEmoji,
  deleteEmoji,
  listStickers,
  createSticker,
  deleteSticker,
];
