import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Ready-made workflows exposed as MCP prompts (they show up as slash commands or prompt pickers
 * in MCP clients). The text adapts to the tools that are actually enabled.
 */
export interface PromptDef {
  name: string;
  title: string;
  description: string;
  args: Record<string, z.ZodOptional<z.ZodString>>;
  build(args: Record<string, string | undefined>, tools: ReadonlySet<string>): string;
}

const NO_CHANGES =
  'Do not send, edit or delete anything, and do not change tags or settings, unless I explicitly approve that specific action.';

function replyRule(tools: ReadonlySet<string>): string {
  return tools.has('send_message')
    ? 'Only after I approve a draft, post it with send_message (reply_to the message it answers, in the same channel or thread).'
    : 'Guildora is read-only here, so only write drafts I can post myself.';
}

export const PROMPTS: PromptDef[] = [
  {
    name: 'server_digest',
    title: 'Server digest',
    description: 'Summarise what happened in the server recently and what needs attention.',
    args: {
      since: z.string().optional().describe('How far back, e.g. "24h" (default), "7d".'),
      guild: z.string().optional().describe('Server name or ID (optional).'),
    },
    build(args, tools) {
      const since = args.since || '24h';
      const guild = args.guild ? ` Use guild "${args.guild}" in every tool call.` : '';
      const steps = [
        `1. Call recent_activity with since "${since}" (follow next_cursor until you have the busiest ~40 channels).`,
        '2. For the channels and threads that look important, call read_messages to understand what was said.',
        tools.has('list_unanswered')
          ? `3. Call list_unanswered with since "${since === '24h' ? '7d' : since}" to find people waiting for staff.`
          : '',
        tools.has('read_forum')
          ? '4. If there are forums with new posts, skim them with read_forum.'
          : '',
      ].filter(Boolean);
      return [
        `Give me a digest of my Discord server since ${since}.${guild}`,
        ...steps,
        'Then answer in this shape, concise:',
        '- Highlights: the 3-7 most important things that happened.',
        '- Needs attention: who is waiting for staff, how long, and where (channel names and message IDs).',
        '- By channel: one line per active channel worth mentioning.',
        '- Bots and automation: one line, only if something unusual happened.',
        NO_CHANGES,
      ].join('\n');
    },
  },
  {
    name: 'triage_forum',
    title: 'Triage a forum',
    description:
      'Review the posts of a forum (bug reports, questions, suggestions) and propose next steps.',
    args: {
      forum: z.string().optional().describe('Forum channel name or ID, e.g. "bug-reports".'),
      tag: z.string().optional().describe('Only posts with this tag (optional).'),
    },
    build(args, tools) {
      const forum = args.forum
        ? `the forum "${args.forum}"`
        : 'the server\'s bug-report forum (find it with list_channels type "forum"; ask me if there are several)';
      const read = tools.has('read_forum')
        ? `1. Call read_forum on ${forum}${args.tag ? ` with tags ["${args.tag}"]` : ''} and replies 2; follow next_cursor for older posts if needed.`
        : `1. Call list_threads on ${forum}, then read_messages on each post.`;
      return [
        `Triage ${forum}.`,
        read,
        tools.has('get_attachment')
          ? '2. When a post has screenshots or log files, open them with get_attachment before judging it.'
          : '',
        tools.has('list_unanswered')
          ? '3. Call list_unanswered scoped to the forum to see which posts wait for staff.'
          : '',
        'Then give me a table: post (name and ID), reporter, tags, waiting for staff (yes/no and how long), one-line summary, severity (high/medium/low with a reason), and the suggested next step.',
        'After the table, write a short draft reply for each post that is waiting for staff.',
        replyRule(tools),
        NO_CHANGES,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'reply_queue',
    title: 'Reply queue',
    description: 'Find tickets and conversations waiting for a staff reply and draft answers.',
    args: {
      scope: z
        .string()
        .optional()
        .describe('Category, channel or forum to check (default: whole server).'),
      staff_roles: z
        .string()
        .optional()
        .describe('Comma-separated staff role names (default: by permission).'),
    },
    build(args, tools) {
      const scope = args.scope ? ` with scope "${args.scope}"` : '';
      const roles = args.staff_roles
        ? ` and staff_roles ${JSON.stringify(
            args.staff_roles
              .split(',')
              .map((r) => r.trim())
              .filter(Boolean),
          )}`
        : '';
      return [
        `1. Call list_unanswered${scope}${roles} (follow next_cursor if it says more channels remain).`,
        '2. For the longest-waiting ones (up to 10), call read_messages on that channel or thread to understand the request.',
        tools.has('get_attachment')
          ? '3. Open screenshots or files with get_attachment when they matter.'
          : '',
        'Then list them from longest wait to shortest: where, who, how long, what they need, and a draft reply in the language they wrote in.',
        replyRule(tools),
        NO_CHANGES,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'catch_up',
    title: 'Catch up on new messages',
    description: 'Summarise messages that arrived during this session, mentions of the bot first.',
    args: {
      scope: z.string().optional().describe('Channel, category or forum (default: whole server).'),
    },
    build(args, tools) {
      if (!tools.has('get_new_messages')) {
        return `Call recent_activity with since "2h"${args.scope ? ` and scope "${args.scope}"` : ''} and summarise what happened. ${NO_CHANGES}`;
      }
      const scope = args.scope ? ` with scope "${args.scope}"` : '';
      return [
        `1. Call get_new_messages${scope} with only_mentions true, then again without it (follow next_cursor until done).`,
        'Summarise: first anything that mentions or replies to the bot, then other notable messages grouped by channel.',
        'Finish with the latest next_cursor so I can ask you to catch up again later from there.',
        NO_CHANGES,
      ].join('\n');
    },
  },
];

/** Registers every prompt with the server. */
export function registerPrompts(server: McpServer, tools: ReadonlySet<string>): void {
  for (const p of PROMPTS) {
    server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: p.args },
      (args) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: p.build(args as Record<string, string | undefined>, tools),
            },
          },
        ],
      }),
    );
  }
}
