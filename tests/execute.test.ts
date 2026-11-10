import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../src/tools/types.js';
import { executeTool } from '../src/tools/execute.js';
import { GuildoraError } from '../src/mcp/errors.js';
import { recordRateLimit } from '../src/discord/ratelimit.js';
import { apiError, context } from './helpers.js';

const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

function destructive(execute = vi.fn(async () => 'Deleted #general.')) {
  const prepare = vi.fn(async (args: { channel: string }) => ({
    summary: `delete channel ${args.channel}`,
    warnings: ['Its 3 threads are deleted too.'],
    execute,
  }));
  const tool = defineTool({
    name: 'delete_thing',
    pack: 'channels',
    title: 'Delete a thing',
    description: 'Deletes a thing. Destructive: returns a dry run unless confirm is true.',
    input: { channel: z.string() },
    readOnly: false,
    destructive: true,
    prepare,
  });
  return { tool, prepare, execute };
}

describe('confirmation flow', () => {
  it('returns a dry run and changes nothing without confirm', async () => {
    const { tool, prepare, execute } = destructive();
    const res = await executeTool(tool, { channel: '#general' }, async () => context());
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe(
      [
        'DRY RUN: nothing was changed.',
        'Would: delete channel #general',
        'Warning: Its 3 threads are deleted too.',
        'To do it, call delete_thing again with the same arguments and "confirm": true.',
      ].join('\n'),
    );
    expect(prepare).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('treats confirm: false and confirm: "true" (string) as not confirmed', async () => {
    const { tool, execute } = destructive();
    await executeTool(tool, { channel: 'x', confirm: false }, async () => context());
    await executeTool(tool, { channel: 'x', confirm: 'true' }, async () => context());
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes with confirm: true and does not pass confirm to prepare', async () => {
    const { tool, prepare, execute } = destructive();
    const res = await executeTool(tool, { channel: '#general', confirm: true }, async () =>
      context(),
    );
    expect(textOf(res)).toBe('Deleted #general.');
    expect(execute).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0]).toEqual({ channel: '#general' });
  });

  it('surfaces prepare errors (e.g. unknown target) instead of a dry run', async () => {
    const tool = defineTool({
      name: 'delete_other',
      pack: 'channels',
      title: 'Delete other',
      description: 'Deletes something else. Destructive: returns a dry run unless confirm is true.',
      input: {},
      readOnly: false,
      destructive: true,
      prepare: async () => {
        throw new GuildoraError('No channel named "x" was found.');
      },
    });
    const res = await executeTool(tool, {}, async () => context());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('No channel named');
  });
});

describe('executeTool', () => {
  const tool = (run: () => Promise<string>, permissions?: string[]) =>
    defineTool({
      name: 'do_thing',
      pack: 'core',
      title: 'Do thing',
      description: 'Does a thing for testing purposes and returns a short result.',
      input: {},
      readOnly: false,
      ...(permissions ? { permissions } : {}),
      run,
    });

  it('maps Discord errors to actionable messages with the tool permissions', async () => {
    const res = await executeTool(
      tool(async () => {
        throw apiError(50013, 403, 'Missing Permissions');
      }, ['Manage Channels']),
      {},
      async () => context(),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('It needs Manage Channels');
  });

  it('reports a failed Discord connection as a tool error', async () => {
    const res = await executeTool(
      tool(async () => 'never'),
      {},
      async () => {
        throw new Error('Still connecting to Discord after 30s.');
      },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Still connecting');
  });

  it('appends a note when Discord rate-limited the call', async () => {
    const res = await executeTool(
      tool(async () => {
        recordRateLimit({ route: '/channels/:id/messages', retryAfter: 2500, global: false });
        return 'done';
      }),
      {},
      async () => context(),
    );
    expect(textOf(res)).toBe(
      'done\nNote: Discord rate-limited 1 request(s) during this call; waited 2.5s in total.',
    );
  });

  it('keeps rate-limit notes separate between concurrent calls', async () => {
    const slow = tool(async () => {
      recordRateLimit({ route: '/a', retryAfter: 1000, global: false });
      await new Promise((r) => setTimeout(r, 20));
      return 'slow';
    });
    const fast = tool(async () => 'fast');
    const [a, b] = await Promise.all([
      executeTool(slow, {}, async () => context()),
      executeTool(fast, {}, async () => context()),
    ]);
    expect(textOf(a)).toContain('rate-limited');
    expect(textOf(b)).toBe('fast');
  });
});
