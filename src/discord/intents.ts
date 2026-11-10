import { ApplicationFlags, GatewayIntentBits } from './api.js';

export interface IntentStatus {
  /** Server Members intent enabled in the Developer Portal. */
  members: boolean;
  /** Message Content intent enabled in the Developer Portal. */
  messageContent: boolean;
}

/** Reads the privileged-intent switches from the application's flags (GET /applications/@me). */
export function intentStatusFromFlags(flags: number): IntentStatus {
  const has = (bit: number) => (flags & bit) === bit;
  return {
    members:
      has(ApplicationFlags.GatewayGuildMembers) || has(ApplicationFlags.GatewayGuildMembersLimited),
    messageContent:
      has(ApplicationFlags.GatewayMessageContent) ||
      has(ApplicationFlags.GatewayMessageContentLimited),
  };
}

/**
 * Gateway intents to request. Privileged intents are only requested when enabled in the
 * portal; requesting a disabled one makes Discord close the connection (code 4014).
 */
export function gatewayIntents(status: IntentStatus): number[] {
  const intents: number[] = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildExpressions,
    // Keeps channel.lastMessageId current for recent_activity and list_unanswered.
    GatewayIntentBits.GuildMessages,
  ];
  if (status.members) intents.push(GatewayIntentBits.GuildMembers);
  // Gateway events only carry message text if the intent is also requested here.
  if (status.messageContent) intents.push(GatewayIntentBits.MessageContent);
  return intents;
}

/** Human-readable warnings for intents that are switched off. */
export function intentWarnings(status: IntentStatus): string[] {
  const warnings: string[] = [];
  if (!status.messageContent) {
    warnings.push(
      'Message Content intent is OFF: message text, embeds and attachments will come back empty ' +
        '(except DMs and messages that mention the bot). Enable it in the Developer Portal: ' +
        'your app > Bot > Privileged Gateway Intents > Message Content Intent.',
    );
  }
  if (!status.members) {
    warnings.push(
      'Server Members intent is OFF: list_members without a query, role filters and member ' +
        'caching are unavailable. Enable it in the Developer Portal: your app > Bot > ' +
        'Privileged Gateway Intents > Server Members Intent.',
    );
  }
  return warnings;
}
