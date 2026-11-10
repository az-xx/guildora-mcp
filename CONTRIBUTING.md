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
claude mcp add guildora-dev -e DISCORD_TOKEN=... -- npx -y --package=/absolute/path/guildora-mcp-<version>.tgz guildora-mcp
```

Use an absolute path for `--package`. On native Windows, put `cmd /c` before `npx`.

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

## Releasing (maintainers)

Releases are published by GitHub Actions (`.github/workflows/release.yml`) using npm Trusted
Publishing: no npm token, no 2FA prompt, and the package gets a provenance statement.

1. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` (and the compare links at the bottom).
2. Bump the version without tagging, then commit:

   ```bash
   npm version x.y.z --no-git-tag-version
   git commit -am "chore(release): x.y.z"
   ```

3. Push the commit, then the tag:

   ```bash
   git push
   git tag vx.y.z
   git push origin vx.y.z
   ```

The workflow checks that the tag matches `package.json`, runs lint, typecheck, tests, build and
the docs check, publishes to npm (skipped if that version is already there) and creates the GitHub
release from the changelog section. New npm versions can stay in npm's "Validating" state for a
few minutes before they can be installed.

One-time setup (once per package): on npmjs.com open the package >
**Settings** > **Trusted Publisher** > **GitHub Actions**, and enter owner `az-xx`, repository
`guildora-mcp`, workflow `release.yml`.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
  `test:`, `refactor:`, `build:`, `ci:`, `chore:`.
- Keep pull requests focused. CI (lint, format, typecheck, tests on Ubuntu and Windows) must pass.
- Never commit tokens, `.env` files or real server data.

## Code of conduct

Be kind and assume good intent. Harassment of any kind is not tolerated.
