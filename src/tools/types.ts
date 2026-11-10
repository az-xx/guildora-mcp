import type { Client, Guild } from 'discord.js';
import type { z } from 'zod';
import type { Config } from '../config.js';
import type { IntentStatus } from '../discord/intents.js';
import type { MessageBuffer } from '../discord/buffer.js';
import type { PackName } from './packs.js';

/** What every tool handler receives. */
export interface ToolContext {
  client: Client<true>;
  config: Config;
  intents: IntentStatus;
  /** Messages received since startup; absent in tests and one-off scripts. */
  buffer?: MessageBuffer;
  /** Resolves a server from an ID or name, falling back to DISCORD_GUILD_ID or the only server. */
  guild(input?: string): Promise<Guild>;
}

/** An image returned to the model (base64), e.g. a screenshot attached to a message. */
export interface ToolImage {
  data: string;
  mimeType: string;
}

/** A tool result with images. Plain strings are the common case. */
export interface RichOutput {
  text: string;
  images: ToolImage[];
}

export type ToolOutput = string | RichOutput;

/** The result of preparing a destructive action: a description and the deferred action. */
export interface Plan {
  /** What would happen, e.g. "Delete channel #general (123)". */
  summary: string;
  /** Extra facts the model should weigh before confirming. */
  warnings?: string[];
  execute(): Promise<string>;
}

interface ToolBase<S extends z.ZodRawShape> {
  name: string;
  pack: PackName;
  title: string;
  /** What it does, when to use it instead of a similar tool, and what it returns. */
  description: string;
  input: S;
  /** Human-readable Discord permissions the bot needs (used in docs and error messages). */
  permissions?: readonly string[];
  /** Calling twice with the same arguments has no further effect. */
  idempotent?: boolean;
}

export interface ReadTool<S extends z.ZodRawShape> extends ToolBase<S> {
  readOnly: true;
  destructive?: false;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolOutput>;
}

export interface WriteTool<S extends z.ZodRawShape> extends ToolBase<S> {
  readOnly: false;
  destructive?: false;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolOutput>;
}

/** Destructive tools never act directly: they return a Plan, executed only with confirm: true. */
export interface DestructiveTool<S extends z.ZodRawShape> extends ToolBase<S> {
  readOnly: false;
  destructive: true;
  prepare(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<Plan>;
}

export type ToolDef<S extends z.ZodRawShape = z.ZodRawShape> =
  ReadTool<S> | WriteTool<S> | DestructiveTool<S>;

/** Type-erased tool, so tools with different schemas can live in one array. */
export type AnyTool = ToolDef<z.ZodRawShape>;

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): AnyTool {
  return def as unknown as AnyTool;
}
