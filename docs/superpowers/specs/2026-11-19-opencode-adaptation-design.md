# Design: адаптация Claude Code Game Studios (CCGS) под OpenCode V2

Дата: 2026-11-19. Статус: на утверждении.

## Intent и why

Репозиторий — шаблон «game studio» на 49 Claude Code субагентах, 78 скиллах, хуках и
bash/python-скриптах валидации. Владелец хочет вести проекты в OpenCode (V2, desktop-сервер
2.3.0, Windows + Git Bash), сохранив **полный паритет**, включая хуки.

## Goals

- Все 49 агентов запускаются как OpenCode-субагенты с теми же ограничениями инструментов.
- Все 78 скиллов доступны (автообнаружение + вызов `/имя` как slash-команда).
- Все 16 хук-регистраций (8 событий) работают через адаптер поверх **существующих** sh-скриптов.
- 130 deny + allow-правила permissions перенесены как правила V2.
- `CLAUDE.md` + `@import`-доки загружаются как контекст.
- Репозиторий продолжает работать в Claude Code без изменений (адаптация аддитивна).

## Non-goals

- Не портим `statusline.sh` (аналога нет; при желании — TUI-плагин позже).
- Не портируем `maxTurns` и `memory: project` из frontmatter агентов (аналогов нет).
- Не переписываем тело скиллов, скрипты `hooks/`/`scripts/`, логику валидаций.
- Не адаптируем `studio-tests/` (харнессы тестов самого фреймворка) под OpenCode.
- Не применяем `allowed-tools`/`model:` из frontmatter скиллов (OpenCode их не поддерживает) —
  см. «Решения владельца».
- Не трогаем `.claude/` — ни одного файла.

## Anti-goals

- Сломать работу репозитория в Claude Code.
- Создать вторую копию логики валидаций на TS (drift с апстримом).
- Потерять блокировки (commit/push guards, write guards) из-за несовпадения контрактов.

## Constraints

- Runtime: Windows 10, Git for Windows (bash на PATH), Python 3 — и так требуются репозиторием.
- **Целевой runtime — OpenCode V2 desktop-сервер (≥2.3.0)**, не старый `opencode` 1.19.4 с PATH:
  V2-формат permissions, `Plugin.define` и compat-скиллы в 1.19.4 молча не работают. Сборка и
  приёмка — в живой V2-сессии; загрузка плагина проверяется по логу сервера
  (`~/.local/share/opencode/log/opencode.log`, строки "loading plugin").
- OpenCode V2: плагин — `Plugin.define` (V2 loader), skills из `.claude/skills` обнаруживаются
  автоматически, permissions — `[{action, resource, effect}]`, `*` — wildcard по всему значению.
- Контракт хуков Claude: stdin — одна строка JSON `{hook_event_name, session_id, cwd, tool_name,
  tool_input, tool_response?, source?, agent_type?, transcript_path}`, env `CLAUDE_PROJECT_DIR`;
  блок — exit 2 + stderr, либо stdout JSON `{"decision":"block","reason":...}`; контекст —
  `hookSpecificOutput.additionalContext`. Скрипты сами разрешают корень (project.yaml → .claude/ →
  CLAUDE_PROJECT_DIR → своё расположение).

## Approaches (выбран 1)

1. **Адаптер поверх скриптов (выбран).** Один TS-плагин воспроизводит контракт Claude-хуков и
   гоняет существующие `bash .claude/hooks/*.sh`. Единая копия логики; апстрим-обновления
   подхватываются. Цена: слой маппинга и зависимость от Git Bash (уже есть).
2. Нативный порт 17 скриптов на TS — вторая копия валидаций, дни работы, drift. Отклонён.
3. Каркас без хуков — противоречит требованию полного паритета. Отклонён.

## Решения (как строим)

### A. Макет — аддитивный overlay

```
AGENTS.md                      # из CLAUDE.md без @import-строк, правится вручную
opencode.json                  # schema, instructions, permissions
.opencode/agents/*.md          # 49 конвертированных агентов
.opencode/commands/<id>.md     # 78 шима-команд -> вызов скилла с $ARGUMENTS
.opencode/plugins/ccgs-hooks/index.ts  # адаптер хуков (без package.json — грузится по имени index.ts)
.opencode/tools/convert.mjs    # генераторы агентов/команд/permissions; повтор на апстрим-обновление
```

`.claude/skills/` — без изменений, OpenCode сам их находит (compat-путь). Пути внутри скиллов
(`.claude/scripts/...`) остаются валидными, т.к. содержимое не перемещается.

### B. AGENTS.md + instructions

`AGENTS.md` — тело `CLAUDE.md` без `@...`-строк; вместо импортов в `opencode.json`:
`"instructions": [".claude/docs/directory-structure.md", ".claude/docs/coordination-rules.md", ".claude/docs/coding-standards.md"]`.
Вложенные `design/CLAUDE.md`, `docs/CLAUDE.md` в контекст по умолчанию не грузим (токен-стоимость);
скиллы и хук session-start на них ссылаются по пути — проверить, что инструкции доходят, при smoke-тесте.

### C. Конвертация агентов (49 файлов, детерминированный генератор)

Frontmatter Claude → V2 (`mode: subagent`, `description`):
- `model: inherit` → поле не пишем (subagent наследует модель сессии).
- `tools: Read, Glob, Grep, Write, Edit, WebSearch` → permissions: для каждого встроенного
  действия (`read, edit, glob, grep, shell, webfetch, websearch, skill, subagent, question`) —
  `allow` если оно в allow-list, иначе `deny` (иначе OpenCode уйдёт в `ask` в субагенте).
  Маппинг имён: Read→read, Write/Edit→edit, Glob→glob, Grep→grep, Bash→shell, WebSearch→webfetch+websearch.
- `disallowedTools: Bash` → доп. `deny` для shell.
- `skills: [balance-check]` → per-agent `skill`-правила: allow перечисленных, deny `*` после.
- `maxTurns`, `memory` → отбрасываются (осознанная потеря).
Тело промпта агента переносится дословно.

### D. Адаптер хуков `.opencode/plugins/ccgs-hooks`

Плагин **читает `.claude/settings.json`** (hooks: matcher'ы, списки скриптов, timeouts) — конфиг
один, синхронизируется с апстримом сам; из `command`-строки извлекается путь скрипта.

Маппинг событий OpenCode → скриптов:

| Claude-событие | Механизм V2 | Что передаём | Блок |
|---|---|---|---|
| SessionStart (session-start.sh, detect-gaps.sh) | `session.hook("context")`, кэш на сессию, `source: startup\|clear\|compact` | JSON stdin | вывод `additionalContext` → синтетическое сообщение / инъекция в контекст |
| PreToolUse `Bash\|PowerShell` | `tool.hook("execute.before")`, tool `bash` | `{tool_name:"Bash", tool_input:{command}}` | throw(reason) |
| PreToolUse `Write\|Edit` | `execute.before`, tools `write`/`edit`/`patch` | `{tool_name:"Write"/"Edit", tool_input:{file_path, content / old_string,new_string}}` из `input.filePath` | throw(reason) |
| PreToolUse `Read` | `execute.before`, tool `read` | `{tool_name:"Read", tool_input:{file_path}}` | throw(reason) |
| PostToolUse `Write\|Edit` | `execute.after` (status completed) | + `tool_response` (минимальный набор полей, которые реально читают скрипты) | фидбек моделью |
| Notification | `event.subscribe` на permission/session события | `{hook_event_name:"Notification", message}` | — |
| PreCompact | `session.hook("compaction")` | `{source:"auto"}` | — |
| Stop (async) | событие idle сессии | `{hook_event_name:"Stop"}` | — |
| SubagentStart/Stop | `execute.before/after` инструмента `task` + **transcript-мост** | `{agent_type: input.subagent_type, agent_id: callID}`; Stop дополнительно: `agent_transcript_path`, `last_assistant_message` | — |

**Transcript-мост** (обязателен для критерия 5): `validate-agent-artifact.sh` читает
`agent_transcript_path` — JSONL-транскрипт Claude, чьё первое user-сообщение содержит путь
артефакта; `log-agent-stop.sh` читает `last_assistant_message`. Мост: на `execute.before`
инструмента `task` сохраняем prompt субагента, на `execute.after` — финальный результат, пишем
минимальный JSONL (`{type:"user",message:{content:<prompt>}}`, `{type:"assistant",...}`) в
`.opencode/state/agent-transcripts/<callID>.jsonl` (gitignored) и передаём путь в stdin-JSON.

Общее: spawn `bash <script>` c cwd = directory локации, env `CLAUDE_PROJECT_DIR`, timeout из
settings.json; exit 2 → reject с stderr (модель видит причину); stdout JSON парсируется по схеме
Claude (`decision`, `additionalContext`, `systemMessage`). Нет bash — лог-предупреждение «hooks
are off», как в Claude-обёртке. `async:true` timeout не ждёт.

Открытые точки (проверяются на этапе плана, не решают архитектуру): точные имена событий session
idle / permission в V2 event bus; какие поля `tool_response` реально читают validate-assets.sh и
validate-skill-change.sh; `patch`-инструмент как источник edit-событий; layout голого каталога
плагина без package.json (доки неоднозначны) — fallback: `package.json` с name/exports, проверится
первым же прогоном.

### E. Permissions → opencode.json

Генератор переносит `settings.json.permissions` один-к-одному:
`Bash(X)`/`PowerShell(X)` → `{action:"shell", resource:X}`; `Read(X)` → read; `Edit(X)` → edit;
allow-список первыми, deny после (last match wins совпадает по смыслу). Wildcards совместимы
(`*` через `/`). Отдельные правила `.uasset/.umap/env` → read/edit.

### F. Команды-шимы (78)

`.opencode/commands/<skill-id>.md`: тело — «загрузи скилл `<id>` инструментом skill и выполни с
аргументами: $ARGUMENTS». Даёт UX-паритет `/prototype ...`.

## Решения владельца (после builder-check)

- **`allowed-tools`/`model:` во frontmatter скиллов**: НЕ-GOAL, документировано. OpenCode их не
  интерпретирует — скиллы работают с правами вызвавшего агента; основной слой guards
  (hooks-адаптер + permissions) на месте. Мост принуждения сознательно не строим.
- **`model: opus|sonnet` у агентов и скиллов**: INHERIT — модель в генерируемых агентах не
  пишется, все едут на модели текущей сессии. Устойчиво к апстрим-обновлениям.

## Что остаётся билдеру

- Точная реализация кэша session-start (один запуск на сессию, сброс на clear/compact).
- Формат логов adapter'а (куда писать диагностику: stderr сервера vs файл).
- Обработка коллизий имён команд/агентов с глобальным конфигом пользователя.
- Скрипт-генератор: ESM .mjs без зависимостей (только node stdlib).

## Verification (критерий приёмки)

1. В живой V2 desktop-сессии в корне репо: 49 агентов и 78 скиллов видны; `/prototype
   --help`-подобный выхлоп команды работает; плагин отмечен загруженным в логе сервера.
2. Сессия стартует с блоком session-state (additionalContext из session-start.sh).
3. `git commit` со staged data-JSON без валидации блокируется валидной причиной (exit 2 доходит до модели).
4. Запись в `.env` и `rm -rf` denied правилами permissions.
5. Субагент логируется log-agent.sh; write-guard на артефакт агента отвалидирован.
6. Тот же репозиторий в Claude Code ведёт себя как раньше (`.claude/` не тронут).
