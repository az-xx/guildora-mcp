import { apiErrorCode, isDiscordApiError, isHttpError, isRateLimitError } from '../discord/api.js';

/**
 * An error whose message is written for the model: it says what went wrong and what to do
 * next. Tools throw this for validation, resolution and pre-flight permission failures.
 */
export class GuildoraError extends Error {
  override name = 'GuildoraError';
}

export interface ErrorContext {
  /** Tool name, for messages such as "call X again". */
  tool?: string;
  /** Human-readable permissions the tool needs, e.g. ["Manage Roles"]. */
  permissions?: readonly string[];
}

/** Discord JSON error codes → what the model should do about them. */
const CODE_HINTS: Record<number, string> = {
  10003:
    'Unknown channel: it was deleted or the bot cannot see it. Use list_channels to find valid channels.',
  10004: 'Unknown server: the bot is not in that server.',
  10006: 'Unknown invite: it expired, was revoked, or the code is wrong.',
  10007: 'Unknown member: that user is not in this server.',
  10008:
    'Unknown message: it was deleted or the ID is wrong. Use read_messages to find valid message IDs.',
  10011: 'Unknown role: it was deleted or the ID is wrong. Use list_roles to find valid roles.',
  10013: 'Unknown user: no Discord user has that ID.',
  10014: 'Unknown emoji: use list_emoji to see the server emoji.',
  10015: 'Unknown webhook: use list_webhooks to find valid webhooks.',
  10026: 'Unknown ban: that user is not banned. Use list_bans to see bans.',
  10060: 'Unknown sticker.',
  10070: 'Unknown scheduled event: use list_events to find valid events.',
  20028: 'This channel has a write rate limit (slowmode or bulk limits). Wait and try again.',
  30001: 'Maximum number of servers reached for this bot.',
  30003: 'Maximum number of pins (50) reached in this channel. Unpin something first.',
  30005: 'Maximum number of roles (250) reached.',
  30007: 'Maximum number of webhooks (15) reached in this channel. Delete one first.',
  30008: 'Maximum number of emoji reached for this server boost level.',
  30010: 'Maximum number of reactions (20) reached on this message.',
  30013: 'Maximum number of channels (500) reached.',
  30039: 'Maximum number of stickers reached for this server boost level.',
  40005: 'The upload is too large for this server. Send a smaller file.',
  40060: 'This interaction was already acknowledged.',
  50001:
    'Missing Access: the bot cannot see this channel or resource. Give the bot (or one of its roles) View Channel there.',
  50006: 'Cannot send an empty message: provide content, embeds or files.',
  50007:
    'Cannot send messages to this user: they have DMs from server members turned off, blocked the bot, or share no server with it.',
  50008: 'Cannot send messages in a voice channel of this type.',
  50013: 'Missing Permissions.',
  50021: 'This action cannot be performed on a system message.',
  50024: 'This action cannot be performed on this channel type.',
  50033: 'Invalid recipients.',
  50034:
    'Messages older than 14 days cannot be bulk deleted. Delete them one by one with delete_message.',
  50035: 'Invalid input.',
  50045: 'File uploaded exceeds the maximum size.',
  50046: 'Invalid file uploaded.',
  50055: 'Invalid server.',
  50083: 'This thread is archived. Unarchive it first with edit_thread (archived: false).',
  50101: 'This channel requires a community server feature that is not enabled.',
  50109: 'The request body is invalid.',
  160002: 'Cannot reply without the Read Message History permission.',
  160005: 'This thread is locked.',
  160006: 'Maximum number of active threads reached.',
};

function flattenFormErrors(raw: unknown, path = ''): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '_errors' && Array.isArray(value)) {
      for (const e of value as { message?: string }[]) {
        out.push(`${path || 'body'}: ${e.message ?? 'invalid'}`);
      }
    } else {
      out.push(...flattenFormErrors(value, path ? `${path}.${key}` : key));
    }
  }
  return out;
}

/** Turns any thrown value into a short, actionable message. Never includes stack traces. */
export function describeError(err: unknown, ctx: ErrorContext = {}): string {
  if (err instanceof GuildoraError) return err.message;

  if (isRateLimitError(err)) {
    const seconds = Math.ceil(err.retryAfter / 1000);
    return (
      `Rate limited by Discord on ${err.method.toUpperCase()} ${err.route}` +
      `${err.global ? ' (global limit)' : ''}. Try again in about ${seconds}s. ` +
      'Avoid repeating this call in a tight loop.'
    );
  }

  if (isDiscordApiError(err)) {
    const code = apiErrorCode(err);
    let msg = CODE_HINTS[code] ?? `Discord API error ${code}: ${err.message}`;
    if (code === 50013) {
      const perms = ctx.permissions?.length ? ctx.permissions.join(', ') : undefined;
      msg =
        'Missing Permissions: the bot is not allowed to do this. ' +
        (perms ? `It needs ${perms}. ` : '') +
        'Check the bot role in Server Settings > Roles and any channel permission overwrites. ' +
        "For actions on members or roles, the bot's highest role must also be above the target's highest role.";
    }
    if (code === 50035) {
      const details = flattenFormErrors(err.rawError.errors);
      msg = `Invalid input rejected by Discord${details.length ? `: ${details.slice(0, 5).join('; ')}` : `: ${err.message}`}.`;
    }
    if (err.status === 404 && !CODE_HINTS[code]) {
      msg = `Not found (Discord ${code}): ${err.message}.`;
    }
    return msg;
  }

  if (isHttpError(err)) {
    return `Discord returned HTTP ${err.status} (${err.message}). This is usually temporary; try again shortly.`;
  }

  if (err instanceof Error) {
    if (err.name === 'AbortError' || /timed? ?out/i.test(err.message)) {
      return 'The request to Discord timed out. Try again shortly.';
    }
    const code = (err as { code?: unknown }).code;
    if (code === 'GuildMembersTimeout') {
      return 'Timed out fetching members. Enable the Server Members intent or use a query.';
    }
    return err.message;
  }
  return String(err);
}
