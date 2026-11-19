import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  parseHookSettings, toClaudeTool, matchReg, normalizePath, claudeInput,
  editTargets, parseHookResult, findBash, runHook, writeTranscript,
} from './contract.mjs';
import { parseSettings } from '../../tools/convert.mjs';

test('parseHookSettings: 15 registrations with per-event counts', () => {
  const regs = parseHookSettings(parseSettings());
  assert.equal(regs.length, 15);
  const count = ev => regs.filter(r => r.event === ev).length;
  assert.equal(count('SessionStart'), 2);
  assert.equal(count('PreToolUse'), 5);
  assert.equal(count('PostToolUse'), 2);
  assert.equal(count('Notification'), 1);
  assert.equal(count('PreCompact'), 1);
  assert.equal(count('Stop'), 1);
  assert.equal(count('SubagentStart'), 1);
  assert.equal(count('SubagentStop'), 2);
});

test('parseHookSettings: script name, timeout and async extracted', () => {
  const regs = parseHookSettings(parseSettings());
  const commit = regs.find(r => r.script === 'validate-commit.sh');
  assert.equal(commit.event, 'PreToolUse');
  assert.equal(commit.timeoutSec, 15);
  assert.equal(commit.async, false);
  const stop = regs.find(r => r.script === 'session-stop.sh');
  assert.equal(stop.async, true);
});

test('toClaudeTool maps OpenCode tool names to Claude names', () => {
  assert.equal(toClaudeTool('bash'), 'Bash');
  assert.equal(toClaudeTool('write'), 'Write');
  assert.equal(toClaudeTool('edit'), 'Edit');
  assert.equal(toClaudeTool('patch'), 'Edit');
  assert.equal(toClaudeTool('read'), 'Read');
  assert.equal(toClaudeTool('task'), null);
});

test('matchReg applies Claude matcher semantics', () => {
  const regs = parseHookSettings(parseSettings());
  const commit = regs.find(r => r.script === 'validate-commit.sh');
  const write = regs.find(r => r.script === 'validate-write.sh');
  const start = regs.find(r => r.script === 'session-start.sh');
  assert.ok(matchReg(commit, 'Bash') && !matchReg(commit, 'Edit'));
  assert.ok(matchReg(write, 'Edit') && !matchReg(write, 'Bash'));
  assert.ok(matchReg(start, 'Bash') && matchReg(start, 'Write'));
});

test('normalizePath: windows absolute under repo becomes repo-relative', () => {
  const root = 'C:\\AI\\Claude-Code-Game-Studios';
  assert.equal(
    normalizePath('C:\\AI\\Claude-Code-Game-Studios\\design\\a.md', root),
    'design/a.md',
  );
  assert.equal(normalizePath('design/b.md', root), 'design/b.md');
  assert.equal(normalizePath('C:/Other/x.md', root), 'C:/Other/x.md');
});

test('claudeInput: bash command payload', () => {
  const p = claudeInput({
    event: 'PreToolUse', tool: 'bash', sessionID: 's1', cwd: '/r',
    input: { command: 'git commit -m x' },
  });
  assert.equal(p.hook_event_name, 'PreToolUse');
  assert.equal(p.session_id, 's1');
  assert.equal(p.tool_name, 'Bash');
  assert.deepEqual(p.tool_input, { command: 'git commit -m x' });
});

test('claudeInput: write and edit payloads carry Claude key names', () => {
  const w = claudeInput({ event: 'PreToolUse', tool: 'write', cwd: '/r', input: { filePath: 'design/a.md', content: 'hi' } });
  assert.equal(w.tool_name, 'Write');
  assert.equal(w.tool_input.file_path, 'design/a.md');
  assert.equal(w.tool_input.content, 'hi');
  const e = claudeInput({ event: 'PreToolUse', tool: 'edit', cwd: '/r', input: { filePath: 'design/a.md', oldString: 'x', newString: 'y' } });
  assert.equal(e.tool_name, 'Edit');
  assert.equal(e.tool_input.old_string, 'x');
  assert.equal(e.tool_input.new_string, 'y');
});

test('editTargets: write/edit give one path, patch every header path', () => {
  assert.deepEqual(editTargets({ tool: 'write', input: { filePath: 'a.md' } }), ['a.md']);
  assert.deepEqual(editTargets({ tool: 'edit', input: { filePath: 'b.md' } }), ['b.md']);
  const patch = [
    '*** Begin Patch',
    '*** Update File: design/x.md',
    '@@',
    '+line',
    '*** Add File: design/y.md',
    '+other',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(editTargets({ tool: 'patch', input: { patch } }), ['design/x.md', 'design/y.md']);
});

test('parseHookResult: exit 2 blocks with stderr reason', () => {
  const r = parseHookResult({ code: 2, stdout: '', stderr: 'no data JSON commits' });
  assert.equal(r.decision, 'block');
  assert.equal(r.reason, 'no data JSON commits');
});

test('parseHookResult: JSON decision block', () => {
  const r = parseHookResult({ code: 0, stdout: JSON.stringify({ decision: 'block', reason: 'denied' }), stderr: '' });
  assert.equal(r.decision, 'block');
  assert.equal(r.reason, 'denied');
});

test('parseHookResult: additionalContext and systemMessage passthrough', () => {
  const r = parseHookResult({
    code: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { additionalContext: 'ctx' },
      systemMessage: 'sys',
    }),
    stderr: '',
  });
  assert.equal(r.decision, 'allow');
  assert.equal(r.additionalContext, 'ctx');
  assert.equal(r.systemMessage, 'sys');
});

test('parseHookResult: plain stdout is context, garbage non-zero is skip', () => {
  const plain = parseHookResult({ code: 0, stdout: 'SESSION STATE\nmore', stderr: '' });
  assert.equal(plain.decision, 'allow');
  assert.equal(plain.additionalContext, 'SESSION STATE\nmore');
  const junk = parseHookResult({ code: 3, stdout: 'not json', stderr: 'boom' });
  assert.equal(junk.decision, 'skip');
});

test('findBash finds bash on this machine (repo requires it)', () => {
  assert.ok(findBash());
});

test('findBash: prefers bash >= 4 over ancient msys 3.1', () => {
  const probe = cand => (/mingw/i.test(cand) ? 'GNU bash, version 3.1.23(1)-release' : 'GNU bash, version 5.2.15(1)-release');
  const picked = findBash(`C:\\MinGW\\msys\\1.0\\bin;C:\\Program Files\\Git\\bin`, 'win32', probe);
  assert.equal(picked, path.join('C:\\Program Files\\Git\\bin', 'bash.exe'));
});

test('findBash: default probe rejects this machine MinGW 3.1 if present', () => {
  const found = findBash();
  const out = spawnSyncVersion(found);
  assert.match(out, /version [456]\./, `live bash must be >=4, got: ${out}`);
});

function spawnSyncVersion(exe) {
  const r = nodeSpawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true });
  return r.stdout ?? '';
}

test('runHook: pipes stdin JSON, captures stdout and exit 2', async () => {
  const bash = findBash();
  const script = path.join(os.tmpdir(), 'ccgs-it-echo.sh');
  fs.writeFileSync(script, '#!/bin/bash\ncat > ccgs-it-stdin.json\nexit 2\n');
  const res = await runHook({
    bash, script, root: os.tmpdir(),
    input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } },
    timeoutMs: 5000, async: false,
  });
  assert.equal(res.code, 2);
  assert.equal(res.timedOut, false);
  const given = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'ccgs-it-stdin.json'), 'utf8'));
  assert.equal(given.tool_input.command, 'x');
});

test('runHook: timeout kills and reports', async () => {
  const bash = findBash();
  const script = path.join(os.tmpdir(), 'ccgs-it-sleep.sh');
  fs.writeFileSync(script, '#!/bin/bash\nsleep 5\n');
  const res = await runHook({ bash, script, root: os.tmpdir(), input: {}, timeoutMs: 300, async: false });
  assert.equal(res.timedOut, true);
});

test('writeTranscript: first user line is the prompt, second the result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-tr-'));
  const file = writeTranscript(dir, 'call1', 'make the artifact at design/x.md', 'Done: wrote design/x.md');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines[0].type, 'user');
  assert.equal(lines[0].message.content, 'make the artifact at design/x.md');
  assert.equal(lines[1].type, 'assistant');
  assert.equal(lines[1].message.content, 'Done: wrote design/x.md');
});

test('integration: real session-start.sh yields non-empty context', async () => {
  const bash = findBash();
  const res = await runHook({
    bash, script: '.claude/hooks/session-start.sh', root: process.cwd(),
    input: { hook_event_name: 'SessionStart', source: 'startup', session_id: 'itest', cwd: process.cwd(), transcript_path: '' },
    timeoutMs: 20000, async: false,
  });
  assert.equal(res.timedOut, false);
  assert.equal(res.code, 0);
  const parsed = parseHookResult(res);
  assert.ok(parsed.additionalContext && parsed.additionalContext.length > 100, 'context present');
});

test('integration: real validate-write.sh runs clean on an ordinary file', async () => {
  const bash = findBash();
  const res = await runHook({
    bash, script: '.claude/hooks/validate-write.sh', root: process.cwd(),
    input: { hook_event_name: 'PreToolUse', session_id: 'itest', cwd: process.cwd(), tool_name: 'Write', tool_input: { file_path: 'design/some-art.md', content: '# x' } },
    timeoutMs: 15000, async: false,
  });
  assert.equal(res.timedOut, false);
  assert.notEqual(parseHookResult(res).decision, undefined);
});
