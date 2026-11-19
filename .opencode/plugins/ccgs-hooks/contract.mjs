// ccgs-hooks adapter contract: turns OpenCode V2 tool/session events into the
// Claude Code hook contract (stdin JSON + exit codes + stdout) understood by
// .claude/hooks/*.sh, and turns their answers back into OpenCode decisions.
// Pure functions only — plugin wiring lives in index.ts.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const TOOL_NAMES = { bash: 'Bash', write: 'Write', edit: 'Edit', patch: 'Edit', read: 'Read' };

export function parseHookSettings(settings) {
  const regs = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const h of group.hooks ?? []) {
        const m = /\.claude[\\/]hooks[\\/]([\w-]+\.sh)/.exec(h.command);
        if (!m) continue;
        regs.push({
          event,
          matcher: group.matcher ? group.matcher.split('|').map(s => s.trim()) : null,
          script: m[1],
          timeoutSec: h.timeout ?? 10,
          async: h.async === true,
        });
      }
    }
  }
  return regs;
}

export function toClaudeTool(openCodeTool) {
  return TOOL_NAMES[openCodeTool] ?? null;
}

export function matchReg(reg, claudeTool) {
  return !reg.matcher || reg.matcher.includes(claudeTool);
}

export function normalizePath(p, repoDir) {
  const norm = p.replace(/\\/g, '/');
  const root = repoDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm.toLowerCase() === root.toLowerCase()) return '';
  if (norm.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return norm.slice(root.length + 1);
  return norm;
}

export function claudeInput({ event, tool, input, sessionID, cwd }) {
  const tool_name = toClaudeTool(tool);
  let tool_input = {};
  if (tool_name === 'Bash') tool_input = { command: input.command };
  else if (tool_name === 'Write')
    tool_input = { file_path: normalizePath(input.filePath, cwd), content: input.content };
  else if (tool_name === 'Edit')
    tool_input = {
      file_path: normalizePath(input.filePath, cwd),
      old_string: input.oldString,
      new_string: input.newString,
    };
  else if (tool_name === 'Read') tool_input = { file_path: normalizePath(input.filePath, cwd) };
  return { hook_event_name: event, session_id: sessionID ?? '', cwd, tool_name, tool_input };
}

export function editTargets({ tool, input }) {
  if (tool === 'write' || tool === 'edit') return [input.filePath];
  const paths = [];
  for (const m of input.patch?.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm) ?? []) {
    paths.push(m[1].trim());
  }
  return paths;
}

export function parseHookResult({ code, stdout, stderr }) {
  const out = (stdout ?? '').trim();
  if (out.startsWith('{')) {
    try {
      const j = JSON.parse(out);
      if (j.decision === 'block') return { decision: 'block', reason: j.reason ?? (stderr ?? '').trim() };
      return {
        decision: 'allow',
        additionalContext: j.hookSpecificOutput?.additionalContext,
        systemMessage: j.systemMessage,
      };
    } catch {
      /* not JSON: fall through to exit-code semantics */
    }
  }
  if (code === 2) return { decision: 'block', reason: (stderr ?? '').trim() || out };
  if (code !== 0) return { decision: 'skip', stderr: (stderr ?? '').trim() };
  if (out) return { decision: 'allow', additionalContext: out };
  return { decision: 'allow' };
}

export function findBash(envPath = process.env.PATH, platform = process.platform, probe = versionProbe) {
  const exe = platform === 'win32' ? 'bash.exe' : 'bash';
  const candidates = [];
  for (const dir of (envPath ?? '').split(path.delimiter).filter(Boolean)) {
    const direct = path.join(dir, exe);
    if (fs.existsSync(direct)) candidates.push(direct);
    // Git for Windows ships bash.exe in <GitRoot>\bin, often absent from PATH
    // while <GitRoot>\cmd (git.exe) is: derive it from wherever git lives.
    const git = path.join(dir, platform === 'win32' ? 'git.exe' : 'git');
    if (fs.existsSync(git)) {
      const root = path.dirname(path.dirname(git));
      for (const sub of [path.join('bin', exe), path.join('usr', 'bin', exe)]) {
        const derived = path.join(root, sub);
        if (fs.existsSync(derived) && !candidates.includes(derived)) candidates.push(derived);
      }
    }
  }
  for (const cand of candidates) {
    const major = Number(/version\s+(\d+)/.exec(probe(cand) ?? '')?.[1] ?? 0);
    if (major >= 4) return cand;
  }
  return null;
}

function versionProbe(exe) {
  try {
    return spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  } catch {
    return '';
  }
}

export async function runHook({ bash, script, root, input, timeoutMs, async: isAsync }) {
  const opts = {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  };
  const stdin = JSON.stringify(input ?? {});
  if (isAsync) {
    const child = spawn(bash, [script], opts);
    child.stdin.end(stdin);
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  }
  const res = spawnSync(bash, [script], { ...opts, input: stdin });
  if (res.error?.code === 'ETIMEDOUT') return { code: -1, stdout: '', stderr: 'timeout', timedOut: true };
  return {
    code: res.status ?? -1,
    stdout: res.stdout?.toString() ?? '',
    stderr: res.stderr?.toString() ?? '',
    timedOut: false,
  };
}

export function writeTranscript(stateDir, callID, prompt, lastAssistant) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, `${callID}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', message: { content: prompt } }),
    JSON.stringify({ type: 'assistant', message: { content: lastAssistant } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
