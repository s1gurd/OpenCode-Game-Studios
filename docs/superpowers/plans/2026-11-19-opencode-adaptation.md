# OpenCode Adaptation (CCGS overlay + hook adapter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude Code Game Studios repo fully usable from OpenCode V2 (agents, skills, commands, permissions, instructions, and all 15 hook registrations) without touching `.claude/`.

**Architecture:** Additive overlay: generated `AGENTS.md`/`opencode.json`/`.opencode/agents`/`.opencode/commands` + one OpenCode server plugin (`ccgs-hooks`) that re-runs the existing `bash .claude/hooks/*.sh` under the Claude hook stdin/stdout contract, driven by `.claude/settings.json` itself. Skills load unchanged from the `.claude/skills` compat path.

**Tech Stack:** Node ≥22 stdlib only (ESM `.mjs`, `node:test`); OpenCode V2 plugin API (`Plugin.define`, `ctx.tool.hook`, `ctx.session.hook`, `ctx.event.subscribe`); bash + python (already repo requirements).

**Spec:** `docs/superpowers/specs/2026-11-19-opencode-adaptation-design.md` (read it alongside this plan).

## Global Constraints

- Runtime target: OpenCode V2 desktop server ≥2.3.0. The `opencode` binary on PATH (1.19.4) is NOT a target — never validate V2 features with it.
- Zero npm dependencies; Node stdlib only. Plugin dir must not assume a `package.json` (see Task 6 fallback).
- `.claude/**` is read-only: the plan never creates, edits, or deletes a file under it.
- Generated agent files never write a `model:` field (inherit session model; spec "Решения владельца").
- Skill frontmatter `allowed-tools`/`model:` are a documented non-goal — no enforcement bridge.
- All generated/committed files use LF; no trailing-whitespace noise. Repo-relative paths in hook payloads use forward slashes.
- Commits: concise imperative English, one per task (matches repo history style). Work on branch `main` in `C:\AI\Claude-Code-Game-Studios`.
- Tests run with `node --test <file>` from the repo root.

## Review Focus

- Git Bash absent from PATH → adapter logs one "hooks are off" warning at setup and lets all tool calls through (mirrors the upstream wrapper) — pinned in Task 5 (`findBash`).
- Hook script crash, timeout, or non-JSON stdout → decision is `skip` (allow + log), never a block and never a plugin crash (upstream "continue" default) — pinned in Task 5 (`parseHookResult`, `runHook`).
- Windows backslash / absolute-under-repo paths from OpenCode tools → `tool_input.file_path` normalized to repo-relative forward-slash form, else scripts validate the wrong tree — pinned in Task 5 (`normalizePath`).
- `patch`/multi-file writes → the Write|Edit hooks run once per target file; any block blocks the whole call — pinned in Task 5 (`matchTool`/`editTargets`).
- A CCGS agent that lists no `Bash` in its Claude `tools:` must get `shell` **deny**, not default `ask` — otherwise the subagent stalls on prompts or bypasses guards — pinned in Task 3 (golden frontmatter for `game-designer`).

---

### Task 1: Generator + `opencode.json` (instructions + permissions)

**Files:**
- Create: `.opencode/tools/convert.mjs`, `.opencode/tools/convert.test.mjs`, `opencode.json`
- Read (never modify): `.claude/settings.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `convert.mjs` exports `parseSettings(path) -> {permissions:{allow:string[],deny:string[]}, hooks:[...]}` (raw JSON parse, memoized), `convertPermissions(settings) -> Rule[]` where `Rule = {action:string, resource:string, effect:"allow"|"deny"}`, and `renderOpencodeJson(rules) -> string`. `parseSettings` is reused by Tasks 3–4.

- [x] **Step 1: Write the failing test** `.opencode/tools/convert.test.mjs`:
```js
// convertPermissions: "Bash(git push *--force*)" -> {action:"shell",resource:"git push *--force*",effect:"deny"}
// "PowerShell(Remove-Item *-Recurse*)" -> {action:"shell", resource:"Remove-Item *-Recurse*", effect:"deny"}
// "Read(**/.env*)" -> {action:"read", resource:"**/.env*", effect:"deny"}
// "Edit(**/*.uasset)" -> {action:"edit", resource:"**/*.uasset", effect:"deny"}
// "Bash(bash .claude/scripts/registry.sh *)" -> {action:"shell", resource:"bash .claude/scripts/registry.sh *", effect:"allow"}
// order: all allow rules before all deny rules (deny must win on overlap)
```

- [x] **Step 2: Run** `node --test .opencode/tools/convert.test.mjs` — FAIL (exports missing).
- [x] **Step 3: Implement** the exports. Prefix parse: leading `Bash(`/`PowerShell(`/`Read(`/`Edit(` + closing `)` → action + inner resource; unknown prefixes throw.
- [x] **Step 4: Run test** — PASS.
- [x] **Step 5: Emit `opencode.json`** via a `main` branch in convert.mjs (`node .opencode/tools/convert.mjs opencode`): `$schema: "https://opencode.ai/config.json"`, `instructions: [".claude/docs/directory-structure.md", ".claude/docs/coordination-rules.md", ".claude/docs/coding-standards.md"]`, `permissions: convertPermissions(...)` + trailing `{"action":"shell","resource":"*","effect":"ask"}` last (unknown commands ask; configured deny/allow match first).
- [x] **Step 6: Verify counts:** `node -e "const r=require('./opencode.json').permissions; console.log(r.length, r.filter(x=>x.effect==='deny').length)"` → expect `≥150` total and `≥120` deny (130 upstream minus `Bash(...)`-prefix-free oddities; print and eyeball the oddities — any resource that is not a literal/`*`/`?` string is a conversion bug).
- [x] **Step 7: Commit** `git add opencode.json .opencode/tools && git commit -m "Add OpenCode config and permissions generator"`.

### Task 2: `AGENTS.md` from `CLAUDE.md`

**Files:** Create: `AGENTS.md`. Read-only: `CLAUDE.md`.

**Interfaces:** Consumes: nothing. Produces: root instructions file read by every OpenCode session (the three `@import` targets load via Task 1 `instructions`).

- [x] **Step 1: Generate deterministically** — add `convert.mjs` command `agents-md`: copy `CLAUDE.md` verbatim, delete only the standalone `@.claude/...` import lines (leaving their preceding headings/notes intact), and append one section: `## OpenCode Port Notes` listing the losses (statusline.sh, maxTurns, agent memory, skill-level allowed-tools/model) and pointing at `.opencode/README.md`. Verify: `git diff` shows only removed `@`-lines + appended section.
- [x] **Step 2: Manual check** — search AGENTS.md for `@.claude/` → zero hits; `OpenCode Port Notes` present.
- [x] **Step 3: Commit** `"Add AGENTS.md mirror of CLAUDE.md for OpenCode"`.

### Task 3: Convert 49 agents to `.opencode/agents/`

**Files:** Modify: `.opencode/tools/convert.mjs`, `.opencode/tools/convert.test.mjs`; Create: `.opencode/agents/*.md` (49).
**Read-only:** `.claude/agents/*.md`.

**Interfaces:** Consumes: `parseSettings` (Task 1). Produces: `convertAgent(name, fm, body) -> string` (V2 markdown: `---\ndescription: …\nmode: subagent\npermissions:\n  - {action, resource, effect}\n---\n<body verbatim>`), `BUILTIN_ACTIONS = ["read","edit","glob","grep","shell","webfetch","websearch","skill","subagent","question"]`, `CLAUDE_TOOL_TO_ACTIONS = {Read:["read"],Glob:["glob"],Grep:["grep"],Write:["edit"],Edit:["edit"],Bash:["shell"],WebSearch:["webfetch","websearch"],Task:["subagent"],Todo:[],WebFetch:["webfetch"],Skill:["skill"],Question:["question"]}` (unknown Claude tool name → throw, forces review on upstream drift).

- [x] **Step 1: Write failing tests:** (a) `game-designer` (tools `Read,Glob,Grep,Write,Edit,WebSearch`; `disallowedTools: Bash`; `skills: [balance-check]`; `model: inherit`) produces frontmatter with `mode: subagent`, **no** `model:` line, `edit`/`read`/`glob`/`grep` allow, `shell` **deny** (explicit, even though not in tools), `webfetch`+`websearch` allow, all other BUILTIN_ACTIONS default `deny`, then per-skill rules `{action:"skill",resource:"balance-check",effect:"allow"}` then `{action:"skill",resource:"*",effect:"deny"}`; (b) an agent with `model: opus` also yields **no** model field; (c) unknown tool `"NotebookEdit"` throws; (d) body text after frontmatter is byte-identical.
- [x] **Step 2: Run** — FAIL.
- [x] **Step 3: Implement** `convertAgent` + command `agents` writing one file per `.claude/agents/*.md` (filename = agent id; strip Claude keys `name,tools,model,disallowedTools,maxTurns,skills,memory`; keep `description`, normalize to V2 permission list).
- [x] **Step 4: Run test** — PASS.
- [x] **Step 5: Generate + count:** `node .opencode/tools/convert.mjs agents` → `(Get-ChildItem .opencode/agents -Filter *.md).Count -eq 49`; `Select-String -Path .opencode/agents/*.md -Pattern '^model:'` → zero matches.
- [x] **Step 6: Commit** `"Generate OpenCode agents from Claude agent definitions"`.

### Task 4: Command shims for all 78 skills

**Files:** Modify: `.opencode/tools/convert.mjs`, `.opencode/tools/convert.test.mjs`; Create: `.opencode/commands/<skill-id>.md` (78).

**Interfaces:** Consumes: filesystem (`skillIds(): readdir `.claude/skills` dirs containing `SKILL.md``). Produces: one command per skill id; body = `Load the skill \`<id>\` with the skill tool, then follow it with these arguments: $ARGUMENTS` + frontmatter `description:` = the skill's SKILL.md frontmatter `description` (first line, quoted).

- [x] **Step 1: Write failing test:** `commandShims(skillIds)` returns `[{path:".opencode/commands/prototype.md", body}]`, body contains the literal skill id and `$ARGUMENTS`; nested/grouping dirs excluded except direct children of `.claude/skills`.
- [x] **Step 2: Run** — FAIL. **Step 3: Implement** + command `commands`. **Step 4: Run** — PASS.
- [x] **Step 5: Generate:** count = `(Get-ChildItem .claude/skills -Directory | Where Test-Path (Join-Path $_.FullName 'SKILL.md')).Count` equals number of files written (78 today; recompute, don't hardcode).
- [x] **Step 6: Commit** `"Add slash-command shims for all studio skills"`.

### Task 5: Hook-adapter contract core (`contract.mjs`) — pure functions

**Files:** Create `.opencode/plugins/ccgs-hooks/contract.mjs`, `.opencode/plugins/ccgs-hooks/contract.test.mjs`.

**Interfaces:**
- Consumes: `parseSettings` from `../../tools/convert.mjs` (relative import).
- Produces (used by Task 6):
  - `parseHookSettings(settings) -> Reg[]` where `Reg={event:"SessionStart"|"PreToolUse"|"PostToolUse"|"Notification"|"PreCompact"|"Stop"|"SubagentStart"|"SubagentStop", matcher:RegExp|null, script:string(basename), timeoutSec:number, async:boolean}`; script extracted from `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/<name>.sh"` inside the wrapper command.
  - `toClaudeTool(openCodeTool) -> "Bash"|"Write"|"Edit"|"Read"|null` (`bash`→Bash, `write`→Write, `edit`|`patch`→Edit, `read`→Read, else null).
  - `matchReg(reg, claudeTool) -> boolean` (matcher `Bash|PowerShell` matches Bash; empty→true).
  - `normalizePath(p, repoDir) -> repo-relative slash path` (backslashes→slashes, absolute-under-repo→relative, else absolute unchanged).
  - `claudeInput({event, tool, input, sessionID, cwd}) -> object` with `{hook_event_name, session_id, cwd, tool_name, tool_input:{file_path|command, content?, old_string?, new_string?}}` — keys per script expectations (validate-write reads `tool_input.file_path`; validate-commit reads `tool_input.command`).
  - `editTargets(input) -> string[]` — for `write`/`edit` one path; for `patch` every file in its patch (one payload per file).
  - `parseHookResult({code,stdout,stderr}) -> {decision:"block"|"allow"|"skip", reason?, additionalContext?, systemMessage?}` — exit 2 → block w/ stderr reason; stdout JSON `decision:"block"` → block w/ `reason`; JSON `hookSpecificOutput.additionalContext` → allow+context; unparseable/other non-zero → skip.
  - `findBash(envPath, platform) -> string|null` (probe `bash`/`bash.exe` on PATH).
  - `runHook({bash,script,root,input,timeoutMs,async}) -> Promise<{code,stdout,stderr,timedOut}>` (spawnSync/spawn; stdin = one-line JSON; env `CLAUDE_PROJECT_DIR=root`; on timeout kill, `timedOut:true`).
  - `writeTranscript(stateDir, callID, prompt, lastAssistant) -> path` — JSONL: first line `{type:"user",message:{content:prompt}}`, second `{type:"assistant",message:{content:lastAssistant}}`; path `<stateDir>/<callID>.jsonl`.

- [x] **Step 1: Write failing tests** covering, at minimum: 15 Regs parsed from the real `settings.json` (assert per-event counts from the spec table: SessionStart 2, PreToolUse 5, PostToolUse 2, Notification 1, PreCompact 1, Stop 1, SubagentStart 1, SubagentStop 2); `toClaudeTool('patch')==='Edit'`; `normalizePath('C:\\AI\\Claude-Code-Game-Studios\\design\\a.md', root)==='design/a.md'`; exit-2 block reason; garbage stdout → skip; `writeTranscript` round-trip lines; `findBash` on this machine non-null (it is required by the repo anyway).
- [x] **Step 2: Run** `node --test .opencode/plugins/ccgs-hooks/contract.test.mjs` — FAIL.
- [x] **Step 3: Implement** `contract.mjs` (stdlib only: `node:child_process`, `node:fs`, `node:path`).
- [x] **Step 4: Run** — PASS.
- [x] **Step 5: Integration pin:** add test spawning the **real** `bash .claude/hooks/session-start.sh` with `{hook_event_name:"SessionStart", cwd:<repo>, source:"startup", session_id:"itest"}` — expect exit 0 and parseHookResult().additionalContext non-empty (script writes under `production/session-logs/`; allow it, it is the framework's own runtime dir). Also `validate-write.sh` with a `production/`-external file_path returns decision ≠ crash. Run — PASS.
- [x] **Step 6: Commit** `"Add hook adapter contract core with tests"`.

### Task 6: Plugin wiring (`.opencode/plugins/ccgs-hooks/index.ts`) + transcript bridge

**Files:** Create: `.opencode/plugins/ccgs-hooks/index.ts`; Modify: `.gitignore` (append block: `# OpenCode adapter state` + `.opencode/state/`).

**Interfaces:** Consumes: every export of `contract.mjs` (Task 5). Produces: registered V2 plugin `id: "ccgs-hooks"`; state dir `<location>/.opencode/state/agent-transcripts/`.

- [x] **Step 1: Event-name discovery (no guesses):** fetch the OpenAPI schema and list real event types for idle/permission before coding: `Invoke-WebRequest http://127.0.0.1:28894/openapi.json -Headers @{Authorization='Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('opencode:'+(Get-Content "$env:USERPROFILE\.config\opencode\service.json" | ConvertFrom-Json).password))` → search `V2EventEncoded` for session idle / permission types. Record exact names; if a name is missing, fall back to `session.updated` status transitions.
- [x] **Step 2: Implement** `index.ts` with `Plugin.define({id:"ccgs-hooks", setup(ctx){...}})`:
  - setup: `parseSettings`+`parseHookSettings`; `findBash`; no bash → `console.log` one "ccgs-hooks off" line and return (Review Focus #1).
  - `tool.hook("execute.before")`: Bash|PowerShell regs → payload via `claudeInput` (`command` from input), block ⇒ `throw new Error(reason)`; Write|Edit regs → per `editTargets` payload (Review Focus #4); Read reg likewise.
  - `tool.hook("execute.after")` (status completed only): Write|Edit PostToolUse regs; include `tool_response` minimal fields per script reads (verify which fields `validate-assets.sh`/`validate-skill-change.sh` actually parse — grep their stdin usage — and mirror those).
  - `session.hook("context")`: once per sessionID — run SessionStart scripts (`source:"startup"`; `"compact"` if a compaction happened since last run — set flag in the compaction hook), collect `additionalContext`, inject as a synthetic/assistant-visible context entry per the hook contract.
  - `session.hook("compaction")`: run `pre-compact.sh` (`source:"auto"`), never block.
  - event subscribe (names from Step 1): idle → `session-stop.sh` async; permission prompt → `notify.sh` with `{hook_event_name:"Notification", message:...}`.
  - `task` tool before → `log-agent.sh` with `{agent_type: input.subagent_type, agent_id: callID}` + stash prompt; after → stash `lastAssistant` from result, `writeTranscript`, then `log-agent-stop.sh` and `validate-agent-artifact.sh` with `{agent_type, agent_transcript_path: <path>, last_assistant_message}`.
  - All runs wrapped: `parseHookResult`; `skip` decisions logged via `console.log("[ccgs-hooks] script skipped: <name>")`; timeouts from Reg; async ⇒ fire-and-forget.
- [x] **Step 3: Layout fallback check:** if the bare dir doesn't load (log shows no "loading plugin ccgs-hooks"), add `.opencode/plugins/ccgs-hooks/package.json` `{"name":"ccgs-hooks","type":"module","exports":{".":"./index.ts"}}` and re-check.
- [x] **Step 4: Live load:** `opencode-cli.exe reload` (the 2.3.0-x64 desktop CLI; per machine notes) then tail `~/.local/share/opencode/log/opencode.log` → expect `loading plugin` + no load error for ccgs-hooks; if `ToolHooks` names differ from docs, adapt and note in commit message.
- [x] **Step 5: Commit** `"Add ccgs-hooks plugin running studio hooks under Claude contract"`.

### Task 7: Acceptance pass + adapter README

**Files:** Create: `.opencode/README.md`. Read-only: everything else.

**Interfaces:** Consumes: Tasks 1–6 outputs. Produces: documented re-run flow + loss list.

- [x] **Step 1: `.opencode/README.md`** (English, repo language): how to re-run after upstream upgrade (`node .opencode/tools/convert.mjs opencode|agents|commands|agents-md`), losses (statusline, maxTurns, agent memory, skill allowed-tools/model), adapter behavior matrix, troubleshooting (log lines, "hooks are off", layout fallback).
- [x] **Step 2: Auto acceptance:** `node --test` across both test files — all PASS; `git status --porcelain .claude` → empty (spec anti-goal: `.claude/` untouched).
- [x] **Step 3: Live checks (interactive, ask the user to run in the V2 desktop session or drive from a new session here):** (a) `/prototype` autocomplete resolves; (b) new session shows session-state block (session-start additionalContext); (c) `git commit` attempt with staged data JSON blocked with the script's reason — test by staging `design/registry/entities.yaml`-copy scratch and rejecting; (d) `rm -rf x` refused by permission rule; (e) subagent run appears in `production/session-logs/` audit.
- [x] **Step 4: Fix fallout, re-run tests, commit** `"Document OpenCode adapter and acceptance results"`.
