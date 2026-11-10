# Guildora

**A lightweight, pack-based MCP server for Discord.** Let Claude (or any MCP client) read and manage
your Discord server through a bot, with one `npx` command, a small context footprint, and safety
rails for destructive actions.

[![CI](https://github.com/az-xx/guildora-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/az-xx/guildora-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Guildora is an independent open-source project. It is **not** affiliated with, endorsed by, or an
> official product of Discord Inc. "Discord" is a trademark of Discord Inc.

## Features

- **One command, no Java or Docker:** `npx -y guildora-mcp`. The MCP handshake is answered in about
  half a second; Discord connects in the background.
- **Small context footprint:** tools come in **packs**. Only `core` (20 tools) is on by default;
  turn on more with `GUILDORA_PACKS`.
- **Friendly inputs:** every channel, role, member, category and emoji argument accepts an **ID, a
  mention (`<#123>`, `<@&123>`, `<@123>`), a link, or a name** (`general`, `#general`,
  `Moderators`). Ambiguous names return the candidates instead of guessing.
- **Safe by default:** destructive tools (delete, kick, ban, bulk delete…) return a **dry run**
  unless called with `confirm: true`. `GUILDORA_READ_ONLY=true` hides every tool that changes
  anything. MCP `readOnlyHint` / `destructiveHint` annotations are set on every tool.
- **Reliable:** archived threads work by ID without any "call X first" step; server-wide message
  search with an honest, bounded fallback; rate limits are queued and long waits are reported;
  Discord errors become messages that say what to do next.
- **Made for running a community:** Claude can *see* screenshots and read log files attached to
  messages (`get_attachment`), find tickets and posts still waiting for a staff reply
  (`list_unanswered`), see what happened across hundreds of channels at once (`recent_activity`),
  review a whole forum in one call (`read_forum`), and explain who can access a channel and why
  (`check_access`), and catch up on messages that arrived while you were away (`get_new_messages`).
- **Housekeeping and records:** find channels idle for weeks and archive them in bulk
  (`list_inactive_channels`, `archive_channel`), save tickets or threads as Markdown/JSON
  transcripts (`export_messages`), snapshot the server structure and see what changed since
  (`server_snapshot`), and get message statistics (`message_stats`).
- **Ready-made workflows:** MCP prompts for a server digest, forum triage, a reply queue and
  catching up, which appear as prompts or slash commands in your MCP client.
- **No secrets in the chat:** webhook URLs/tokens never reach the model, and the bot token is
  never logged.
- **stdio and Streamable HTTP** transports. HTTP binds to `127.0.0.1` by default and supports a
  bearer token.

## Compared with SaseQ/discord-mcp

[SaseQ/discord-mcp](https://github.com/SaseQ/discord-mcp) is the established Java server that
inspired Guildora's feature set. Both are MIT-licensed. Differences as of November 2026:

| | SaseQ/discord-mcp | Guildora |
|---|---|---|
| Runtime | Java 17 + Spring Boot (Docker image or Maven build) | Node.js ≥ 22, `npx guildora-mcp` |
| Startup (stdio) | Spring Boot plus full member download, several seconds per client session | MCP handshake in ~0.5 s; Discord connects in the background |
| Tools loaded | All 82 at once | 20 by default (`core`); 72 in total across 10 packs |
| Inputs | Mostly raw IDs | IDs, mentions, links or names; ambiguous names list candidates |
| Destructive actions | Run immediately | Dry run unless `confirm: true`; read-only mode |
| Archived threads | Usable only after `list_threads` on the parent | Fetched directly; private archived threads listed too |
| Message search | Scans up to 1,000 messages in one channel | Discord server search when available; otherwise a configurable, reported scan |
| HTTP mode | Listens on all interfaces, no auth | Loopback by default, optional bearer token, DNS-rebinding checks |
| Webhooks | Returns webhook URLs (with tokens) to the model | Sends by webhook ID or name; tokens stay server-side |
| Extras | — | Sees image attachments and reads text files, finds unanswered tickets, cross-channel activity, forum digests, access explanations, attachments and embeds in messages, custom-emoji reactions, pins, bulk delete, audit log, member list, thread creation, forum tags, stickers |
| Tests / CI | No unit tests | Vitest suite (no token needed), CI on Ubuntu and Windows |

SaseQ also ships a Docker image and has a longer track record. If you already run it as a shared
HTTP service, it works well for that. See [docs/reference-analysis.md](docs/reference-analysis.md)
for the detailed study, and the [tool mapping](#coming-from-saseqdiscord-mcp) below.

## Setup (about 5 minutes)

### 1. Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click
   **New Application**. Give it a name and create it.
2. On **General Information**, copy the **Application ID** (you need it for the invite link).
3. Open the **Bot** page and click **Reset Token**, then **Copy**. This is your `DISCORD_TOKEN`.
   It is shown only once. Do not confuse it with the *Client Secret* (OAuth2 page) or the *Public
   Key*; those will not work.
4. Still on the **Bot** page, under **Privileged Gateway Intents**, turn on:
   - **Message Content Intent**: needed to read message text, embeds and attachments.
   - **Server Members Intent**: needed for `list_members` without a search query.

   Guildora works without them, but tells you what is limited (`get_server_info` shows their state).

### 2. Invite the bot to your server

Replace `YOUR_APPLICATION_ID` and open the link while signed in to Discord:

- **Core pack** (read and send messages, reactions, pins, delete messages):
  `https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=2252074691718208`
- **All packs** (also channels, roles, moderation, threads, voice, events, webhooks, invites,
  emoji; still no Administrator):
  `https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot&permissions=2279693375106295`

<details>
<summary>Exactly which permissions those links grant</summary>

- Core: View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read
  Message History, Add Reactions, Pin Messages, Manage Messages.
- All packs adds: Manage Channels, Manage Roles, Kick Members, Ban Members, Timeout Members, Manage
  Nicknames, View Audit Log, Manage Threads, Create Public/Private Threads, Connect, Move Members,
  Mute Members, Deafen Members, Create/Manage Events, Manage Webhooks, Create Invite, Manage Server
  (to list invites), Create/Manage Expressions.

Grant only what you need. For role and member actions, the bot's role must also be **above** the
roles it manages (Server Settings > Roles, drag it up).
</details>

Optionally copy your server ID (enable **Developer Mode** in Discord's Advanced settings, then
right-click the server > **Copy Server ID**) and use it as `DISCORD_GUILD_ID`. If the bot is in
only one server, you can skip this.

### 3. Connect your MCP client

#### Claude Code

```bash
claude mcp add guildora -e DISCORD_TOKEN=your-bot-token -- npx -y guildora-mcp
```

On native Windows (not WSL), wrap `npx` with `cmd /c`:

```bash
claude mcp add guildora -e DISCORD_TOKEN=your-bot-token -- cmd /c npx -y guildora-mcp
```

Add more settings with extra `-e` flags, for example
`-e DISCORD_GUILD_ID=123456789012345678 -e GUILDORA_PACKS=core,moderation,roles`.
Note that the token ends up in your shell history and in Claude Code's config; see
[Security](SECURITY.md) for safer options.

#### Claude Desktop

Edit `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "guildora": {
      "command": "npx",
      "args": ["-y", "guildora-mcp"],
      "env": {
        "DISCORD_TOKEN": "your-bot-token",
        "DISCORD_GUILD_ID": "123456789012345678",
        "GUILDORA_PACKS": "core,moderation"
      }
    }
  }
}
```

Restart Claude Desktop afterwards.

#### Other MCP clients (stdio)

Any client that can launch a command: command `npx`, arguments `-y guildora-mcp`, and the
environment variables below.

#### Streamable HTTP (one shared instance)

```bash
DISCORD_TOKEN=your-bot-token GUILDORA_TRANSPORT=http npx -y guildora-mcp
```

The endpoint is `http://127.0.0.1:8085/mcp` (stateless; `GET /health` reports status). Connect
Claude Code with:

```bash
claude mcp add --transport http guildora http://127.0.0.1:8085/mcp
```

To expose it beyond your machine, set `GUILDORA_HOST=0.0.0.0` **and** `GUILDORA_HTTP_TOKEN`
(clients then send `Authorization: Bearer <token>`), and put it behind HTTPS.

### 4. Try it

Ask Claude: *"Show me the server info"*, *"Summarise the last 50 messages in #general"*, or
*"Find messages from alice mentioning the release"*.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | — | Bot token (Bot > Reset Token) |
| `DISCORD_GUILD_ID` | no | — | Default server, so tools may omit `guild`. Not needed if the bot is in one server |
| `GUILDORA_PACKS` | no | `core` | Comma list of packs to enable; `all` enables everything |
| `GUILDORA_READ_ONLY` | no | `false` | `true` exposes only non-mutating tools |
| `GUILDORA_TRANSPORT` | no | `stdio` | `stdio` or `http` |
| `GUILDORA_HOST` | no | `127.0.0.1` | HTTP bind address |
| `GUILDORA_PORT` | no | `8085` | HTTP port |
| `GUILDORA_HTTP_TOKEN` | no | — | Require `Authorization: Bearer <token>` over HTTP (16+ characters) |
| `GUILDORA_EXPORT_DIR` | no | `~/guildora-exports` | Folder where `export_messages` and `server_snapshot` save files (stdio only; files are never overwritten) |
| `GUILDORA_SCAN_LIMIT` | no | `1000` | Max messages scanned when Discord's server search is unavailable (100-10000) |
| `GUILDORA_LOG_LEVEL` | no | `info` | `error`, `warn`, `info` or `debug`. Logs go to **stderr only** |

Startup fails fast with a clear message if the token is missing, malformed or rejected, and warns
about missing privileged intents. `npx guildora-mcp --help` prints this list.

## Packs and tools

Each tool belongs to exactly one pack. `core` is always on. Read-only tools are marked; write tools
change something; destructive tools need `confirm: true` (otherwise they return a dry run).

<!-- tools:start -->
<!-- Generated by scripts/tool-docs.js. Do not edit by hand. -->

72 tools in 10 packs.

#### `core` (20 tools) · enabled by default

Server info, channels, members, roles (read), messages, DMs, reactions, pins, search.

| Tool | Kind | What it does |
|---|---|---|
| `get_server_info` | read-only | Overview of a Discord server: owner, member count, boost tier, channel/role/emoji counts, the bot's permissions and which privileged intents are on. |
| `list_channels` | read-only | Lists server channels in sidebar order (categories with their channels), with IDs and types. |
| `get_channel` | read-only | Details of one channel, category, thread or forum post: topic, category, slowmode, voice settings and who is connected, forum tags, thread state, and which key permissions the bot lacks there. |
| `list_roles` | read-only | Lists server roles from highest to lowest with ID, position, color, flags and notable permissions. |
| `list_members` | read-only | Lists server members with IDs, roles and join date. |
| `get_member` | read-only | Full details of one server member: names, account and join dates, all roles, timeout, voice channel, boosting, key permissions, and whether the bot can kick/ban/timeout them (role hierarchy). |
| `read_messages` | read-only | Reads recent messages from a channel, thread, forum post or DM, shown oldest first with IDs, authors, replies, attachments (names and IDs; get_message gives URLs), embeds and reactions. |
| `get_message` | read-only | Fetches one message by ID or link, with attachments (IDs, sizes, URLs), embeds, reactions and the message it replies to. |
| `get_attachment` | read-only | Opens a message's attachments so you can see them: images (screenshots, photos) come back as images, scaled down to a readable size; text files (logs, code, JSON, CSV) come back as text. |
| `search_messages` | read-only | Finds messages by text, author, mentions, attachments/links (has), pinned state and date range. |
| `recent_activity` | read-only | Shows which channels and threads had messages from people since a time ("24h" by default, or "7d", an ISO date), newest first, with how many messages and people and the latest message (include_bots adds bot activity). |
| `get_new_messages` | read-only | Returns messages that arrived across the server (or a channel, category or forum) since your last call, oldest first, from what Guildora received live during this session. |
| `list_unanswered` | read-only | Finds channels, tickets, threads and forum posts where the latest message from a person is not from staff, i.e. |
| `send_message` | write | Sends a message to a channel, thread, forum post or a user's DMs (pass "user"). |
| `edit_message` | write | Edits a message the bot sent (content and/or embeds). |
| `delete_message` | destructive | Deletes one message (the bot's own, or anyone's with Manage Messages). |
| `add_reaction` | write | Reacts to a message with a Unicode or custom server emoji. |
| `remove_reaction` | write | Removes a reaction from a message: the bot's own by default, or another member's (needs Manage Messages). |
| `pin_message` | write | Pins a message (pinned: true, default) or unpins it (pinned: false). |
| `check_access` | read-only | Explains channel access after roles and overwrites are combined. |

#### `channels` (8 tools)

Create, edit, move and delete channels and categories; permission overwrites.

| Tool | Kind | What it does |
|---|---|---|
| `create_channel` | write | Creates a text, voice, announcement, stage, forum or media channel, or a category. |
| `edit_channel` | write | Renames, moves (category, position) or changes settings of any channel or category: topic, NSFW, slowmode, voice bitrate/user limit/region, forum default sort and layout. |
| `delete_channel` | destructive | Permanently deletes a channel, category, thread or forum post with all its messages. |
| `list_inactive_channels` | read-only | Lists channels with no messages for a while ("30d" by default), longest idle first, and how many of Discord's 500 channels the server uses. |
| `archive_channel` | destructive | Moves up to 50 channels into a private "Archive" category (created if missing; "Archive 2" etc. |
| `list_permission_overwrites` | read-only | Lists a channel's or category's permission overwrites: for each role or member, which permissions are explicitly allowed and denied (everything else is inherited from roles). |
| `set_permissions` | write | Allows, denies or resets (back to inherited) permissions for a role or member on one channel or category. |
| `delete_permission_overwrite` | destructive | Removes a role's or member's whole permission overwrite from a channel, so they fall back to their role permissions. |

#### `roles` (5 tools)

Create, edit and delete roles; give and take roles from members.

| Tool | Kind | What it does |
|---|---|---|
| `create_role` | write | Creates a role with a name, color ("#5865F2" or a name like "Blurple"), permission names, and display options. |
| `edit_role` | write | Changes a role's name, color, hoist, mentionable flag, position or permissions. |
| `delete_role` | destructive | Permanently deletes a role; members lose it. |
| `add_member_role` | write | Gives one or more roles to a member. |
| `remove_member_role` | write | Removes one or more roles from a member. |

#### `moderation` (8 tools)

Kick, ban, unban, timeout, nicknames, bulk delete, audit log.

| Tool | Kind | What it does |
|---|---|---|
| `kick_member` | destructive | Removes a member from the server; they can rejoin with an invite. |
| `ban_member` | destructive | Bans a user so they cannot rejoin; works for current members and for users who already left (pass their user ID). |
| `unban_member` | write | Lifts a ban so the user can rejoin with an invite. |
| `list_bans` | read-only | Lists banned users with their ban reasons, in pages (pass next_cursor as cursor). |
| `timeout_member` | write | Times a member out (they cannot send messages, react or join voice) for a duration such as "10m", "1h" or "7d" (max 28 days). |
| `set_nickname` | write | Sets a member's server nickname, or resets it with an empty string. |
| `bulk_delete_messages` | destructive | Deletes many recent messages in one channel at once: scans the last `scan` messages (max 100) and deletes those matching the filters (author, text). |
| `get_audit_log` | read-only | Reads recent audit log entries (who did what, to whom, why), newest first. |

#### `threads` (5 tools)

Threads and forum posts (including archived), forum tags.

| Tool | Kind | What it does |
|---|---|---|
| `list_threads` | read-only | Lists threads or forum posts. |
| `read_forum` | read-only | Reads a forum or media channel in one call: each post with its title, tags, author, message count, last activity and opening message, optionally the latest replies. |
| `create_thread` | write | Starts a thread in a text/announcement channel (from an existing message, or standalone; private: true for an invite-only thread), or creates a forum/media post with a first message, tags, embeds and files. |
| `edit_thread` | write | Renames, archives/unarchives, locks/unlocks, pins (forum posts), sets tags, slowmode or auto-archive of a thread or forum post, including archived ones (by ID or link). |
| `manage_forum_tags` | write | Adds, updates or removes the tags available in a forum or media channel (max 20). |

#### `voice` (8 tools)

Move, disconnect, mute and deafen voice members; scheduled events.

| Tool | Kind | What it does |
|---|---|---|
| `move_member` | write | Moves a member who is connected to voice into another voice or stage channel. |
| `disconnect_member` | write | Disconnects a member from their current voice or stage channel. |
| `set_voice_state` | write | Server-mutes/unmutes and/or server-deafens/undeafens a member in voice. |
| `list_events` | read-only | Lists the server's scheduled events (upcoming and active) with type, status, times, location and interest count. |
| `create_event` | write | Schedules a server event: type "voice" or "stage" (in a channel) or "external" (a location or link, needs an end time). |
| `edit_event` | write | Changes a scheduled event's name, description, times, channel or location, or its status: "active" starts it, "completed" ends it, "canceled" cancels a scheduled one. |
| `delete_event` | destructive | Permanently deletes a scheduled event (use edit_event status "canceled" to cancel it visibly instead). |
| `list_event_users` | read-only | Lists users who marked themselves interested in a scheduled event, in pages. |

#### `webhooks` (4 tools)

List, create and delete webhooks; send messages through them.

| Tool | Kind | What it does |
|---|---|---|
| `list_webhooks` | read-only | Lists webhooks in the server or one channel with ID, name, type, channel and creator. |
| `create_webhook` | write | Creates an incoming webhook in a channel, optionally with an avatar. |
| `delete_webhook` | destructive | Deletes a webhook; anything using its URL stops working. |
| `send_webhook_message` | write | Posts a message through a webhook (chosen by ID or name), optionally with a custom display name and avatar, embeds and files. |

#### `invites` (4 tools)

List, create, inspect and revoke invites.

| Tool | Kind | What it does |
|---|---|---|
| `list_invites` | read-only | Lists active invites of the server (or one channel) with uses, limits, expiry and creator. |
| `create_invite` | write | Creates an invite link to a channel. |
| `get_invite` | read-only | Shows what any invite code or link points to: server, channel, inviter, expiry and approximate member counts. |
| `delete_invite` | destructive | Revokes an invite so the link stops working. |

#### `emoji` (7 tools)

Custom emoji and stickers.

| Tool | Kind | What it does |
|---|---|---|
| `list_emoji` | read-only | Lists the server's custom emoji with the code to use in messages (<:name:id>), animated/managed flags and role restrictions. |
| `create_emoji` | write | Uploads a custom emoji from an image (max 256 KB). |
| `edit_emoji` | write | Renames a custom emoji and/or sets which roles can use it ([] = everyone). |
| `delete_emoji` | destructive | Permanently deletes a custom emoji. |
| `list_stickers` | read-only | Lists the server's custom stickers with ID, format, related emoji tag and description. |
| `create_sticker` | write | Uploads a custom sticker from a PNG, APNG, GIF (max 512 KB, 320x320) or Lottie JSON file. |
| `delete_sticker` | destructive | Permanently deletes a custom sticker. |

#### `insights` (3 tools)

Export conversations, server snapshots and comparisons, message statistics.

| Tool | Kind | What it does |
|---|---|---|
| `export_messages` | read-only | Saves a channel, ticket, thread, forum post or DM to a Markdown transcript or JSON file (authors, times, replies, attachment links, embeds, reactions). |
| `server_snapshot` | read-only | Saves the server's structure as JSON (settings, roles with permissions, categories and channels with their permission overwrites, emoji) to GUILDORA_EXPORT_DIR, e.g. |
| `message_stats` | read-only | Counts messages over a period ("7d" by default) for the server or a category/channel: totals for people and bots, the busiest channels, the most active people, messages per day and the busiest hours (UTC). |
<!-- tools:end -->

## Prompts

Guildora also offers MCP prompts: ready-made workflows your client shows as prompts or slash
commands (in Claude Code: `/mcp__guildora__server_digest` and so on). They only use enabled tools, and
they never send or change anything without your approval; in read-only mode they only draft.

| Prompt | What it does | Arguments |
|---|---|---|
| `server_digest` | Highlights, who is waiting for staff, and activity by channel | `since` (default `24h`), `guild` |
| `triage_forum` | Reviews forum posts (screenshots included), rates severity, drafts replies | `forum`, `tag` |
| `reply_queue` | Lists conversations waiting for staff, longest first, with draft replies | `scope`, `staff_roles` |
| `catch_up` | Summarises messages received this session, mentions of the bot first | `scope` |

## Inputs

Tools resolve what you give them, so the model does not need lookup calls first:

| Argument | Accepts |
|---|---|
| channel / category / thread | `123456789012345678`, `<#123…>`, `https://discord.com/channels/…`, `general`, `#general`, `💬・general` |
| role | ID, `<@&123…>`, `Moderators`, `@Moderators`, `everyone` |
| member / user | ID, `<@123…>`, username, display name or nickname |
| emoji | `👍`, `<:party:123…>`, `:party:`, `party`, ID |
| message | ID (with `channel`) or a message link |
| server (`guild`) | ID or name; optional with `DISCORD_GUILD_ID` or a single server |
| durations | `30s`, `10m`, `2h`, `7d`, `1h30m`, or seconds |
| colors | `#5865F2`, `5865F2`, `Blurple`, `Red` |
| permissions | `ManageMessages`, `MANAGE_MESSAGES`, `Manage Messages` |

Name matching ignores case, emoji and punctuation. If a name matches several items, the tool
returns an error listing them with IDs. Archived threads are not in the name cache, so pass them
by ID or link (`list_threads` shows them).

## Safety

- **Confirmation:** destructive tools (`delete_message`, `delete_channel`, `delete_role`,
  `kick_member`, `ban_member`, `bulk_delete_messages`, `delete_permission_overwrite`,
  `delete_webhook`, `delete_invite`, `delete_event`, `delete_emoji`, `delete_sticker`) first return
  `DRY RUN: nothing was changed. Would: …` with warnings (for example "its 4 channels move out of
  the category"). Only a second call with `"confirm": true` acts. `bulk_delete_messages` gives an
  `up_to` ID so the confirmed call deletes exactly the previewed set.
- **Read-only mode:** `GUILDORA_READ_ONLY=true` removes every write and destructive tool from the
  tool list, so they cannot be called at all.
- **Pre-flight checks:** role hierarchy, server owner, missing bot permissions and Discord limits
  (2,000 characters, 14-day bulk delete, 28-day timeout) are checked before calling Discord.
- **Mentions:** `@everyone`/`@here` only ping when `mention_everyone: true`.
- **Files:** local paths work only in stdio mode (where the server runs as you). URLs must be
  https, are size-limited, do not follow redirects, and are refused if they resolve to private or
  local addresses.
- **HTTP:** loopback by default, Host/Origin checks against DNS rebinding, optional bearer token.
- **Secrets:** the token is never logged; logs go to stderr; webhook tokens never reach the model.

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and token-handling advice.

## Search and limits

- `search_messages` uses Discord's server-wide search when the bot can (whole history, all
  channels, filters for author, mentions, `has`, pinned, dates). If it is unavailable, still
  indexing, or `scan: true` is passed, it scans one channel's history up to `GUILDORA_SCAN_LIMIT`
  and states how many messages it scanned and whether it reached the start, with a cursor to go on.
- Lists take `limit` and return `next_cursor`; nothing dumps thousands of items.
- Rate limits are queued by discord.js. A call that had to wait says so; a wait over 10 seconds
  fails with the retry time instead of hanging.

## Coming from SaseQ/discord-mcp

<details>
<summary>Where each SaseQ tool went</summary>

| SaseQ tool(s) | Guildora |
|---|---|
| `get_server_info` | `get_server_info` |
| `get_user_id_by_name`, `search_members` | `list_members` with `query` (and name resolution everywhere) |
| `get_member_by_id` | `get_member` |
| `send_message`, `send_private_message` | `send_message` (`channel` or `user`) |
| `edit_message`, `edit_private_message` | `edit_message` |
| `delete_message`, `delete_private_message` | `delete_message` |
| `read_messages`, `read_private_messages` | `read_messages` |
| `get_message`, `get_attachment`, `get_message_replies` | `get_message` (attachments included; `include_replies`) |
| `search_messages` | `search_messages` |
| `add_reaction`, `remove_reaction` | `add_reaction`, `remove_reaction` |
| `create_text_channel`, `create_voice_channel`, `create_stage_channel`, `create_forum_channel`, `create_category` | `create_channel` (`type`) |
| `edit_text_channel`, `edit_voice_channel`, `edit_forum_channel`, `edit_category`, `move_channel` | `edit_channel` |
| `delete_channel`, `delete_category` | `delete_channel` |
| `find_channel`, `list_channels`, `list_channels_in_category`, `list_forum_channels` | `list_channels` (filters: `type`, `category`, `query`) |
| `find_category` | `list_channels` with `type: "category"` |
| `get_channel_info`, `get_forum_channel_info`, `list_forum_tags`, `get_thread_info` | `get_channel` |
| `list_channel_permission_overwrites` | `list_permission_overwrites` |
| `upsert_role_channel_permissions`, `upsert_member_channel_permissions` | `set_permissions` |
| `delete_channel_permission_overwrite` | `delete_permission_overwrite` |
| `list_roles` | `list_roles` |
| `create_role`, `edit_role`, `delete_role` | same names |
| `assign_role`, `remove_role` | `add_member_role`, `remove_member_role` |
| `kick_member`, `ban_member`, `unban_member`, `set_nickname` | same names |
| `timeout_member`, `remove_timeout` | `timeout_member` (`duration: "0"` removes) |
| `get_bans` | `list_bans` |
| `move_member`, `disconnect_member` | same names |
| `modify_voice_state` | `set_voice_state` |
| `create/edit/delete_guild_scheduled_event`, `list_guild_scheduled_events`, `get_guild_scheduled_event_users` | `create_event`, `edit_event`, `delete_event`, `list_events`, `list_event_users` |
| `create_webhook`, `delete_webhook`, `list_webhooks`, `send_webhook_message` | same names (by ID or name, no URLs) |
| `create_invite`, `list_invites`, `delete_invite`, `get_invite_details` | `create_invite`, `list_invites`, `delete_invite`, `get_invite` |
| `list_active_threads`, `list_threads`, `list_forum_posts` | `list_threads` |
| `create_forum_post` | `create_thread` |
| `modify_forum_post` | `edit_thread` |
| `list_emojis`, `get_emoji_details` | `list_emoji` |
| `create_emoji`, `edit_emoji`, `delete_emoji` | same names |

Nothing was dropped. Merged tools keep the options of the originals; raw permission bitfields and decimal colors are replaced by permission names and hex or named colors.
</details>

## Development

```bash
git clone https://github.com/az-xx/guildora-mcp.git
cd guildora-mcp
npm install
npm test          # unit tests, no token needed
npm run build
npm run docs:tools  # regenerate the tool tables in this README
```

`npm run test:live` runs a smoke test against a real server when `DISCORD_TOKEN` and
`GUILDORA_TEST_GUILD_ID` are set (for example in a local `.env`, which is git-ignored). See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Feature set inspired by [SaseQ/discord-mcp](https://github.com/SaseQ/discord-mcp) (MIT). Built
with [discord.js](https://discord.js.org) and the
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## License

[MIT](LICENSE) © Guildora contributors
