import { readFile, stat } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { basename } from 'node:path';
import { GuildPremiumTier } from './api.js';
import { GuildoraError } from '../mcp/errors.js';
import { bytes } from './format.js';

export interface FileInput {
  path?: string | undefined;
  url?: string | undefined;
  base64?: string | undefined;
  name?: string | undefined;
}

export interface LoadedFile {
  attachment: Buffer;
  name: string;
}

export interface LoadOptions {
  /** Local paths are only allowed when the server runs on the user's machine (stdio). */
  allowLocalPaths: boolean;
  maxBytes: number;
}

const MiB = 1024 * 1024;

/** Upload limit for a server's boost tier (DMs and unboosted servers: 10 MiB). */
export function uploadLimit(tier: GuildPremiumTier | undefined): number {
  if (tier === GuildPremiumTier.Tier3) return 100 * MiB;
  if (tier === GuildPremiumTier.Tier2) return 50 * MiB;
  return 10 * MiB;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['::ffff:0:0', 96],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback, private, link-local, multicast and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) return blocked.check(address, 'ipv6');
  return true;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new GuildoraError(
      `Refusing to download from ${hostname}: it resolves to a private or local address.`,
    );
  }
}

async function download(rawUrl: string, maxBytes: number): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GuildoraError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') throw new GuildoraError('File URLs must use https://.');
  await assertPublicHost(url.hostname);
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (res.status >= 300 && res.status < 400) {
    throw new GuildoraError(
      `${url.host} answered with a redirect; pass the final direct file URL instead.`,
    );
  }
  if (!res.ok || !res.body)
    throw new GuildoraError(`Download failed: HTTP ${res.status} from ${url.host}.`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new GuildoraError(`File is ${bytes(declared)}, over the ${bytes(maxBytes)} limit.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new GuildoraError(`File is over the ${bytes(maxBytes)} limit.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function decodeBase64(input: string): Buffer {
  const data = input.startsWith('data:') ? input.slice(input.indexOf(',') + 1) : input;
  const clean = data.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean))
    throw new GuildoraError('base64 data is not valid base64.');
  return Buffer.from(clean, 'base64');
}

function nameFromUrl(url: string): string {
  try {
    return basename(new URL(url).pathname) || 'file';
  } catch {
    return 'file';
  }
}

/** Loads one file from exactly one of: a local path, an https URL, or base64 data. */
export async function loadFile(input: FileInput, opts: LoadOptions): Promise<LoadedFile> {
  const sources = [input.path, input.url, input.base64].filter((s) => s !== undefined && s !== '');
  if (sources.length !== 1) {
    throw new GuildoraError('Each file needs exactly one of "path", "url" or "base64".');
  }
  let data: Buffer;
  let name = input.name;
  if (input.path) {
    if (!opts.allowLocalPaths) {
      throw new GuildoraError(
        'Local file paths are disabled over HTTP. Pass "url" or "base64" instead.',
      );
    }
    const info = await stat(input.path).catch(() => {
      throw new GuildoraError(`File not found: ${input.path}`);
    });
    if (!info.isFile()) throw new GuildoraError(`Not a file: ${input.path}`);
    if (info.size > opts.maxBytes) {
      throw new GuildoraError(
        `${input.path} is ${bytes(info.size)}, over the ${bytes(opts.maxBytes)} limit.`,
      );
    }
    data = await readFile(input.path);
    name ??= basename(input.path);
  } else if (input.url) {
    data = await download(input.url, opts.maxBytes);
    name ??= nameFromUrl(input.url);
  } else {
    data = decodeBase64(input.base64!);
    if (data.length > opts.maxBytes) {
      throw new GuildoraError(
        `Data is ${bytes(data.length)}, over the ${bytes(opts.maxBytes)} limit.`,
      );
    }
    name ??= 'file';
  }
  return { attachment: data, name };
}
