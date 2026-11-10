# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/az-xx/guildora-mcp/security/advisories/new)
instead. Include steps to reproduce and the version you use. You should get an answer within a
week.

Supported versions: the latest release on npm.

## Protecting your bot token

The bot token gives full control of the bot. Anyone who has it can act in every server the bot
is in.

- Never commit it, paste it into issues or chats, or put it in screenshots.
- Pass it through your MCP client's `env` settings. Remember that `claude mcp add -e ...` stores
  it in Claude Code's config file and your shell history; prefer exporting it in your shell
  profile or using your OS secret store where possible.
- If it leaks, reset it at once: Developer Portal > your app > **Bot** > **Reset Token**. The old
  token stops working immediately.
- Grant the bot only the permissions you need (see the invite links in the README), and avoid
  Administrator.

Guildora never logs the token and redacts it (and webhook tokens) from its logs.

## Running over HTTP

- By default Guildora listens on `127.0.0.1` only and checks `Host`/`Origin` headers against DNS
  rebinding.
- Anyone who can reach the HTTP endpoint can use the bot. If you bind to another address, always
  set `GUILDORA_HTTP_TOKEN` to a long random value and put the server behind HTTPS.
- Local file paths for attachments are disabled over HTTP.

## Prompt injection

Messages in Discord are untrusted input. A message can try to instruct the model to do
something harmful. Guildora reduces the impact: destructive tools need `confirm: true`,
`GUILDORA_READ_ONLY=true` removes all write tools, and packs let you expose only what you need.
Review dry runs before confirming, and use read-only mode when you only need to read.
