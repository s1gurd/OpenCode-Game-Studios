import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSettings, convertPermissions, extractClaudeImports, generateAgentsMd } from './convert.mjs';

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
