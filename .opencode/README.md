# OpenCode adaptation (ccgs-hooks)

This repo is built for Claude Code; the files here make it work equally well in
**OpenCode V2** without changing anything under `.claude/`. Both harnesses can be
used on the same checkout.

## What OpenCode loads

| Piece | Where | How |
|---|---|---|
| Root instructions | `AGENTS.md` | generated mirror of `CLAUDE.md` (import lines moved to `opencode.json`) |
| Always-on docs | `opencode.json` → `instructions` | extracted from the `@path` import lines in `CLAUDE.md`, incl. the engine `VERSION.md` once `/setup-engine` adds one |
| Permissions | `opencode.json` → `permissions` | 1:1 from `.claude/settings.json` allow/deny (`Bash(`/`PowerShell(` → `shell`, `Read(`/`Edit(` → `read`/`edit`), ordered for V2 last-match-wins: catch-all `ask` first, `allow` next, `deny` last |
| Agents | `.opencode/agents/*.md` | generated from `.claude/agents/` (49), `mode: subagent` + a full allow/deny permission matrix |
| Skills | `.claude/skills/` (untouched) | OpenCode auto-discovers the Claude compat path |
| Slash commands | `.opencode/commands/*.md` | one shim per skill: loads the skill and forwards `$ARGUMENTS` |
| Hooks | `.opencode/plugins/ccgs-hooks/` | a V2 plugin that runs the same `.claude/hooks/*.sh` under the Claude hook contract, driven by `.claude/settings.json` |

## Re-running after an upstream upgrade

```
node .opencode/tools/convert.mjs all          # or: opencode | agents | commands | agents-md
```

Regenerates `opencode.json`, `AGENTS.md`, `.opencode/agents/`, `.opencode/commands/`.
Idempotent; review `git diff` afterwards. The hook plugin reads `.claude/settings.json`
at load time, so changes to which hooks run where apply without regenerating anything.
Then reload OpenCode (`/reload`) or start a new session.

## Deliberate losses

- `statusline.sh` — no OpenCode equivalent.
- Agent `maxTurns` and per-agent `memory:` — no equivalent; generated agents carry neither.
- Claude model aliases (`opus`/`sonnet`) — agents run on the session's model.
- Skill frontmatter `allowed-tools:`/`model:` — OpenCode ignores them; studio skills
  run with the invoking agent's permissions. The real guards are the `ccgs-hooks`
  plugin (commit/push/write/registry validation) and `opencode.json` permissions.

## Adapter behavior (ccgs-hooks)

Registration table = `.claude/settings.json` `hooks` (events, matchers, timeouts, async).
Mapping: `PreToolUse`/`PostToolUse` → tool `execute.before/after` (`bash`/`shell`→Bash,
`write`/`edit`/`patch`→Write/Edit per file, `read`→Read); `SessionStart` → first model
call of a session (context is pushed into the system part once per session,
`source: startup|compact`); `PreCompact` → compaction hook; `SubagentStart/Stop` → the
subagent tool, with a synthesized `agent_transcript_path` JSONL under
`.opencode/state/agent-transcripts/`; `Stop`/`Notification` → `session.idle` /
`permission.asked` events. Exit 2 or `{"decision":"block"}` throws with the script's
reason, which the model sees; crashes and timeouts let the call through (same
"continue" default as upstream).

## Troubleshooting

- Adapter's own log: `.opencode/state/ccgs-hooks.log` (load line, injected contexts,
  blocks, skipped scripts).
- `[ccgs-hooks] hooks are off: bash not found` — install Git for Windows. The adapter
  requires bash **≥ 4** and derives Git Bash from the `git` location even when
  `Git\bin\bash.exe` is absent from PATH (MinGW msys 3.1 is rejected).
- `[ccgs-hooks] no .claude/settings.json here` — the plugin only acts in CCGS repos.
- A blocked write/commit quoting `[studio hook validate-*.sh]` is a studio guard
  working as designed, not an adapter bug.

## Acceptance (live V2 desktop session, 2026-11-19)

- Studio skills, agents and always-on docs load; `session-start.sh` /
  `detect-gaps.sh` inject context at session start (state log).
- `validate-commit.sh` blocked a commit of malformed `assets/data/*.json`
  before it ran (`BLOCKED ... is not valid JSON`).
- `opencode.json` deny rules block before execution: `Remove-Item -Recurse`
  returned `permission.rejected`, nothing was created or deleted.
- Subagents are audited: `production/session-logs/agent-audit.log` gains
  `Agent invoked/completed`, and a per-call transcript JSONL appears in
  `.opencode/state/agent-transcripts/` named by the tool-call id.
- Full adapter+generator test suite: 43/43; `git status --porcelain .claude`
  clean throughout.
