#!/usr/bin/env node
// Converts Claude Code constructs (settings.json permissions, agents, skills,
// CLAUDE.md) to OpenCode V2 artifacts. Run: node .opencode/tools/convert.mjs <target>
// Targets: opencode | agents | commands | agents-md | all
import fs from 'node:fs';

const INSTRUCTIONS = [
  '.claude/docs/directory-structure.md',
  '.claude/docs/coordination-rules.md',
  '.claude/docs/coding-standards.md',
];

const PREFIX_ACTIONS = { Bash: 'shell', PowerShell: 'shell', Read: 'read', Edit: 'edit' };

let settingsCache = null;

export function parseSettings(path = '.claude/settings.json') {
  settingsCache ??= JSON.parse(fs.readFileSync(path, 'utf8'));
  return settingsCache;
}

export function convertPermissions(settings) {
  const rules = [];
  for (const [list, effect] of [
    [settings.permissions.allow ?? [], 'allow'],
    [settings.permissions.deny ?? [], 'deny'],
  ]) {
    for (const entry of list) {
      const m = /^(Bash|PowerShell|Read|Edit)\((.*)\)$/.exec(entry);
      if (!m) throw new Error(`Unrecognized permission rule: ${entry}`);
      rules.push({ action: PREFIX_ACTIONS[m[1]], resource: m[2], effect });
    }
  }
  return rules;
}

export function renderOpencodeJson(rules) {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    instructions: instructionsFromClaudeMd(),
    permissions: [...rules, { action: 'shell', resource: '*', effect: 'ask' }],
  };
  return JSON.stringify(config, null, 2) + '\n';
}

export function extractClaudeImports(markdown) {
  const out = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^\s*@([\w./-]+\.md)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function instructionsFromClaudeMd() {
  let imports = [];
  try {
    imports = extractClaudeImports(fs.readFileSync('CLAUDE.md', 'utf8'));
  } catch {
    /* CLAUDE.md absent: fall back to the constant list */
  }
  return [...new Set([...imports, ...INSTRUCTIONS])];
}

const PORT_NOTES = `
## OpenCode Port Notes

Generated mirror of CLAUDE.md for OpenCode (re-run: \`node .opencode/tools/convert.mjs agents-md\`).
Deliberate differences from Claude Code:

- \`statusline.sh\`, agent \`maxTurns\`, and per-agent \`memory\` have no OpenCode equivalent and are not emulated.
- Skill frontmatter \`allowed-tools\`/\`model:\` are not enforced by OpenCode; studio skills run with the invoking agent's permissions. The guards are the \`ccgs-hooks\` plugin and \`opencode.json\` permissions.
- Hooks run through the \`ccgs-hooks\` plugin, which executes the same \`.claude/hooks/*.sh\` scripts under the Claude hook stdin/stdout contract, driven by \`.claude/settings.json\`.
- See \`.opencode/README.md\` for the upgrade/re-run flow and adapter troubleshooting.
`;

export function generateAgentsMd(claudeMd) {
  const kept = claudeMd.split(/\r?\n/).filter(line => !extractClaudeImports(line).length);
  return kept.join('\n').trimEnd() + '\n' + PORT_NOTES;
}

function writeAgentsMd() {
  fs.writeFileSync('AGENTS.md', generateAgentsMd(fs.readFileSync('CLAUDE.md', 'utf8')));
  console.log('AGENTS.md written');
}

function writeOpencodeJson() {
  const rules = convertPermissions(parseSettings());
  fs.writeFileSync('opencode.json', renderOpencodeJson(rules));
  console.log(`opencode.json: ${rules.length + 1} permission rules`);
}

if (process.argv[1] && process.argv[1].endsWith('convert.mjs')) {
  const target = process.argv[2];
  const targets = ['opencode', 'agents', 'commands', 'agents-md'];
  if (target === 'all') targets.forEach(run);
  else if (targets.includes(target)) run(target);
  else console.log('usage: convert.mjs <opencode|agents|commands|agents-md|all>');
}

function run(target) {
  if (target === 'opencode') writeOpencodeJson();
  else if (target === 'agents-md') writeAgentsMd();
  else if (target === 'agents') writeAgents();
  else if (target === 'commands') writeCommands();
}
