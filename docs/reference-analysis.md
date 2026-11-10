# Reference analysis: SaseQ/discord-mcp

This document studies [SaseQ/discord-mcp](https://github.com/SaseQ/discord-mcp) (MIT), the
feature reference for Guildora. It records what the project offers, what its users ask for,
and where it falls short. Guildora is a new implementation; no code is copied from it.

- **Snapshot studied:** `main` at commit `e134c03` (2026-10-23).
- **Stack:** Java 17, Spring Boot 4.0.2, Spring AI MCP server `2.0.0-M4` (a milestone build),
  JDA 6.4.1.
- **Size:** about 4,100 lines of Java in 15 `*Service` classes, one per feature area. There is
  no `src/test` directory and no CI beyond a Docker publish workflow.
- **Method:** every `@Tool` method was read in source. Claims below cite the file they come from.
  Issues were read with `gh issue list/view -R SaseQ/discord-mcp`.

## 1. Tool inventory

The code defines **82 tools**. The README lists 81 (`get_attachment` is in the code but not in
the README). All 82 are registered at once through a single `MethodToolCallbackProvider` in
`DiscordMcpConfig.java`. Nothing can be switched off.

Notation: `param?` is optional. `guildId?` is optional only when `DISCORD_GUILD_ID` is set. All
parameters are declared as `String`, including numbers and booleans. "Permission" is the Discord
permission the bot needs (beyond being in the server and seeing the channel).

### Server

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `get_server_info` | `guildId?` | Name, ID, owner, creation date, member count, text/voice/category counts, boost count and tier | none |

### Users and DMs (`UserService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `get_user_id_by_name` | `username`, `guildId?` | Exact username (optionally `name#1234`) to user ID, from the member cache. Lists candidates when there are several | Server Members intent |
| `get_member_by_id` | `userId`, `guildId?` | Username, global name, nickname, effective name, bot flag, join date, roles | none |
| `search_members` | `query`, `count?` (1-100, default 25), `guildId?` | Substring match on ID/username/global name/nickname in the cache, then a REST prefix search | Server Members intent |
| `send_private_message` | `userId`, `message` | Opens a DM and sends text | none (user must allow DMs) |
| `edit_private_message` | `userId`, `messageId`, `newMessage` | Edits a DM the bot sent | none |
| `delete_private_message` | `userId`, `messageId` | Deletes a DM the bot sent | none |
| `read_private_messages` | `userId`, `count?` (1-100), `before?`, `after?`, `around?` | DM history with author IDs, reply markers and attachment metadata | none |

### Messages (`MessageService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `send_message` | `channelId`, `message` | Sends plain text to a text, announcement or thread channel. Returns the jump URL | Send Messages (in Threads) |
| `edit_message` | `channelId`, `messageId`, `newMessage` | Edits a message the bot sent | none |
| `delete_message` | `channelId`, `messageId` | Deletes a message | Manage Messages (for others' messages) |
| `read_messages` | `channelId`, `count?` (1-100, default 100), `before?` / `after?` / `around?` (mutually exclusive) | Message history with IDs, author, timestamp, reply marker, attachments | Read Message History |
| `search_messages` | `channelId`, `searchText`, `maxMessages?` (1-1000, default 500) | Case-insensitive substring scan of recent history, newest first. Reports how many messages it scanned | Read Message History |
| `get_message` | `channelId`, `messageId` | One message, plus the message it replies to | Read Message History |
| `get_message_replies` | `channelId`, `messageId`, `maxMessages?` (1-1000, default 500) | Scans forward from a message and keeps true inline replies | Read Message History |
| `get_attachment` | `channelId`, `messageId`, `attachmentId?` | Attachment metadata (name, size, type, URL, proxy URL). No download. **Not in the README** | Read Message History |
| `add_reaction` | `channelId`, `messageId`, `emoji` | Adds a reaction. Uses `Emoji.fromUnicode`, so only Unicode emoji work | Add Reactions |
| `remove_reaction` | `channelId`, `messageId`, `emoji` | Removes the bot's own reaction (Unicode only) | none |

### Channels and categories (`ChannelService`, `CategoryService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `create_text_channel` | `guildId?`, `name`, `categoryId?`, `topic?`, `nsfw?`, `slowmode?`, `position?` | Creates a text channel | Manage Channels |
| `edit_text_channel` | `guildId?`, `channelId`, `name?`, `topic?`, `nsfw?`, `slowmode?`, `categoryId?` (empty = no category), `position?`, `reason?` | Edits a text or announcement channel (slowmode only for text) | Manage Channels |
| `delete_channel` | `guildId?`, `channelId`, `reason?` | Deletes any guild channel, categories included. **No confirmation** | Manage Channels |
| `find_channel` | `guildId?`, `channelName` | Case-insensitive exact name to type and ID. Lists duplicates | none |
| `list_channels` | `guildId?` | Every channel (type, name, ID). No pagination or filter | none |
| `get_channel_info` | `guildId?`, `channelId` | Type-specific details (topic, NSFW, slowmode, bitrate, user limit, category) | none |
| `move_channel` | `guildId?`, `channelId`, `categoryId?`, `position?`, `reason?` | Moves a channel to a category and/or position | Manage Channels |
| `create_category` | `guildId?`, `name` | Creates a category. **The result does not include the new ID** | Manage Channels |
| `edit_category` | `guildId?`, `categoryId`, `name?`, `position?`, `reason?` | Renames or repositions a category | Manage Channels |
| `delete_category` | `guildId?`, `categoryId` | Deletes a category. Its channels stay, uncategorised. **No confirmation** | Manage Channels |
| `find_category` | `guildId?`, `categoryName` | Name to ID. Errors when several match | none |
| `list_channels_in_category` | `guildId?`, `categoryId` | Channels in a category. Throws an error when the category is empty | none |

### Channel permission overwrites (`ChannelPermissionService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `list_channel_permission_overwrites` | `guildId?`, `channelId` | Role and member overwrites with allow/deny as bitfield and names | none |
| `upsert_role_channel_permissions` | `guildId?`, `channelId`, `roleId`, `allowRaw?`, `denyRaw?`, `allowPermissions?`, `denyPermissions?` (CSV of JDA enum names), `reason?` | Creates or replaces a role overwrite. Rejects overlapping allow/deny | Manage Roles (Manage Permissions) |
| `upsert_member_channel_permissions` | same, with `userId` | Same for a member | Manage Roles (Manage Permissions) |
| `delete_channel_permission_overwrite` | `guildId?`, `channelId`, `targetType` (`role`/`member`), `targetId`, `reason?` | Removes an overwrite. **No confirmation** | Manage Roles (Manage Permissions) |

### Webhooks (`WebhookService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `create_webhook` | `channelId`, `name` | Creates a webhook on a text channel. Returns the **full URL including the secret token**, and no ID | Manage Webhooks |
| `delete_webhook` | `webhookId` | Deletes a webhook. **No confirmation** | Manage Webhooks |
| `list_webhooks` | `channelId` | Lists webhooks with their **full token URLs**. Throws on an empty list; the header says "messages" | Manage Webhooks |
| `send_webhook_message` | `webhookUrl`, `message` | Posts plain text through a webhook URL | none (the URL is the credential) |

### Roles (`RoleService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `list_roles` | `guildId?` | Every role with color, position, hoist, mentionable, raw permission bitfield | none |
| `create_role` | `guildId?`, `name`, `color?` (decimal int), `hoist?`, `mentionable?`, `permissions?` (raw bitfield) | Creates a role | Manage Roles |
| `edit_role` | `guildId?`, `roleId`, `name?`, `color?`, `hoist?`, `mentionable?`, `permissions?` | Edits a role. Refuses `@everyone` | Manage Roles + hierarchy |
| `delete_role` | `guildId?`, `roleId` | Deletes a role. Refuses `@everyone`. **No confirmation** | Manage Roles + hierarchy |
| `assign_role` | `guildId?`, `userId`, `roleId` | Adds a role to a member | Manage Roles + hierarchy |
| `remove_role` | `guildId?`, `userId`, `roleId` | Removes a role from a member | Manage Roles + hierarchy |

### Moderation (`ModerationService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `kick_member` | `guildId?`, `userId`, `reason?` | Kicks a member. **No confirmation** | Kick Members + hierarchy |
| `ban_member` | `guildId?`, `userId`, `deleteMessageSeconds?` (0-604800), `reason?` | Bans by user ID; also works for non-members. **No confirmation** | Ban Members + hierarchy |
| `unban_member` | `guildId?`, `userId`, `reason?` | Lifts a ban | Ban Members |
| `timeout_member` | `guildId?`, `userId`, `durationSeconds` (1-2419200), `reason?` | Times a member out (max 28 days) | Moderate Members + hierarchy |
| `remove_timeout` | `guildId?`, `userId`, `reason?` | Ends a timeout early | Moderate Members |
| `set_nickname` | `guildId?`, `userId`, `nick?` (empty = reset), `reason?` | Sets or resets a nickname | Manage Nicknames + hierarchy |
| `get_bans` | `guildId?`, `limit?` (default 50) | Ban list with reasons. Fetches the **whole** list, then truncates; no cursor | Ban Members |

### Voice and stage (`VoiceChannelService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `create_voice_channel` | `guildId?`, `name`, `categoryId?`, `userLimit?`, `bitrate?` | Creates a voice channel (two REST calls when `userLimit` is set) | Manage Channels |
| `create_stage_channel` | `guildId?`, `name`, `categoryId?`, `bitrate?` | Creates a stage channel | Manage Channels |
| `edit_voice_channel` | `channelId`, `name?`, `bitrate?`, `userLimit?`, `rtcRegion?` | Edits a voice or stage channel | Manage Channels |
| `move_member` | `guildId?`, `userId`, `channelId` | Moves a connected member to another voice channel | Move Members |
| `disconnect_member` | `guildId?`, `userId` | Disconnects a member from voice | Move Members |
| `modify_voice_state` | `guildId?`, `userId`, `mute?`, `deafen?` | Server mute/deafen (member must be connected) | Mute Members / Deafen Members |

### Scheduled events (`ScheduledEventService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `create_guild_scheduled_event` | `guildId?`, `name`, `description?`, `scheduledStartTime` (ISO 8601), `scheduledEndTime?` (required for external), `entityType` (`1` stage, `2` voice, `3` external), `channelId?`, `location?` | Creates an event | Manage Events |
| `edit_guild_scheduled_event` | `guildId?`, `eventId`, `status?` (`1`-`4`), `name?`, `description?`, `scheduledStartTime?`, `location?` | Edits an event or changes its status | Manage Events |
| `delete_guild_scheduled_event` | `guildId?`, `eventId` | Deletes an event. **No confirmation** | Manage Events |
| `list_guild_scheduled_events` | `guildId?`, `withUserCount?` | Events from the cache | none |
| `get_guild_scheduled_event_users` | `guildId?`, `eventId`, `limit?` (default 100), `withMember?` | Interested members, optionally with roles | none |

### Invites (`InviteService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `create_invite` | `guildId?`, `channelId`, `maxAge?`, `maxUses?`, `temporary?`, `unique?` | Creates an invite | Create Invite |
| `list_invites` | `guildId?` | Every invite with uses, limits and inviter | Manage Server |
| `delete_invite` | `inviteCode` (code or URL) | Revokes an invite. **No confirmation** | Manage Channels or Manage Server |
| `get_invite_details` | `inviteCode`, `withCounts?` | Resolves any public invite | none |

### Threads (`ThreadService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `list_active_threads` | `guildId?` | Active threads across the server | none |
| `list_threads` | `channelId` | Active threads in one channel, plus up to 100 archived **public** threads. As a side effect, the archived ones enter the JDA cache | Read Message History (archived) |
| `get_thread_info` | `threadId` | Parent, owner, archived/locked state, message and member counts. Cache-only | none |

### Forums (`ForumService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `create_forum_channel` | `guildId?`, `name`, `categoryId?`, `topic?`, `nsfw?`, `slowmode?`, `position?` | Creates a forum | Manage Channels |
| `edit_forum_channel` | `guildId?`, `channelId`, `name?`, `topic?`, `nsfw?`, `slowmode?`, `categoryId?`, `position?`, `defaultSort?`, `defaultLayout?`, `reason?` | Edits a forum | Manage Channels |
| `list_forum_channels` | `guildId?` | All forums | none |
| `get_forum_channel_info` | `guildId?`, `channelId` | Forum settings and tags | none |
| `list_forum_tags` | `guildId?`, `channelId` | Tags with IDs, moderated flag, emoji | none |
| `create_forum_post` | `guildId?`, `channelId`, `title`, `message`, `tagIds?` (CSV of IDs) | Creates a post with a first message | Send Messages (Create Posts) |
| `list_forum_posts` | `guildId?`, `channelId` | **Active posts only** | none |
| `modify_forum_post` | `guildId?`, `postId`, `locked?`, `archived?`, `pinned?`, `tagIds?`, `reason?` | Lock, archive, pin, or set tags. Cache-only lookup | Manage Threads |

### Emoji (`EmojiService`)

| Tool | Parameters | What it does | Permission |
|---|---|---|---|
| `list_emojis` | `guildId?` | Custom emoji with animated flag and role restrictions | none |
| `get_emoji_details` | `guildId?`, `emojiId` | Details and image URL | none |
| `create_emoji` | `guildId?`, `name`, `image?` (base64 or data URI) **or** `imageUrl?` (https), `roles?` (CSV of IDs) | Uploads an emoji (256 KB limit) | Create/Manage Expressions |
| `edit_emoji` | `guildId?`, `emojiId`, `name?`, `roles?` | Renames or changes role restrictions | Manage Expressions |
| `delete_emoji` | `guildId?`, `emojiId` | Deletes an emoji. **No confirmation** | Manage Expressions |

## 2. Edge cases it handles well

These are worth keeping in Guildora.

- **DMs.** Full send, edit, delete and read support through `openPrivateChannel()`.
- **History pagination.** `before`, `after` and `around` cursors, mutually exclusive and
  validated, with a 1-100 count.
- **Honest scan reporting.** `search_messages` and `get_message_replies` state how many messages
  they scanned and whether they reached the start (or end) of history. They probe one extra
  message to tell "limit hit" apart from "history exhausted".
- **True replies only.** Reply detection checks `MessageType.INLINE_REPLY`, so forwards, thread
  starters and crossposts are not counted as replies.
- **Replied-to context.** `get_message` includes the referenced message, or says it was deleted.
- **Emoji upload safety.** 256 KB cap (checked before and during download), base64, data URI or
  https URL. An SSRF guard rejects loopback, link-local, site-local, multicast and IPv6 ULA
  addresses, and it does not follow redirects (`EmojiService.java`). Names are normalised and
  validated (2-32 characters, `[A-Za-z0-9_]`).
- **Permission overwrites.** Accepts a raw bitfield or permission names, rejects using both for
  one field, rejects overlapping allow/deny bits, and refuses threads (which have no overwrites).
- **`@everyone` protection.** Role edit, delete, assign and remove refuse the public role.
- **Ban by ID.** `ban_member` uses `UserSnowflake`, so users who already left can be banned.
  `deleteMessageSeconds` is range-checked (0-7 days). Timeouts are capped at 28 days.
- **Hierarchy and permission errors.** Moderation and role tools catch `HierarchyException` and
  `InsufficientPermissionException` and return readable messages.
- **Invite input.** Accepts a bare code or a `discord.gg` / `discord.com/invite` URL.
- **Archived-thread permission.** `list_threads` catches a missing permission and adds a note
  instead of failing.
- **Startup diagnostics.** A rejected token or a missing privileged intent (close code 4014) is
  reported on stderr with a fix hint, because stdout belongs to MCP (`DiscordMcpConfig.java`).
- **Voice checks.** `move_member`, `disconnect_member` and `modify_voice_state` check that the
  member is connected first.
- **Member search.** Combines the local cache with a REST prefix search, so it finds members the
  cache missed.
- **Default server.** `DISCORD_GUILD_ID` makes `guildId` optional everywhere.

## 3. Weaknesses (verified in code)

### Required checks

1. **All tools are exposed at once.** `DiscordMcpConfig.discordTools()` passes all 15 services to
   one `MethodToolCallbackProvider`. All 82 tools (81 documented) are always registered. There is
   no allow-list, pack system or read-only switch. The full set of names, descriptions and
   schemas goes into the model's context on every session.
2. **Archived threads need `list_threads` first.** `get_thread_info` reads
   `jda.getThreadChannelById()`, which is cache-only, and its error says *"If it is archived, call
   list_threads on its parent channel first"* (`ThreadService.java`). The message tools resolve
   channels the same way (`MessageService.getMessageChannelById`), and so does
   `modify_forum_post` (`ForumService.retrieveThreadChannelById`). `list_threads` loads archived
   **public** threads into the cache as a side effect. Archived **private** threads cannot be
   reached at all. `list_forum_posts` shows active posts only.
3. **Message scans stop at 1,000.** `parseScanLimit` in `MessageService.java` rejects values
   above 1000 (default 500) for both `search_messages` and `get_message_replies`. There is no
   server-side search (open issue #30 asks for it). Each scan of 1,000 messages costs 10 REST
   calls.
4. **stdio means one heavy JVM per session.** `McpTransportStartupLogger` warns: *"stdio (legacy
   mode). Each client session starts a separate server process."* Every Claude Code window
   launches a new `docker run` with a Spring Boot JVM. Startup also blocks on `awaitReady()` with
   `ChunkingFilter.ALL` and `MemberCachePolicy.ALL`, which downloads every member of every
   server before the first tool can run. A user's log in issue #32 shows *"Started
   DiscordMcpApplication in 4.744 seconds"*. Closed issue #22 reports 20 containers piling up and
   filling RAM. The maintainer's fix was to recommend HTTP mode instead.
5. **Raw IDs almost everywhere.** Only `find_channel`, `find_category`, `get_user_id_by_name` and
   `search_members` accept names. Every other tool needs snowflake IDs, so the model has to call
   a lookup tool first. Tag and role lists are CSVs of IDs. Colours are decimal integers and
   permissions are raw bitfields (`RoleService.java`).

### Further findings

6. **No safety layer.** Destructive tools (`delete_channel`, `delete_category`, `delete_role`,
   `kick_member`, `ban_member`, `delete_webhook`, `delete_invite`, `delete_emoji`,
   `delete_guild_scheduled_event`, `delete_message`) run immediately. There is no confirmation,
   dry run or read-only mode, and no MCP tool annotations (`readOnlyHint`, `destructiveHint`).
7. **Unauthenticated HTTP on all interfaces.** `application-http.properties` sets `server.port`
   but no `server.address`, so `/mcp` listens on `0.0.0.0` with no auth. Anyone who can reach
   port 8085 can use the bot. This is open issue #40 (rated high).
8. **Webhook secrets go into the model's context.** `create_webhook` and `list_webhooks` return
   full webhook URLs, token included, and `send_webhook_message` takes that URL as input. Those
   secrets end up in chat transcripts and logs.
9. **Stringly typed inputs.** Every parameter is a `String`. Many handlers call
   `Integer.parseInt` without a guard, so a bad value surfaces as a raw `NumberFormatException`.
   `Boolean.parseBoolean("yes")` silently becomes `false`. Enumerations are magic numbers (event
   type `1`/`2`/`3`, status `1`-`4`).
10. **Unicode-only reactions.** `add_reaction` and `remove_reaction` use `Emoji.fromUnicode()`,
    so server custom emoji (`<:name:id>`) cannot be used. `remove_reaction` only removes the
    bot's own reaction.
11. **Text-only messages.** `send_message` sends plain text. There are no replies, embeds,
    attachments (open issue #11), mention controls or handling of the 2,000-character limit.
    Voice-channel text chat cannot be read or written, because only text, announcement and
    thread channels are resolved.
12. **Unpaginated lists.** `list_channels`, `list_roles`, `list_invites`, `list_emojis`,
    `list_active_threads` and `list_guild_scheduled_events` return everything. `get_bans`
    downloads the whole ban list before truncating it. There are no cursors.
13. **Inconsistent results.** `create_category` returns no ID and `create_webhook` returns no
    webhook ID, so the model has to look them up again. `list_webhooks` and
    `list_channels_in_category` throw errors on empty results instead of returning an empty list.
    Output formats differ between services (Markdown bullets, code fences, plain lines).
14. **Silent Message Content gaps.** The bot never checks whether the Message Content intent is
    enabled. Without it, Discord returns empty `content`, and `read_messages` and
    `search_messages` return blank messages or no matches with no explanation.
15. **Server Members intent is mandatory.** `GUILD_MEMBERS` is always requested and all members
    are chunked at startup. A bot without that privileged intent cannot start at all (close
    code 4014), even if the user only wants to send messages.
16. **Missing capabilities.** There is no tool to list members (only search), bulk delete,
    read the audit log, pin or unpin, create a thread in a text channel or from a message,
    archive or lock non-forum threads, list private archived threads, manage forum tags, or
    manage stickers. There is also no guild-wide message search.
17. **No tests and a milestone dependency.** There are no unit tests. CI only publishes Docker
    images. Spring AI is pinned to `2.0.0-M4` (issue #40). Issue #32's log shows the published
    image registering 75 tools while the code has 82, so image and source drift apart.

## 4. Open GitHub issues (2026-11-10)

| # | Title | User complaint / need | Guildora answer |
|---|---|---|---|
| [#40](https://github.com/SaseQ/discord-mcp/issues/40) | Security follow-ups: HTTP auth, actuator docs, supply chain | Unauthenticated `/mcp`; actuator could leak the token; milestone Spring AI | Bind `127.0.0.1` by default, optional bearer token for HTTP, no admin endpoints, stable pinned dependencies |
| [#32](https://github.com/SaseQ/discord-mcp/issues/32) | Failed to connect to MCP | Docker Compose on ARM needed `platform: linux/amd64`; their client (`mcp-ktor`) could not use the streamable HTTP endpoint | Plain Node package, no image architecture issues; stdio works everywhere, HTTP uses the official SDK transport |
| [#31](https://github.com/SaseQ/discord-mcp/issues/31) | Unable to set up, please add YouTube walkthrough | Confusing setup; unclear whether `YOUR_DISCORD_BOT_TOKEN` means client ID, client secret or token; wants Discord's own labels | README walks through the Developer Portal step by step using Discord's exact UI labels ("Bot" > "Reset Token") |
| [#30](https://github.com/SaseQ/discord-mcp/issues/30) | Feature request: `search_guild_messages` | Needs server-wide search by author, content, mentions, `has:` and date | Use the guild search endpoint when the bot can; fall back to a bounded scan that reports coverage |
| [#29](https://github.com/SaseQ/discord-mcp/issues/29) | Feature request: `get_message` | Fetch a message by ID (now implemented in code) | `get_message` in `core`; also accepts a message link |
| [#11](https://github.com/SaseQ/discord-mcp/issues/11) | Feature request: `send_file` | Send attachments (reports, images) to channels and DMs | `send_message` accepts attachments (local path, https URL or base64) with size checks |

Relevant closed issues: #22 (one container per Claude Code terminal filled RAM), #27 (HTTP mode
failed on an empty logging pattern), #23 (no multi-arch images), #28 (read pagination, since
added).

## 5. What Guildora will do differently

| Area | SaseQ/discord-mcp | Guildora |
|---|---|---|
| Install | Docker image or Maven build, JVM | `npx guildora-mcp`; Node ≥ 20 only |
| Startup | Spring Boot + full member chunking (~5 s) | The MCP handshake is answered right away. Discord connects in parallel and tools wait for it only when they need it. No member chunking at startup |
| stdio cost | One JVM/container per session | One small Node process per session (tens of MB, sub-second start); HTTP mode for a shared instance |
| Context | 82 tools always loaded | **Packs**; the default `core` pack has about 15 tools. `GUILDORA_PACKS=all` opts in to everything |
| Tool count | One tool per entity type (`create_text_channel`, `create_voice_channel`, ...) | Merged where the shape is the same: `create_channel` with a `type`, `send_message` to a channel **or** a user, `timeout_member` with duration `0` to lift. Total is about 60 tools covering a superset of SaseQ's features |
| Inputs | Raw IDs, CSV strings, ints as strings | ID, mention or name for channels, roles, members, categories and emoji. Typed zod schemas (numbers, booleans, enums), arrays instead of CSV, hex colours, permission **names**, durations such as `10m`. Ambiguous names return the candidates |
| Archived threads | Need `list_threads` first; private ones unreachable | Fetched directly by ID via REST; list includes active, archived public and archived private threads with cursors |
| Search | Scan of at most 1,000 messages in one channel | Guild search endpoint when available (filters for author, channel, `has`, dates); otherwise a paginated scan with a configurable limit that reports exactly what it scanned |
| Safety | None | `GUILDORA_READ_ONLY=true` hides every mutating tool. Destructive tools need `confirm: true`; without it they return a dry run of what would happen. MCP `readOnlyHint` / `destructiveHint` / `idempotentHint` set on every tool |
| HTTP | `0.0.0.0`, no auth | `127.0.0.1` by default; optional bearer token |
| Secrets | Webhook tokens returned to the model | Webhook tokens never leave the server: send via webhook by ID or name. The bot token is never logged |
| Errors | Mixed; some raw exceptions | Discord error codes mapped to next-step guidance ("Missing Permissions: the bot needs **Manage Roles** in #general", hierarchy, unknown entity, rate limit with retry time) |
| Rate limits | Blocking `complete()` | discord.js REST queue; long waits are reported in the result |
| Intents | Members intent mandatory; Message Content never checked | Only what is needed. At startup, missing **Message Content** / **Server Members** intents are reported as warnings, and affected tools say why content is empty |
| Outputs | Mixed Markdown | Compact, consistent text with IDs **and** names; every list has `limit` and a cursor |
| Messages | Text only, Unicode reactions | Replies, embeds, attachments, `allowed_mentions` control, 2,000-character check; custom-emoji reactions; pins |
| Missing features | — | Adds `list_members`, bulk delete, audit log, pins, thread creation/archive/lock, forum tag management, stickers |
| Quality | No tests, no lint CI | Vitest unit tests with mocked discord.js, optional live smoke test, lint + typecheck + test + build CI on Ubuntu and Windows |

### Proposed packs (to finalise in Phase 2)

| Pack | Tools (draft) | SaseQ tools covered |
|---|---|---|
| `core` (~15) | `get_server_info`, `list_channels`, `get_channel`, `list_members`, `get_member`, `read_messages`, `get_message`, `search_messages`, `send_message`, `edit_message`, `delete_message`, `add_reaction`, `remove_reaction`, `pin_message`, `list_roles` | server info, find/list channels and categories, channel info, member lookup/search, user ID by name, all message and DM tools, attachments, replies (`get_message` with `include_replies`) |
| `channels` | `create_channel`, `edit_channel`, `delete_channel`, `list_permission_overwrites`, `set_permission_overwrite`, `delete_permission_overwrite` | text/voice/stage/forum/category create, edit, move and delete; all overwrite tools |
| `roles` | `create_role`, `edit_role`, `delete_role`, `add_member_role`, `remove_member_role` | all role tools |
| `moderation` | `kick_member`, `ban_member`, `unban_member`, `list_bans`, `timeout_member`, `set_nickname`, `bulk_delete_messages`, `get_audit_log` | all moderation tools, plus bulk delete and audit log |
| `threads` | `list_threads`, `get_thread`, `create_thread`, `edit_thread`, `manage_forum_tags` | all thread and forum-post tools |
| `voice` | `move_member`, `disconnect_member`, `set_voice_state`, `list_events`, `create_event`, `edit_event`, `delete_event`, `list_event_users` | voice member tools, all scheduled-event tools |
| `webhooks` | `list_webhooks`, `create_webhook`, `delete_webhook`, `send_webhook_message` | all webhook tools |
| `invites` | `list_invites`, `create_invite`, `delete_invite`, `get_invite` | all invite tools |
| `emoji` | `list_emoji`, `create_emoji`, `edit_emoji`, `delete_emoji`, `list_stickers`, `create_sticker`, `delete_sticker` | all emoji tools, plus stickers |

Intentionally merged or dropped:

- `get_user_id_by_name`, `find_channel`, `find_category`: replaced by name resolution on every
  tool, plus filters on `list_channels` and `list_members`.
- `send/edit/delete/read_private_message(s)`: merged into the message tools through a `user`
  target.
- `get_attachment`: attachment metadata is part of `get_message` and `read_messages`.
- `remove_timeout`: `timeout_member` with `duration: 0`.
- `list_channels_in_category`, `list_forum_channels`, `list_active_threads`, `list_forum_posts`:
  filters on `list_channels` and `list_threads`.
- `get_channel_info`, `get_forum_channel_info`, `list_forum_tags`, `get_thread_info`: one
  `get_channel` / `get_thread` that returns type-specific details, tags included.
