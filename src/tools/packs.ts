/** Every tool belongs to exactly one pack. Only enabled packs are registered with MCP. */
export const PACK_NAMES = [
  'core',
  'channels',
  'roles',
  'moderation',
  'threads',
  'voice',
  'webhooks',
  'invites',
  'emoji',
  'insights',
] as const;

export type PackName = (typeof PACK_NAMES)[number];

export const PACK_DESCRIPTIONS: Record<PackName, string> = {
  core: 'Server info, channels, members, roles (read), messages, DMs, reactions, pins, search',
  channels: 'Create, edit, move and delete channels and categories; permission overwrites',
  roles: 'Create, edit and delete roles; give and take roles from members',
  moderation: 'Kick, ban, unban, timeout, nicknames, bulk delete, audit log',
  threads: 'Threads and forum posts (including archived), forum tags',
  voice: 'Move, disconnect, mute and deafen voice members; scheduled events',
  webhooks: 'List, create and delete webhooks; send messages through them',
  invites: 'List, create, inspect and revoke invites',
  emoji: 'Custom emoji and stickers',
  insights: 'Export conversations, server snapshots and comparisons, message statistics',
};
