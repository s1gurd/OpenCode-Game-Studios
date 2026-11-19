import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSettings, convertPermissions, renderOpencodeJson, extractClaudeImports, generateAgentsMd, convertAgent, commandShims, skillIds } from './convert.mjs';


const settings = {
  permissions: {
    allow: ['Bash(bash .claude/scripts/registry.sh *)'],
    deny: [
      'Bash(git push *--force*)',
      'PowerShell(Remove-Item *-Recurse*)',
      'Read(**/.env*)',
      'Edit(**/*.uasset)',
    ],
  },
};

test('convertPermissions maps Bash to shell deny', () => {
  const rules = convertPermissions(settings);
  assert.deepEqual(
    rules.find(r => r.resource === 'git push *--force*'),
    { action: 'shell', resource: 'git push *--force*', effect: 'deny' },
  );
});

test('convertPermissions maps PowerShell to shell deny', () => {
  const rules = convertPermissions(settings);
  assert.deepEqual(
    rules.find(r => r.resource === 'Remove-Item *-Recurse*'),
    { action: 'shell', resource: 'Remove-Item *-Recurse*', effect: 'deny' },
  );
});

test('convertPermissions maps Read and Edit prefixes', () => {
  const rules = convertPermissions(settings);
  assert.deepEqual(
    rules.find(r => r.resource === '**/.env*'),
    { action: 'read', resource: '**/.env*', effect: 'deny' },
  );
  assert.deepEqual(
    rules.find(r => r.resource === '**/*.uasset'),
    { action: 'edit', resource: '**/*.uasset', effect: 'deny' },
  );
});

test('convertPermissions maps allow list with effect allow', () => {
  const rules = convertPermissions(settings);
  assert.deepEqual(
    rules.find(r => r.resource === 'bash .claude/scripts/registry.sh *'),
    { action: 'shell', resource: 'bash .claude/scripts/registry.sh *', effect: 'allow' },
  );
});

test('all allow rules precede all deny rules', () => {
  const rules = convertPermissions(settings);
  const lastAllow = rules.map(r => r.effect).lastIndexOf('allow');
  const firstDeny = rules.map(r => r.effect).indexOf('deny');
  assert.ok(lastAllow < firstDeny);
});

test('unknown rule prefix throws', () => {
  assert.throws(
    () => convertPermissions({ permissions: { allow: [], deny: ['Weird(x)'] } }),
    /Weird\(x\)/,
  );
});

test('renderOpencodeJson: V2 is last-match-wins, so the catch-all ask comes first and deny stays last', () => {
  const cfg = JSON.parse(renderOpencodeJson([
    { action: 'shell', resource: 'git status *', effect: 'allow' },
    { action: 'shell', resource: 'rm -rf *', effect: 'deny' },
  ]));
  const p = cfg.permissions;
  assert.deepEqual(p[0], { action: 'shell', resource: '*', effect: 'ask' });
  assert.equal(p.at(-1).effect, 'deny');
  assert.ok(p.findIndex(r => r.effect === 'allow') < p.findIndex(r => r.effect === 'deny'));
  assert.equal(p.filter(r => r.resource === '*' && r.effect === 'ask').length, 1);
});

test('parseSettings reads the real settings.json', () => {
  const s = parseSettings('.claude/settings.json');
  assert.ok(s.permissions.allow.length > 0);
  assert.ok(s.permissions.deny.length >= 120);
  assert.ok(s.hooks.SessionStart.length >= 1);
});

test('extractClaudeImports finds the three always-on docs of the real CLAUDE.md', () => {
  const imports = extractClaudeImports(fs.readFileSync('CLAUDE.md', 'utf8'));
  assert.deepEqual(imports, [
    '.claude/docs/directory-structure.md',
    '.claude/docs/coordination-rules.md',
    '.claude/docs/coding-standards.md',
  ]);
});

test('extractClaudeImports also finds a future engine VERSION.md import', () => {
  const imports = extractClaudeImports('text\n@docs/engine-reference/unity/VERSION.md\nmore');
  assert.deepEqual(imports, ['docs/engine-reference/unity/VERSION.md']);
});

test('generateAgentsMd drops import lines and appends port notes', () => {
  const out = generateAgentsMd('Header\n@.claude/docs/x.md\nBody\n');
  assert.ok(!out.includes('@.claude/'));
  assert.ok(out.includes('Header\nBody'));
  assert.ok(out.includes('## OpenCode Port Notes'));
});

const gd = convertAgent(fs.readFileSync('.claude/agents/game-designer.md', 'utf8'));

test('convertAgent: mode subagent, no model field, Claude keys stripped', () => {
  const fm = gd.split(/^---\s*$/m)[1];
  assert.match(fm, /mode: subagent/);
  assert.ok(!/^model:/m.test(fm), 'no model field');
  assert.ok(!/disallowedTools|maxTurns|memory:/m.test(fm));
  assert.match(fm, /description: "Mechanical and systems design/);
});

test('convertAgent: permission matrix matches the Claude tools list', () => {
  for (const action of ['read', 'edit', 'glob', 'grep', 'webfetch', 'websearch']) {
    assert.ok(
      new RegExp(`- action: ${action}\\n +resource: "\\*"\\n +effect: allow`).test(gd),
      `${action} must be allow`,
    );
  }
  for (const action of ['shell', 'subagent', 'question', 'skill']) {
    assert.ok(
      new RegExp(`- action: ${action}\\n +resource: "\\*"\\n +effect: deny`).test(gd),
      `${action} must be deny`,
    );
  }
});

test('convertAgent: listed skills allowed after the catch-all deny', () => {
  const catchAll = gd.search(/- action: skill\n +resource: "\*"\n +effect: deny/);
  const specific = gd.search(/- action: skill\n +resource: "balance-check"\n +effect: allow/);
  assert.ok(catchAll >= 0 && specific > catchAll, 'last-match-wins ordering');
});

test('convertAgent: opus/sonnet aliases never become a model field', () => {
  const producer = convertAgent(fs.readFileSync('.claude/agents/producer.md', 'utf8'));
  assert.ok(!/^model:/m.test(producer));
});

test('convertAgent: body preserved byte-identically', () => {
  const raw = fs.readFileSync('.claude/agents/qa-lead.md', 'utf8');
  const body = raw.slice(raw.indexOf('\n', raw.indexOf('---', 3) + 3) + 1);
  assert.ok(convertAgent(raw).endsWith(body));
});

test('convertAgent: unknown Claude tool throws', () => {
  assert.throws(
    () => convertAgent('---\nname: x\ndescription: "d"\ntools: Read, NotebookEdit\n---\nbody\n'),
    /NotebookEdit/,
  );
});

test('commandShims: one command per skill id with id and $ARGUMENTS', () => {
  const shims = commandShims(['prototype', 'cut']);
  assert.equal(shims.length, 2);
  assert.equal(shims[0].path, '.opencode/commands/prototype.md');
  assert.ok(shims[0].body.includes('prototype'));
  assert.ok(shims[0].body.includes('$ARGUMENTS'));
  assert.ok(
    shims[0].body.includes('description: "Asks a few questions'),
    'description quoted exactly once',
  );
});

test('commandShims: real skill set matches .claude/skills dirs with SKILL.md', () => {
  const ids = skillIds();
  assert.ok(ids.includes('prototype') && ids.includes('cut'));
  const expected = fs
    .readdirSync('.claude/skills', { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(`.claude/skills/${d.name}/SKILL.md`)).length;
  assert.equal(ids.length, expected);
});
