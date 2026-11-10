// Prints the CHANGELOG.md section for one version, as GitHub release notes.
// Usage: node scripts/release-notes.js 0.2.0
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/release-notes.js <version>');
  process.exit(1);
}

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const start = changelog.indexOf(`## [${version}]`);
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}.`);
  process.exit(1);
}
const rest = changelog.slice(start);
const next = rest.slice(1).search(/\n## \[|\n\[[^\]]+\]: /);
const section = (next === -1 ? rest : rest.slice(0, next + 1))
  .split('\n')
  .slice(1)
  .join('\n')
  .trim();

console.log(`\`\`\`bash
claude mcp add guildora -e DISCORD_TOKEN=your-bot-token -- npx -y guildora-mcp
\`\`\`

npm: https://www.npmjs.com/package/guildora-mcp/v/${version} · Setup: see the [README](https://github.com/az-xx/guildora-mcp#setup-about-5-minutes).

${section}

Guildora is an MCP server for Discord. It is not affiliated with Discord Inc.`);
