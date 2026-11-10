import type { AnyTool } from '../types.js';
import { getChannel, getServerInfo, listChannels, listRoles } from './server.js';
import { getMember, listMembers } from './members.js';
import {
  addReaction,
  deleteMessage,
  editMessage,
  getMessage,
  pinMessage,
  readMessages,
  removeReaction,
  sendMessage,
} from './messages.js';
import { searchMessages } from './search.js';
import { getAttachment } from './attachments.js';
import { listUnanswered, recentActivity } from './activity.js';
import { checkAccess } from './access.js';
import { getNewMessages } from './new-messages.js';

export const coreTools: AnyTool[] = [
  getServerInfo,
  listChannels,
  getChannel,
  listRoles,
  listMembers,
  getMember,
  readMessages,
  getMessage,
  getAttachment,
  searchMessages,
  recentActivity,
  getNewMessages,
  listUnanswered,
  sendMessage,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
  pinMessage,
  checkAccess,
];
