import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { PackName } from './packs.js';
import type { AnyTool } from './types.js';
import { coreTools } from './core/index.js';
import { channelTools } from './channels/index.js';
import { roleTools } from './roles/index.js';
import { moderationTools } from './moderation/index.js';
import { threadTools } from './threads/index.js';
import { voiceTools } from './voice/index.js';
import { webhookTools } from './webhooks/index.js';
import { inviteTools } from './invites/index.js';
import { emojiTools } from './emoji/index.js';
import { insightsTools } from './insights/index.js';

export const ALL_TOOLS: readonly AnyTool[] = [
  ...coreTools,
  ...channelTools,
  ...roleTools,
  ...moderationTools,
  ...threadTools,
  ...voiceTools,
  ...webhookTools,
  ...inviteTools,
  ...emojiTools,
  ...insightsTools,
];

export interface SelectOptions {
  packs: readonly PackName[];
  readOnly: boolean;
}

/** Tools to expose: only enabled packs, and only non-mutating tools in read-only mode. */
export function selectTools(all: readonly AnyTool[], opts: SelectOptions): AnyTool[] {
  return all.filter((t) => opts.packs.includes(t.pack) && (!opts.readOnly || t.readOnly));
}

export const CONFIRM_FIELD = z
  .boolean()
  .optional()
  .describe(
    'Set to true to actually do it. Without it, nothing changes and a dry run is returned.',
  );

/** The schema sent to MCP clients. Destructive tools get the extra "confirm" flag. */
export function inputShape(tool: AnyTool): z.ZodRawShape {
  return tool.destructive ? { ...tool.input, confirm: CONFIRM_FIELD } : tool.input;
}

export function annotationsFor(tool: AnyTool): ToolAnnotations {
  return {
    title: tool.title,
    readOnlyHint: tool.readOnly,
    destructiveHint: tool.destructive === true,
    idempotentHint: tool.readOnly || tool.idempotent === true,
    openWorldHint: true,
  };
}
