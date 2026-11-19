import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings, convertPermissions } from './convert.mjs';

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
