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

export const BUILTIN_ACTIONS = ['read', 'edit', 'glob', 'grep', 'shell', 'webfetch', 'websearch', 'skill', 'subagent', 'question'];

export const CLAUDE_TOOL_TO_ACTIONS = {
  Read: ['read'],
  Write: ['edit'],
  Edit: ['edit'],
  Glob: ['glob'],
  Grep: ['grep'],
  Bash: ['shell'],
  WebSearch: ['webfetch', 'websearch'],
  WebFetch: ['webfetch'],
  Agent: ['subagent'],
  Task: ['subagent'],
  Skill: ['skill'],
  Question: ['question'],
  Todo: [],
};

export function convertAgent(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(raw);
  if (!m) throw new Error('agent file has no frontmatter');
  const fm = {};
  let lastKey;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1];
      fm[lastKey] = kv[2].trim();
    } else if (lastKey && line.trim()) {
      fm[lastKey] += ' ' + line.trim();
    }
  }
  const body = raw.slice(m[0].length);
  const list = s => (s ?? '').replace(/^\[|\]$/g, '').split(',').map(x => x.trim()).filter(Boolean);
  const allowed = new Set();
  for (const key of ['tools', 'disallowedTools']) {
    for (const t of list(fm[key])) {
      const acts = CLAUDE_TOOL_TO_ACTIONS[t];
      if (!acts) throw new Error(`Unknown Claude tool "${t}" in ${fm.name ?? '?'}`);
      for (const a of acts) (key === 'tools' ? allowed.add(a) : allowed.delete(a));
    }
  }
  const rules = BUILTIN_ACTIONS.map(action => ({
    action,
    resource: '*',
    effect: allowed.has(action) ? 'allow' : 'deny',
  }));
  for (const s of list(fm.skills)) rules.push({ action: 'skill', resource: s, effect: 'allow' });
  const desc = JSON.stringify((fm.description ?? 'studio subagent').replace(/^"|"$/g, ''));
  const yaml = rules
    .map(r => `  - action: ${r.action}\n    resource: ${JSON.stringify(r.resource)}\n    effect: ${r.effect}`)
    .join('\n');
  return `---\ndescription: ${desc}\nmode: subagent\npermissions:\n${yaml}\n---\n\n${body}`;
}

function writeAgents() {
  fs.mkdirSync('.opencode/agents', { recursive: true });
  const files = fs.readdirSync('.claude/agents').filter(f => f.endsWith('.md'));
  for (const f of files) {
    fs.writeFileSync('.opencode/agents/' + f, convertAgent(fs.readFileSync('.claude/agents/' + f, 'utf8')));
  }
  console.log(`agents: ${files.length} written`);
}

export function skillIds(dir = '.claude/skills') {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(`${dir}/${d.name}/SKILL.md`))
    .map(d => d.name)
    .sort();
}

export function commandShims(ids) {
  return ids.map(id => {
    const raw = fs.readFileSync(`.claude/skills/${id}/SKILL.md`, 'utf8');
    const fm = raw.split(/^---\s*$/m)[1] ?? '';
    const desc = (/^description:\s*(.*)$/m.exec(fm)?.[1] ?? id).trim().replace(/^"|"$/g, '');
    const body =
      `---\ndescription: ${JSON.stringify(desc)}\n---\n\n` +
      `Load the skill \`${id}\` with the skill tool, then follow it exactly ` +
      `using these arguments from the user: $ARGUMENTS\n`;
    return { path: `.opencode/commands/${id}.md`, body };
  });
}

function writeCommands() {
  fs.mkdirSync('.opencode/commands', { recursive: true });
  const shims = commandShims(skillIds());
  for (const s of shims) fs.writeFileSync(s.path, s.body);
  console.log(`commands: ${shims.length} written`);
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
