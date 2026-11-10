# Contributing to Guildora

Thanks for helping! Bug reports, docs fixes and new tools are all welcome.

## Getting started

```bash
git clone https://github.com/az-xx/guildora-mcp.git
cd guildora-mcp
npm install
npm test
```

Node.js 22 or newer is required. Unit tests use fakes for discord.js and never need a token.

Useful scripts:

| Script | What it does |
|---|---|
| `npm test` | Unit tests (Vitest) |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run typecheck` | TypeScript, strict mode |
| `npm run build` | Compile to `dist/` |
| `npm run docs:tools` | Regenerate the tool tables in README.md (after `build`) |
| `npm run test:live` | Smoke test against a real server (see below) |

### Trying it locally

```bash
npm run build
npm pack                                  # creates guildora-mcp-<version>.tgz
claude mcp add guildora-dev -e DISCORD_TOKEN=... -- npx -y ./guildora-mcp-<version>.tgz
```

Or inspect it with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector -e DISCORD_TOKEN=... node dist/index.js
```

### Live smoke test

Create a throwaway test server, invite your bot, and put `DISCORD_TOKEN`,
`GUILDORA_TEST_GUILD_ID` and optionally `GUILDORA_TEST_CHANNEL_ID` in a local `.env` file (it is
git-ignored; see `.env.example`). Then run `npm run test:live`. Never use a production server.

## Adding or changing a tool

1. Put it in the right pack under `src/tools/<pack>/`. Keep `core` under 20 tools.
2. Use `defineTool` and set `readOnly`, `destructive` and `permissions` honestly. Destructive tools
   implement `prepare()` and return a `Plan`; the framework handles `confirm` and dry runs.
3. Accept friendly inputs: use the resolvers in `src/discord/resolve.ts` and the helpers in
   `src/tools/shared.ts` instead of requiring raw IDs.
4. Write the description for the model: what it does, when to use it instead of a similar tool,
   and what it returns. Keep it short.
5. Return compact text with IDs **and** names. Paginate lists with `limit` and a cursor.
6. Throw `GuildoraError` with a message that says what to do next.
7. Do not import values from `discord.js` outside `src/discord/client.ts` (ESLint enforces this):
   it takes most of a second to load. Use `import type` and `src/discord/api.ts`.
8. Add tests, run `npm run build && npm run docs:tools`, and update `CHANGELOG.md`.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
  `test:`, `refactor:`, `build:`, `ci:`, `chore:`.
- Keep pull requests focused. CI (lint, format, typecheck, tests on Ubuntu and Windows) must pass.
- Never commit tokens, `.env` files or real server data.

## Code of conduct

Be kind and assume good intent. Harassment of any kind is not tolerated.
