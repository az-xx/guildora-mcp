# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `list_inactive_channels` (channels): channels idle for a period, longest first, with how many of
  Discord's 500 channels are used; `people_only` ignores bot activity.
- `archive_channel` (channels): moves up to 50 channels into a private "Archive" category (created
  as needed, "Archive 2" when full) and syncs permissions; lists old overwrites for restoring.
  Destructive: dry run unless confirmed.
- New `insights` pack:
  - `export_messages`: saves a channel, thread, ticket or DM as a Markdown transcript or JSON.
  - `server_snapshot`: saves the server structure (roles, channels, permission overwrites) as JSON
    and lists what changed since an earlier snapshot.
  - `message_stats`: message counts by channel, person, day and hour over a period.
- `GUILDORA_EXPORT_DIR` (default `~/guildora-exports`). Files are only written in stdio mode and
  never overwritten.

## [0.3.0] - 2026-11-10

### Added

- `get_new_messages` (core): messages received live during the session across the server or a
  channel, category or forum, with a cursor to fetch only newer ones and an `only_mentions`
  filter. Kept in a bounded in-memory buffer (5,000 messages).
- MCP prompts: `server_digest`, `triage_forum`, `reply_queue` and `catch_up`. Their steps
  adapt to the enabled tools, and in read-only mode they only draft.

### Changed

- The Message Content intent is now also requested on the gateway when it is enabled in the
  Developer Portal, so live messages include their text.
- `core` now has 20 tools (67 in total).

## [0.2.2] - 2026-11-10

### Fixed

- `list_unanswered` shows wait times compactly ("28d22h") instead of down to the second.

## [0.2.1] - 2026-11-10

No code changes; this release validates the new publishing setup.

### Added

- Release workflow: pushing a `v*` tag publishes to npm with Trusted Publishing (no token, no 2FA
  prompt, with provenance) and creates the GitHub release from this changelog.

## [0.2.0] - 2026-11-10

### Added

- `get_attachment` (core): opens a message's attachments. Images come back as images the model can
  see, scaled to about 1568 px / 1.15 MP through Discord's media proxy (no native image library);
  text files (logs, code, JSON, CSV) come back as text.
- `list_unanswered` (core): tickets, channels, threads and forum posts where someone is waiting
  for a staff reply, sorted by wait time. Staff by role or by moderator permissions.
- `recent_activity` (core): which channels and threads had messages from people since a time,
  with counts and the latest message, without opening each channel.
- `read_forum` (threads): a forum's posts with tags, author, counts, opening message and
  optionally the latest replies, active and archived, filterable by tag.
- `check_access` (core): what a member or role can do in a channel and which overwrites cause
  it, or who can see the channel at all.
- Tools can now return images as MCP image content.

### Changed

- Requests the non-privileged Guild Messages intent so channel activity stays current.
- `core` now has 19 tools (66 in total).

## [0.1.0] - 2026-11-10

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
- Tested live against a real server over stdio and HTTP (read-only).

[Unreleased]: https://github.com/az-xx/guildora-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/az-xx/guildora-mcp/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/az-xx/guildora-mcp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/az-xx/guildora-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/az-xx/guildora-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/az-xx/guildora-mcp/releases/tag/v0.1.0
