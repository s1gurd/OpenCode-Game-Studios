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
    instructions: INSTRUCTIONS,
    permissions: [...rules, { action: 'shell', resource: '*', effect: 'ask' }],
  };
  return JSON.stringify(config, null, 2) + '\n';
}

function writeOpencodeJson() {
  const rules = convertPermissions(parseSettings());
  fs.writeFileSync('opencode.json', renderOpencodeJson(rules));
  console.log(`opencode.json: ${rules.length + 1} permission rules`);
}

if (process.argv[1] && process.argv[1].endsWith('convert.mjs')) {
  const target = process.argv[2];
  if (target === 'opencode' || target === 'all') writeOpencodeJson();
  else if (!process.argv[2]) console.log('usage: convert.mjs <opencode|agents|commands|agents-md|all>');
}
