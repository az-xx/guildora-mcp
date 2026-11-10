import type { APIApplication, Client } from 'discord.js';
import { isDiscordApiError } from './api.js';
import { MessageBuffer, toBuffered } from './buffer.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import {
  gatewayIntents,
  intentStatusFromFlags,
  intentWarnings,
  type IntentStatus,
} from './intents.js';
import { MAX_QUEUED_WAIT_MS, recordRateLimit } from './ratelimit.js';

/** A startup failure the user must fix (bad token, disabled intent). The process should exit. */
export class FatalDiscordError extends Error {
  override name = 'FatalDiscordError';
}

const READY_TIMEOUT_MS = 30_000;

/**
 * Owns the discord.js client. MCP starts serving before Discord is connected; tools call
 * waitReady(), so the handshake and tools/list never wait for the gateway.
 */
export class DiscordConnection {
  client: Client | undefined;
  intents: IntentStatus = { members: false, messageContent: false };
  warnings: string[] = [];
  /** New messages seen on the gateway since startup (for get_new_messages). */
  readonly buffer = new MessageBuffer();
  private failure: Error | undefined;
  private readonly ready: Promise<Client<true>>;
  private resolveReady!: (c: Client<true>) => void;
  private rejectReady!: (e: Error) => void;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Avoid unhandled-rejection noise; failures are surfaced through start() and waitReady().
    this.ready.catch(() => undefined);
  }

  /** Validates the token, checks intents, then connects to the gateway. */
  async start(): Promise<void> {
    try {
      // Loaded here, not at module level: importing discord.js takes most of a second and
      // must not delay the MCP handshake.
      const { Client, Events, Options, REST, Routes } = await import('discord.js');
      const app = await this.probeApplication(
        new REST({ version: '10' }),
        Routes.currentApplication(),
      );
      this.intents = intentStatusFromFlags(app.flags ?? 0);
      this.warnings = intentWarnings(this.intents);
      for (const w of this.warnings) this.logger.warn(w);

      const client = new Client({
        intents: gatewayIntents(this.intents),
        rest: { rejectOnRateLimit: (info) => info.retryAfter > MAX_QUEUED_WAIT_MS },
        makeCache: Options.cacheWithLimits({
          ...Options.DefaultMakeCacheSettings,
          MessageManager: 25,
          PresenceManager: 0,
        }),
        allowedMentions: { parse: ['users', 'roles'], repliedUser: true },
      });
      client.rest.on('rateLimited', (info) => {
        recordRateLimit(info);
        this.logger.debug(`rate limited on ${info.route} for ${info.retryAfter}ms`);
      });
      client.on(Events.MessageCreate, (m) => {
        try {
          const record = client.user ? toBuffered(m, client.user.id) : undefined;
          if (record) this.buffer.add(record);
        } catch (e) {
          this.logger.debug(
            `could not buffer message: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      });
      client.on(Events.Error, (e) => this.logger.error(`Discord client error: ${e.message}`));
      client.on(Events.ShardDisconnect, (event) => {
        if (event.code === 4004 || event.code === 4014) {
          this.fail(
            new FatalDiscordError(
              event.code === 4004
                ? 'Discord rejected DISCORD_TOKEN on the gateway (4004).'
                : 'Discord refused a privileged intent (4014). Check Bot > Privileged Gateway Intents.',
            ),
          );
        }
      });
      this.client = client;

      const readyEvent = new Promise<Client<true>>((resolve) =>
        client.once(Events.ClientReady, (c) => resolve(c)),
      );
      await client.login(this.config.token);
      const readyClient = await readyEvent;
      this.logger.info(
        `Connected to Discord as ${readyClient.user.tag} in ${readyClient.guilds.cache.size} server(s).`,
      );
      this.resolveReady(readyClient);
    } catch (e) {
      const err = this.toFatal(e);
      this.fail(err);
      throw err;
    }
  }

  /** Resolves with the ready client, or rejects with an actionable error. */
  async waitReady(timeoutMs = READY_TIMEOUT_MS): Promise<Client<true>> {
    if (this.failure) throw this.failure;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Still connecting to Discord after ${timeoutMs / 1000}s. Check the network and try again.`,
            ),
          ),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([this.ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async destroy(): Promise<void> {
    await this.client?.destroy();
  }

  private async probeApplication(
    rest: { setToken(t: string): { get(route: `/${string}`): Promise<unknown> } },
    route: `/${string}`,
  ): Promise<APIApplication> {
    try {
      return (await rest.setToken(this.config.token).get(route)) as APIApplication;
    } catch (e) {
      if (isDiscordApiError(e) && e.status === 401) {
        throw new FatalDiscordError(
          'Discord rejected DISCORD_TOKEN (401 Unauthorized). The token is wrong, expired or was ' +
            'reset. Get a new one in the Developer Portal: your app > Bot > Reset Token.',
        );
      }
      throw e;
    }
  }

  private toFatal(e: unknown): Error {
    if (e instanceof FatalDiscordError) return e;
    const err = e instanceof Error ? e : new Error(String(e));
    const code = (err as { code?: unknown }).code;
    if (code === 'TokenInvalid') {
      return new FatalDiscordError(
        'Discord rejected DISCORD_TOKEN. Reset it under Bot > Reset Token.',
      );
    }
    if (code === 'DisallowedIntents') {
      return new FatalDiscordError(
        'Discord refused a privileged intent. Enable it under Bot > Privileged Gateway Intents.',
      );
    }
    return new FatalDiscordError(`Could not connect to Discord: ${err.message}`);
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.rejectReady(err);
  }
}
