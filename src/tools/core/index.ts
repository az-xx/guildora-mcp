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

export const coreTools: AnyTool[] = [
  getServerInfo,
  listChannels,
  getChannel,
  listRoles,
  listMembers,
  getMember,
  readMessages,
  getMessage,
  searchMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  addReaction,
  removeReaction,
  pinMessage,
];
