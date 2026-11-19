<p align="center">
  <h1 align="center">OpenCode Game Studios</h1>
  <p align="center">
    A full game-dev studio for <strong>OpenCode</strong>: describe a game, get
    questions, a brief, and a playable build — then grow it, finish it, and keep
    the whole studio hierarchy of agents, skills and guards around it.
    <br />
    A public fork of <a href="https://github.com/Donchitos/Claude-Code-Game-Studios">Claude Code Game Studios</a>,
    adapted to OpenCode V2 with full hook parity. The same checkout still works
    in Claude Code.
  </p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://opencode.ai/docs"><img src="https://img.shields.io/badge/works%20with-OpenCode%20V2-black" alt="Works with OpenCode V2"></a>
  <a href="https://github.com/Donchitos/Claude-Code-Game-Studios"><img src="https://img.shields.io/badge/fork%20of-Claude%20Code%20Game%20Studios-f5f5f5?logo=anthropic" alt="Fork of Claude Code Game Studios"></a>
  <a href="https://www.buymeacoffee.com/donchitos3"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Support%20the%20original-FFDD00?logo=buymeacoffee&logoColor=black" alt="Buy Me a Coffee"></a>
  <a href="https://github.com/sponsors/Donchitos"><img src="https://img.shields.io/badge/GitHub%20Sponsors-Support%20the%20original-ea4aaa?logo=githubsponsors&logoColor=white" alt="GitHub Sponsors"></a>
</p>

---

## Make me a game

Open OpenCode in a copy of this repository and say what you want:

```
/prototype a fishing game where the rare fish only bite at dusk
```

1. **A few questions.** One round, picked from the genre: the choices that
   shape the game — feel, look, difficulty, goal. Each has a usual answer, so
   "you pick" works.
2. **A one-page brief.** `design/game-brief.md`, in your words. You read it and
   say *Build it*, or change something first.
3. **A first build.** A browser game in `prototypes/<name>/` that opens with a
   double-click: every figure drawn, no emoji art, no copy of another game.
4. **Checked before you get it.** Scripted key presses in a headless browser
   prove it opens and responds; a handover card marks every line of the brief
   built, missing or broken — and says "Not yet played by a person".

Then: change it by asking, share it, grow it into a real web project
(Vite/TypeScript), or run `/cut` for a plan to finish. The full workflow pitch,
studio mode and philosophy live in the
[original README](https://github.com/Donchitos/Claude-Code-Game-Studios#readme) —
everything there works the same here except where this file says otherwise.

## Getting Started

### Prerequisites

- [Git](https://git-scm.com/)
- [OpenCode](https://opencode.ai) — desktop app or CLI, **V2 (2.3+)**. The
  adaptation (plugin, `opencode.json`, agents/commands) needs the V2 runtime;
  OpenCode 1.x will not load it. Claude Code also still works on this checkout.
- [Python 3](https://www.python.org/) — reads `project.yaml` for every skill
  and hook; without it every setting silently falls back to its default
- **Bash ≥ 4** — every studio hook is a bash script; the adapter runs them
  through it. Built into macOS and Linux; on Windows use
  [Git for Windows](https://git-scm.com/downloads/win) — the adapter finds Git
  Bash on its own even when `Git\bin\bash.exe` is not on PATH (MSYS/MinGW bash
  3.1 is rejected). Without bash the adapter logs one "hooks are off" line and
  lets tool calls through unvalidated
- **Chrome, Edge or Chromium** — `/prototype` plays and screenshots each game
  in it; without one, those checks say they were not assessed
- **Recommended**: [Node.js](https://nodejs.org/) (web projects, the
  generators and their tests) and [jq](https://jqlang.github.io/jq/) (hook
  validation)

Hooks fail gracefully when optional tools are missing — you lose validation,
nothing else — with one deliberate exception: a commit staging data JSON is
blocked when there is no Python to validate it.

### Setup

1. **Clone**:

   ```bash
   git clone https://github.com/s1gurd/OpenCode-Game-Studios.git my-game
   cd my-game
   ```

2. **Open an OpenCode session in the repository root** (the folder holding
   `opencode.json`, `AGENTS.md` and `project.yaml`) — desktop app or
   `opencode` in a terminal. Everything loads by itself: root instructions,
   the 78 skills and matching slash commands, 49 studio subagents, permission
   rules, and the `ccgs-hooks` plugin that runs all 15 upstream hook scripts.

   Starting OpenCode in a subfolder such as `src/` skips the plugin, deny
   rules and generated instructions — always open the root.

   Verify the hook layer loaded (optional): the plugin writes to
   `.opencode/state/ccgs-hooks.log`; a session should show a line like
   `loaded: 15 registrations, bash=...` and context injections from
   `session-start.sh`.

3. **Type `/prototype` and your idea**, or run `/start`, which asks where you
   are and routes you to the right workflow.

   Other ways in:
   - `/next-step` — names the one next step wherever you are
   - `/brainstorm` — explore game ideas from scratch
   - `/setup-engine godot 4.7` — configure an engine up front
   - `/project-stage-detect` — analyze an existing project

   In OpenCode, skills also load by name through the skill tool — the slash
   commands are shims that do exactly that.

## What is different from the upstream project

OpenCode loads everything natively except one piece: hooks. V2 has a plugin
system instead of Claude's hook scripts, so this fork adds
`.opencode/plugins/ccgs-hooks/` — an adapter that reads `.claude/settings.json`
itself and runs the same `.claude/hooks/*.sh` scripts under the original
stdin/exit-code contract, at the same events, with the same blocking behavior
(commit validation, push deny, data-file checks, subagent audit). Verified live:
malformed data JSON commits are blocked, denied commands (`rm -rf`,
`Remove-Item -Recurse`, `.env` reads) are refused inside subagents too, and
session context is injected at start and after compaction.

Also generated for V2: `opencode.json` (instructions + 162 permission rules
from upstream settings), `AGENTS.md`, 49 agent files, 78 command shims.
Nothing under `.claude/` is modified — Claude Code users lose nothing.

Known losses: `statusline.sh`, agent `maxTurns`/`memory:`, skill-level
`allowed-tools`/`model:` enforcement, Claude model aliases; details and
troubleshooting in [.opencode/README.md](.opencode/README.md).

## Keeping up with upstream

```bash
git fetch upstream   # github.com/Donchitos/Claude-Code-Game-Studios
git merge upstream/main
node .opencode/tools/convert.mjs all   # regenerate opencode.json, AGENTS.md, agents, commands
node --test .opencode/tools/convert.test.mjs .opencode/plugins/ccgs-hooks/contract.test.mjs
```

The adapter reads `.claude/settings.json` at load time, so upstream hook
changes apply without regenerating anything; permissions, agents and commands
are generated files — review `git diff` after regenerating, then reload
OpenCode.

## Engines

Unchanged from upstream: web (default), Godot 4, Unity, Unreal 5 —
`/setup-engine` pins the version; the code root comes from the engine table
(`.claude/engines/engines.tsv`). Details in the
[original README](https://github.com/Donchitos/Claude-Code-Game-Studios#engines).

## Community

Upstream community (discussions, issues, roadmap) lives in
[Donchitos/Claude-Code-Game-Studios](https://github.com/Donchitos/Claude-Code-Game-Studios);
OpenCode-port issues can go to this repo's issues.

## License

MIT — same as the original [Claude Code Game Studios](https://github.com/Donchitos/Claude-Code-Game-Studios)
by Donchitos; see [LICENSE](LICENSE). The original's full documentation
(studio hierarchy, hooks and permissions, design philosophy, customization)
remains the reference:
[original README](https://github.com/Donchitos/Claude-Code-Game-Studios#readme).
