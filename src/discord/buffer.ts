import type { Message } from 'discord.js';
import { MessageType } from './api.js';

/** A compact copy of a message received from the gateway while Guildora runs. */
export interface BufferedMessage {
  id: string;
  guildId: string;
  channelId: string;
  /** Thread parent, or the channel's category. */
  parentId: string | null;
  /** Category of the channel (or of the thread's parent). */
  categoryId: string | null;
  channelName: string;
  authorId: string;
  authorName: string;
  displayName: string | null;
  bot: boolean;
  createdTimestamp: number;
  content: string;
  attachments: string[];
  embeds: number;
  replyTo: string | null;
  /** Mentions the bot, replies to the bot, or mentions one of the bot's roles. */
  mentionsBot: boolean;
}

export interface BufferQuery {
  guildId: string;
  /** Only messages with a larger (newer) ID. */
  after?: string | undefined;
  /** Keep only these: channel IDs, thread parents, or categories. */
  scopeId?: string | undefined;
  includeBots?: boolean;
  onlyMentions?: boolean;
  limit: number;
}

export interface BufferResult {
  messages: BufferedMessage[];
  /** True if more matching messages exist after the last returned one. */
  more: boolean;
}

const MAX_CONTENT = 1500;

const newer = (a: string, b: string) => BigInt(a) > BigInt(b);

/**
 * Keeps the most recent messages seen on the gateway, so tools can answer "what is new
 * since I last looked" without re-reading every channel. Memory is bounded by `capacity`.
 */
export class MessageBuffer {
  private readonly items: BufferedMessage[] = [];
  /** When the buffer started receiving messages. */
  readonly startedAt = Date.now();
  dropped = 0;

  constructor(readonly capacity = 5000) {}

  get size(): number {
    return this.items.length;
  }

  /** Oldest timestamp still held (startedAt if nothing was dropped). */
  get coversSince(): number {
    return this.dropped > 0 && this.items[0] ? this.items[0].createdTimestamp : this.startedAt;
  }

  add(m: BufferedMessage): void {
    this.items.push(m);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
      this.dropped++;
    }
  }

  query(q: BufferQuery): BufferResult {
    const matching = this.items.filter(
      (m) =>
        m.guildId === q.guildId &&
        (!q.after || newer(m.id, q.after)) &&
        (q.includeBots || !m.bot) &&
        (!q.onlyMentions || m.mentionsBot) &&
        (!q.scopeId ||
          m.channelId === q.scopeId ||
          m.parentId === q.scopeId ||
          m.categoryId === q.scopeId),
    );
    return { messages: matching.slice(0, q.limit), more: matching.length > q.limit };
  }
}

/** Converts a gateway message into a buffer record; undefined for DMs and system messages. */
export function toBuffered(m: Message, botId: string): BufferedMessage | undefined {
  if (!m.guildId || !m.guild) return undefined;
  if (m.type !== MessageType.Default && m.type !== MessageType.Reply) return undefined;
  const channel = m.channel;
  const isThread = channel.isThread();
  const parentId = 'parentId' in channel ? (channel.parentId ?? null) : null;
  const categoryId = isThread ? (channel.parent?.parentId ?? null) : parentId;
  const me = m.guild.members.me;
  const mentionsBot =
    m.mentions.users.has(botId) ||
    m.mentions.repliedUser?.id === botId ||
    (me ? m.mentions.roles.some((r) => me.roles.cache.has(r.id)) : false);
  return {
    id: m.id,
    guildId: m.guildId,
    channelId: m.channelId,
    parentId,
    categoryId,
    channelName: ('name' in channel ? channel.name : null) ?? m.channelId,
    authorId: m.author.id,
    authorName: m.author.username,
    displayName: m.member?.displayName ?? m.author.globalName ?? null,
    bot: m.author.bot || m.webhookId !== null,
    createdTimestamp: m.createdTimestamp,
    content: m.content.length > MAX_CONTENT ? `${m.content.slice(0, MAX_CONTENT)}…` : m.content,
    attachments: [...m.attachments.values()].map((a) => a.name),
    embeds: m.embeds.length,
    replyTo: m.type === MessageType.Reply ? (m.reference?.messageId ?? null) : null,
    mentionsBot,
  };
}
