import { describe, expect, it } from 'vitest';
import { HTTPError, RateLimitError } from 'discord.js';
import { GuildoraError, describeError } from '../src/mcp/errors.js';
import { apiError } from './helpers.js';

describe('describeError', () => {
  it('passes GuildoraError messages through', () => {
    expect(describeError(new GuildoraError('Do X next.'))).toBe('Do X next.');
  });

  it('maps Missing Permissions and names the permission the tool needs', () => {
    const msg = describeError(apiError(50013, 403, 'Missing Permissions'), {
      permissions: ['Manage Roles'],
    });
    expect(msg).toContain('It needs Manage Roles');
    expect(msg).toContain('highest role');
  });

  it('maps unknown entities to the tool that lists them', () => {
    expect(describeError(apiError(10003, 404, 'Unknown Channel'))).toMatch(/list_channels/);
    expect(describeError(apiError(10011, 404, 'Unknown Role'))).toMatch(/list_roles/);
    expect(describeError(apiError(10008, 404, 'Unknown Message'))).toMatch(/read_messages/);
  });

  it('explains DM failures and bulk-delete age limits', () => {
    expect(describeError(apiError(50007, 403))).toMatch(/DMs/);
    expect(describeError(apiError(50034, 400))).toMatch(/14 days/);
  });

  it('flattens invalid form body errors', () => {
    const msg = describeError(
      apiError(50035, 400, 'Invalid Form Body', {
        name: {
          _errors: [
            { code: 'BASE_TYPE_BAD_LENGTH', message: 'Must be between 1 and 100 in length.' },
          ],
        },
      }),
    );
    expect(msg).toBe(
      'Invalid input rejected by Discord: name: Must be between 1 and 100 in length..',
    );
  });

  it('reports rate limits with a retry time', () => {
    const err = new RateLimitError({
      timeToReset: 12_000,
      limit: 5,
      method: 'post',
      hash: 'h',
      url: 'https://discord.com/api/v10/channels/1/messages',
      route: '/channels/:id/messages',
      majorParameter: '1',
      global: false,
      retryAfter: 12_000,
      sublimitTimeout: 0,
      scope: 'user',
    });
    expect(describeError(err)).toBe(
      'Rate limited by Discord on POST /channels/:id/messages. Try again in about 12s. Avoid repeating this call in a tight loop.',
    );
  });

  it('reports server errors as temporary', () => {
    const err = new HTTPError(503, 'Service Unavailable', 'GET', 'https://discord.com/api/v10/x', {
      body: undefined,
      files: undefined,
    });
    expect(describeError(err)).toMatch(/HTTP 503.*try again/);
  });

  it('never includes stack traces', () => {
    const msg = describeError(new Error('boom'));
    expect(msg).toBe('boom');
    expect(describeError('plain')).toBe('plain');
  });
});
