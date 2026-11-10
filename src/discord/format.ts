import type { Attachment, Channel, GuildMember, Message, Role, User } from 'discord.js';
import { ChannelType, MessageType } from './api.js';
import { channelKind } from './resolve.js';

/** "2026-11-10T18:04:05Z" (seconds precision, UTC). */
export function ts(date: Date | number | null | undefined): string {
  if (date === null || date === undefined) return 'unknown';
  const d = typeof date === 'number' ? new Date(date) : date;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function fmtChannel(c: Channel | null | undefined): string {
  if (!c) return 'unknown channel';
  if (c.type === ChannelType.DM) return `DM with @${c.recipient?.username ?? 'unknown'} (${c.id})`;
  const name = 'name' in c && c.name ? c.name : c.id;
  if (c.type === ChannelType.GuildCategory) return `category "${name}" (${c.id})`;
  return `#${name} (${c.id})`;
}

export function fmtChannelWithKind(c: Channel): string {
  return `${fmtChannel(c)} [${channelKind(c.type)}]`;
}

export function fmtUser(
  u: (Pick<User, 'id' | 'bot'> & { username: string | null }) | null | undefined,
): string {
  if (!u) return 'unknown user';
  return `@${u.username ?? 'unknown'} (${u.id})${u.bot ? ' [bot]' : ''}`;
}

export function fmtMember(m: GuildMember): string {
  const shown = m.displayName !== m.user.username ? `${m.displayName} ` : '';
  return `${shown}@${m.user.username} (${m.id})${m.user.bot ? ' [bot]' : ''}`;
}

export function fmtRole(r: Role): string {
  return r.id === r.guild.id ? '@everyone' : `@${r.name} (${r.id})`;
}

function fmtAttachment(a: Attachment, withUrl: boolean): string {
  return `${a.name} (${a.contentType ?? 'file'}, ${bytes(a.size)}, id ${a.id})${withUrl ? ` ${a.url}` : ''}`;
}

export interface FormatMessageOptions {
  /** Max characters of content to include (default: no limit beyond Discord's own). */
  maxContent?: number;
  /** Include attachment URLs (long signed CDN links). Default false; get_message enables it. */
  attachmentUrls?: boolean;
}

/** Compact, model-friendly rendering of one message. */
export function fmtMessage(m: Message, opts: FormatMessageOptions = {}): string {
  const author = m.member ? fmtMember(m.member) : fmtUser(m.author);
  const head = [`[${ts(m.createdAt)}] ${author} · msg ${m.id}`];
  if (m.reference?.messageId && m.type === MessageType.Reply)
    head.push(`reply to ${m.reference.messageId}`);
  if (m.editedAt) head.push('edited');
  if (m.pinned) head.push('pinned');
  if (m.thread) head.push(`thread ${m.thread.id}`);
  const lines = [head.join(' · ')];

  const content = opts.maxContent ? truncate(m.content, opts.maxContent) : m.content;
  if (content) lines.push(...content.split('\n').map((l) => `  ${l}`));
  for (const a of m.attachments.values())
    lines.push(`  [attachment] ${fmtAttachment(a, opts.attachmentUrls === true)}`);
  for (const e of m.embeds) {
    const parts = [e.title, e.description ? truncate(e.description, 200) : null, e.url].filter(
      Boolean,
    );
    lines.push(`  [embed] ${parts.join(' — ') || '(no text)'}`);
  }
  for (const s of m.stickers.values()) lines.push(`  [sticker] ${s.name} (${s.id})`);
  if (m.poll) lines.push(`  [poll] ${m.poll.question.text ?? ''}`);
  const reactions = [...m.reactions.cache.values()].map((r) => `${r.emoji.toString()} ${r.count}`);
  if (reactions.length) lines.push(`  reactions: ${reactions.join(', ')}`);
  if (
    !content &&
    m.attachments.size === 0 &&
    m.embeds.length === 0 &&
    m.stickers.size === 0 &&
    !m.poll
  ) {
    lines.push('  (no content)');
  }
  return lines.join('\n');
}

/** Renders a page of items with a header and an optional next cursor. */
export function page(
  header: string,
  lines: string[],
  nextCursor?: string,
  footer?: string,
): string {
  const out = [header, ...(lines.length ? lines : ['(none)'])];
  if (nextCursor !== undefined) out.push(`next_cursor: ${nextCursor}`);
  if (footer) out.push(footer);
  return out.join('\n');
}

/** Paginates an in-memory list by offset. */
export function slicePage<T>(
  items: T[],
  offset: number,
  limit: number,
): { items: T[]; next?: string } {
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  return end < items.length ? { items: slice, next: String(end) } : { items: slice };
}
