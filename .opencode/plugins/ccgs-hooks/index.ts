// ccgs-hooks: runs the repo's Claude Code hooks (.claude/hooks/*.sh) from
// OpenCode V2. Registration table comes from .claude/settings.json itself, so
// upstream changes to hook wiring apply without touching this file.
import fs from 'node:fs';
import path from 'node:path';
import { Plugin } from '@opencode/plugin';
import {
  parseHookSettings,
  toClaudeTool,
  matchReg,
  claudeInput,
  editTargets,
  parseHookResult,
  findBash,
  runHook,
  writeTranscript,
  callKey,
} from './contract.mjs';

export default Plugin.define({
  id: 'ccgs-hooks',
  async setup(ctx: any) {
    const root = ctx.location.directory;
    const logFile = path.join(root, '.opencode/state/ccgs-hooks.log');
    const log = (msg: string) => {
      console.log(msg);
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
      } catch { /* logging must never break a hook run */ }
    };
    let settings;
    try {
      settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
    } catch {
      log('[ccgs-hooks] no .claude/settings.json here; plugin inactive');
      return;
    }
    const regs = parseHookSettings(settings);
    const bash = findBash();
    if (!bash) {
      log('[ccgs-hooks] hooks are off: bash not found on PATH (install Git for Windows); tool calls are not validated');
      return;
    }
    const hooksDir = path.join(root, '.claude/hooks');
    const stateDir = path.join(root, '.opencode/state/agent-transcripts');
    const run = (reg: any, input: any) =>
      runHook({ bash, script: path.join(hooksDir, reg.script), root, input, timeoutMs: reg.timeoutSec * 1000, async: reg.async });
    const decide = async (reg: any, input: any) => parseHookResult(await run(reg, input));
    const note = (reg: any, out: any) => {
      if (out.decision === 'skip') log(`[ccgs-hooks] ${reg.script} skipped (code!=0): ${out.stderr ?? ''}`.slice(0, 500));
    };

    const injected = new Set<string>();
    const compacted = new Set<string>();
    const stashed = new Map<string, { prompt: string; agent: string }>();

    // SessionStart: once per session, before the first model call.
    await ctx.session.hook('context', async (event: any) => {
      const sid = event.sessionID;
      if (injected.has(sid)) return;
      injected.add(sid);
      const source = compacted.has(sid) ? 'compact' : 'startup';
      for (const reg of regs.filter(r => r.event === 'SessionStart')) {
        const out = await decide(reg, { hook_event_name: 'SessionStart', source, session_id: sid, cwd: root, transcript_path: '' });
        if (out.additionalContext) event.system.push({ type: 'text', text: out.additionalContext });
        if (out.systemMessage) event.system.push({ type: 'text', text: out.systemMessage });
        log(`[ccgs-hooks] ${reg.script} -> session context for ${sid} (${source}, ${out.additionalContext?.length ?? 0} chars)`);
        note(reg, out);
      }
    });

    // PreCompact: checkpoint before summaries; the answer never blocks.
    await ctx.session.hook('compaction', (event: any) => {
      compacted.add(event.sessionID);
      // Let the next context call re-run SessionStart hooks with source 'compact'.
      injected.delete(event.sessionID);
      for (const reg of regs.filter(r => r.event === 'PreCompact')) {
        void run(reg, { hook_event_name: 'PreCompact', source: 'auto', session_id: event.sessionID, cwd: root });
      }
    });

    await ctx.tool.hook('execute.before', async (event: any) => {
      const claude = toClaudeTool(event.tool);
      if (claude) {
        const matching = regs.filter(r => r.event === 'PreToolUse' && matchReg(r, claude));
        if (event.tool === 'patch') {
          const targets = editTargets({ tool: event.tool, input: event.input });
          if (!targets.length) log('[ccgs-hooks] warning: patch payload carried no "File:" targets; write guards skipped');
          for (const reg of matching) {
            for (const target of targets) {
              const input = claudeInput({ event: 'PreToolUse', tool: 'edit', input: { filePath: target }, sessionID: event.sessionID, cwd: root });
              const out = await decide(reg, input);
              if (out.decision === 'block') {
                log(`[ccgs-hooks] BLOCKED ${reg.script}: ${out.reason}`.slice(0, 800));
                throw new Error(`[studio hook ${reg.script}] ${out.reason}`);
              }
            }
          }
          return;
        }
        const input = claudeInput({ event: 'PreToolUse', tool: event.tool, input: event.input, sessionID: event.sessionID, cwd: root });
        if (!input) return;
        for (const reg of matching) {
          const out = await decide(reg, input);
          if (out.decision === 'block') {
            log(`[ccgs-hooks] BLOCKED ${reg.script}: ${out.reason}`.slice(0, 800));
            throw new Error(`[studio hook ${reg.script}] ${out.reason}`);
          }
          note(reg, out);
        }
      } else if (event.tool === 'subagent' || event.tool === 'task') {
        const key = callKey(event) || `sub-${Date.now()}`;
        stashed.set(key, { prompt: event.input?.prompt ?? event.input?.task ?? '', agent: event.input?.agent ?? event.input?.subagent_type ?? '' });
        for (const reg of regs.filter(r => r.event === 'SubagentStart')) {
          void run(reg, { hook_event_name: 'SubagentStart', session_id: event.sessionID, cwd: root, agent_type: event.input?.agent ?? event.input?.subagent_type ?? '', agent_id: key });
        }
      }
    });

    await ctx.tool.hook('execute.after', async (event: any) => {
      if (event.status !== 'completed') return;
      const claude = toClaudeTool(event.tool);
      if (claude === 'Write' || claude === 'Edit') {
        if (event.tool === 'patch') {
          const targets = editTargets({ tool: event.tool, input: event.input });
          if (!targets.length) log('[ccgs-hooks] warning: patch payload carried no "File:" targets; post guards skipped');
          for (const reg of regs.filter(r => r.event === 'PostToolUse' && matchReg(r, claude))) {
            for (const target of targets) {
              const input = claudeInput({ event: 'PostToolUse', tool: 'edit', input: { filePath: target }, sessionID: event.sessionID, cwd: root });
              const out = await decide(reg, input);
              if (out.additionalContext) log(`[ccgs-hooks ${reg.script}] ${out.additionalContext}`.slice(0, 2000));
              note(reg, out);
            }
          }
          return;
        }
        const input = claudeInput({ event: 'PostToolUse', tool: event.tool, input: event.input, sessionID: event.sessionID, cwd: root });
        if (!input) return;
        for (const reg of regs.filter(r => r.event === 'PostToolUse' && matchReg(r, claude))) {
          const out = await decide(reg, input);
          if (out.additionalContext) log(`[ccgs-hooks ${reg.script}] ${out.additionalContext}`.slice(0, 2000));
          note(reg, out);
        }
      } else if (event.tool === 'subagent' || event.tool === 'task') {
        const key = callKey(event) || `sub-${Date.now()}`;
        const s = stashed.get(key) ?? { prompt: '', agent: '' };
        stashed.delete(key);
        const last = resultText(event.result);
        const transcript = writeTranscript(stateDir, key, s.prompt, last);
        for (const reg of regs.filter(r => r.event === 'SubagentStop')) {
          const out = await decide(reg, {
            hook_event_name: 'SubagentStop',
            session_id: event.sessionID,
            cwd: root,
            agent_type: s.agent,
            agent_id: key,
            agent_transcript_path: transcript,
            last_assistant_message: last,
          });
          if (out.decision === 'block') log(`[ccgs-hooks ${reg.script}] artifact check: ${out.reason}`.slice(0, 2000));
          note(reg, out);
        }
      }
    });

    // Notification + Stop via the event bus.
    const controller = new AbortController();
    void (async () => {
      const props = (ev: any) => ev.properties ?? ev.payload ?? {};
      for await (const ev of ctx.event.subscribe({ types: ['session.idle', 'permission.asked'], signal: controller.signal })) {
        const sid = props(ev).sessionID ?? '';
        if (ev.type === 'session.idle') {
          for (const reg of regs.filter(r => r.event === 'Stop')) void run(reg, { hook_event_name: 'Stop', session_id: sid, cwd: root, stop_hook_active: true });
          for (const reg of regs.filter(r => r.event === 'Notification' && matchReg(r, 'idle_prompt'))) {
            void run(reg, { hook_event_name: 'Notification', message: 'idle_prompt', session_id: sid, cwd: root });
          }
        } else if (ev.type === 'permission.asked') {
          for (const reg of regs.filter(r => r.event === 'Notification' && matchReg(r, 'permission_prompt'))) {
            void run(reg, { hook_event_name: 'Notification', message: 'permission_prompt', session_id: sid, cwd: root });
          }
        }
      }
    })();

    log(`[ccgs-hooks] loaded: ${regs.length} registrations, bash=${bash}`);
    return () => controller.abort();
  },
});

function resultText(result: any): string {
  if (!result) return '';
  if (typeof result.output === 'string') return result.output.slice(0, 20000);
  return JSON.stringify(result).slice(0, 20000);
}
