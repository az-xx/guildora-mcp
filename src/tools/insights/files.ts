import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { ToolContext } from '../types.js';

/** Characters that are not allowed in Windows/macOS/Linux file names, plus control characters. */
const UNSAFE = /[<>:"/\\|?*]/g;

/** Replaces control characters (code points below 32) without a control-character regex. */
const stripControl = (s: string) => [...s].map((ch) => (ch.charCodeAt(0) < 32 ? '-' : ch)).join('');

export function safeFileName(name: string): string {
  const cleaned = stripControl(name)
    .replace(UNSAFE, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, 120) || 'export';
}

export function dateStamp(d = new Date()): string {
  return d.toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Picks "name.ext", or "name-2.ext", "name-3.ext"… so existing files are never overwritten. */
export async function uniquePath(path: string): Promise<string> {
  if (!(await exists(path))) return path;
  const ext = extname(path);
  const base = path.slice(0, path.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Too many files named like ${path}.`);
}

/**
 * Writes an export to disk when Guildora runs locally (stdio) and returns the path. Over HTTP the
 * server may run on another machine, so nothing is written and undefined is returned.
 */
export async function writeExport(
  ctx: ToolContext,
  defaultName: string,
  contents: string,
  pathArg?: string,
): Promise<string | undefined> {
  if (ctx.config.transport !== 'stdio') return undefined;
  const target = pathArg
    ? isAbsolute(pathArg)
      ? pathArg
      : resolve(ctx.config.exportDir, pathArg)
    : join(ctx.config.exportDir, defaultName);
  await mkdir(dirname(target), { recursive: true });
  const path = await uniquePath(target);
  await writeFile(path, contents, 'utf8');
  return path;
}
