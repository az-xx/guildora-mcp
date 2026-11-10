# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - unreleased

First version.

### Added

- MCP server for Discord over stdio and Streamable HTTP (stateless, loopback by default,
  optional bearer token, DNS-rebinding checks, `/health`).
- 61 tools in 9 packs: `core` (default), `channels`, `roles`, `moderation`, `threads`, `voice`,
  `webhooks`, `invites`, `emoji`. Enable more with `GUILDORA_PACKS`.
- Name resolution for channels, categories, threads, roles, members, users, emoji, stickers,
  events, webhooks and servers: IDs, mentions, links or names, with candidate lists for ambiguous
  names.
- Dry runs for destructive tools unless `confirm: true`; read-only mode; MCP tool annotations.
- Server-wide message search with a bounded, reported channel-scan fallback.
- Archived (public and private) threads without prerequisite calls.
- Fast startup: the MCP handshake is served before discord.js loads.
- Startup checks for the token and privileged intents, with fix instructions.
- Actionable error messages for Discord API errors, hierarchy problems and rate limits.
