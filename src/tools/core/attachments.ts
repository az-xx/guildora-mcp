import { z } from 'zod';
import type { Attachment } from 'discord.js';
import { defineTool, type ToolImage } from '../types.js';
import { messageArg, messageField, messageTargetFields } from '../shared.js';
import { GuildoraError } from '../../mcp/errors.js';
import { fetchDiscordCdn } from '../../discord/files.js';
import { bytes, fmtChannel } from '../../discord/format.js';

/** Longest edge and pixel budget that vision models handle without further downscaling. */
const MAX_EDGE = 1568;
const MAX_PIXELS = 1_150_000;
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_IMAGES = 4;
const MAX_TEXT_BYTES = 200_000;
const DEFAULT_TEXT_CHARS = 20_000;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_EXT =
  /\.(txt|log|md|json|jsonl|csv|tsv|xml|ya?ml|toml|ini|cfg|conf|js|ts|py|java|cs|cpp|c|h|go|rs|rb|php|sh|ps1|bat|sql|html?|css)$/i;

/** Size that fits within the edge and pixel limits, keeping the aspect ratio. */
export function fitImage(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width, height };
  const scale = Math.min(
    1,
    MAX_EDGE / Math.max(width, height),
    Math.sqrt(MAX_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Discord's media proxy resizes images on the fly via width/height query parameters. */
export function resizedProxyUrl(proxyURL: string, width: number, height: number): string {
  const url = new URL(proxyURL);
  url.searchParams.set('width', String(width));
  url.searchParams.set('height', String(height));
  return url.toString();
}

export type AttachmentKind = 'image' | 'text' | 'other';

export function attachmentKind(a: Pick<Attachment, 'contentType' | 'name'>): AttachmentKind {
  const type = (a.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (IMAGE_TYPES.has(type)) return 'image';
  if (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml' ||
    TEXT_EXT.test(a.name)
  ) {
    return 'text';
  }
  return 'other';
}

function describe(a: Attachment): string {
  const dims = a.width && a.height ? `, ${a.width}x${a.height}` : '';
  return `${a.name} (${a.contentType ?? 'unknown type'}, ${bytes(a.size)}${dims}, id ${a.id})`;
}

async function loadImage(a: Attachment): Promise<ToolImage> {
  const mimeType = (a.contentType ?? 'image/png').split(';')[0]!.trim();
  let url = a.url;
  if (a.width && a.height) {
    const fit = fitImage(a.width, a.height);
    if (fit.width < a.width || a.size > MAX_IMAGE_BYTES)
      url = resizedProxyUrl(a.proxyURL, fit.width, fit.height);
  }
  const { data, type } = await fetchDiscordCdn(url, MAX_IMAGE_BYTES);
  const served = type.split(';')[0]!.trim();
  return { data: data.toString('base64'), mimeType: IMAGE_TYPES.has(served) ? served : mimeType };
}

async function loadText(a: Attachment, maxChars: number): Promise<string> {
  const { data } = await fetchDiscordCdn(a.url, MAX_TEXT_BYTES);
  if (data.includes(0)) throw new GuildoraError(`${a.name} looks like a binary file, not text.`);
  const text = data.toString('utf8');
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n… (${text.length - maxChars} more characters not shown; raise max_chars to see more)`
    : text;
}

export const getAttachment = defineTool({
  name: 'get_attachment',
  pack: 'core',
  title: 'Open message attachments',
  description:
    "Opens a message's attachments so you can see them: images (screenshots, photos) come back as images, " +
    'scaled down to a readable size; text files (logs, code, JSON, CSV) come back as text. Other files are ' +
    'listed with their size and URL. Pick one with "attachment" (ID or file name), or get all (up to 4 images).',
  input: {
    message: messageField,
    ...messageTargetFields,
    attachment: z
      .string()
      .optional()
      .describe('Attachment ID or file name. Default: all attachments.'),
    max_chars: z
      .number()
      .int()
      .min(500)
      .max(100_000)
      .optional()
      .describe('Max characters per text file (default 20000).'),
  },
  readOnly: true,
  async run(args, ctx) {
    const m = await messageArg(ctx, args);
    let list = [...m.attachments.values()];
    if (list.length === 0) {
      throw new GuildoraError(
        `Message ${m.id} has no attachments${m.embeds.length ? ' (it has embeds; read_messages shows them)' : ''}.`,
      );
    }
    if (args.attachment) {
      const key = args.attachment.trim().toLowerCase();
      list = list.filter((a) => a.id === key || a.name.toLowerCase() === key);
      if (list.length === 0) {
        throw new GuildoraError(
          `No attachment "${args.attachment}" on message ${m.id}. It has: ${[...m.attachments.values()].map(describe).join('; ')}.`,
        );
      }
    }
    const lines = [`${list.length} attachment(s) on message ${m.id} in ${fmtChannel(m.channel)}:`];
    const images: ToolImage[] = [];
    for (const a of list) {
      const kind = attachmentKind(a);
      if (kind === 'image') {
        if (images.length >= MAX_IMAGES) {
          lines.push(
            `- ${describe(a)}: not shown (max ${MAX_IMAGES} images per call; pass "attachment" to pick one).`,
          );
          continue;
        }
        try {
          images.push(await loadImage(a));
          lines.push(`- ${describe(a)}: shown below as image ${images.length}.`);
        } catch (e) {
          lines.push(
            `- ${describe(a)}: could not load (${e instanceof Error ? e.message : String(e)}). URL: ${a.url}`,
          );
        }
      } else if (kind === 'text') {
        try {
          lines.push(
            `- ${describe(a)}:`,
            '```',
            await loadText(a, args.max_chars ?? DEFAULT_TEXT_CHARS),
            '```',
          );
        } catch (e) {
          lines.push(
            `- ${describe(a)}: could not read (${e instanceof Error ? e.message : String(e)}). URL: ${a.url}`,
          );
        }
      } else {
        lines.push(`- ${describe(a)}: this type cannot be shown. URL: ${a.url}`);
      }
    }
    const text = lines.join('\n');
    return images.length ? { text, images } : text;
  },
});
