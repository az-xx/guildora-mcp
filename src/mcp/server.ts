import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PackName } from '../tools/packs.js';
import { PACK_NAMES } from '../tools/packs.js';
import { annotationsFor, inputShape } from '../tools/registry.js';
import { executeTool } from '../tools/execute.js';
import { registerPrompts } from './prompts.js';
import type { AnyTool, ToolContext } from '../tools/types.js';

export interface ServerOptions {
  version: string;
  packs: readonly PackName[];
  readOnly: boolean;
}

export function serverInstructions(opts: ServerOptions): string {
  const disabled = PACK_NAMES.filter((p) => !opts.packs.includes(p));
  return [
    'Guildora manages a Discord server through a bot.',
    'Channel, role, member, category and emoji arguments accept an ID, a mention (<#id>, <@&id>, <@id>) or a name; ambiguous names return the candidates.',
    'Destructive tools (delete, kick, ban, bulk delete) return a dry run unless called with "confirm": true. Show the dry run to the user before confirming.',
    'Lists are paginated: pass next_cursor back as "cursor" to get more.',
    opts.readOnly ? 'Read-only mode is on: tools that change anything are hidden.' : '',
    disabled.length
      ? `Enabled packs: ${opts.packs.join(', ')}. Other packs (${disabled.join(', ')}) are off; the user can enable them with GUILDORA_PACKS.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Builds an MCP server exposing the given tools. Context is created per call. */
export function createMcpServer(
  tools: readonly AnyTool[],
  getContext: () => Promise<ToolContext>,
  opts: ServerOptions,
): McpServer {
  const server = new McpServer(
    { name: 'guildora', title: 'Guildora (Discord)', version: opts.version },
    { instructions: serverInstructions(opts) },
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: inputShape(tool),
        annotations: annotationsFor(tool),
      },
      async (args: Record<string, unknown>) => executeTool(tool, args, getContext),
    );
  }
  registerPrompts(server, new Set(tools.map((t) => t.name)));
  return server;
}
