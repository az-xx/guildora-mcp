import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describeError } from '../mcp/errors.js';
import { describeWaits, runWithRateLimitTracking } from '../discord/ratelimit.js';
import type { AnyTool, ToolContext } from './types.js';

function text(body: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: 'text', text: body }], isError: true }
    : { content: [{ type: 'text', text: body }] };
}

export function dryRunText(toolName: string, summary: string, warnings: string[] = []): string {
  const lines = ['DRY RUN: nothing was changed.', `Would: ${summary}`];
  for (const w of warnings) lines.push(`Warning: ${w}`);
  lines.push(`To do it, call ${toolName} again with the same arguments and "confirm": true.`);
  return lines.join('\n');
}

/**
 * Runs one tool call: waits for Discord, applies the confirmation gate for destructive tools,
 * reports rate-limit waits, and converts every error into an actionable message.
 */
export async function executeTool(
  tool: AnyTool,
  rawArgs: Record<string, unknown>,
  getContext: () => Promise<ToolContext>,
): Promise<CallToolResult> {
  try {
    const { value, waits } = await runWithRateLimitTracking(async () => {
      const ctx = await getContext();
      if (tool.destructive) {
        const { confirm, ...args } = rawArgs;
        const plan = await tool.prepare(args, ctx);
        if (confirm !== true) return dryRunText(tool.name, plan.summary, plan.warnings);
        return plan.execute();
      }
      return tool.run(rawArgs, ctx);
    });
    const note = describeWaits(waits);
    return text(note ? `${value}\n${note}` : value);
  } catch (err) {
    return text(
      describeError(err, {
        tool: tool.name,
        ...(tool.permissions ? { permissions: tool.permissions } : {}),
      }),
      true,
    );
  }
}
