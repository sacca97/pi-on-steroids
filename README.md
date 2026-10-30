<div align="center">

# pi-on-steroids

[![npm version](https://img.shields.io/npm/v/pi-on-steroids?style=for-the-badge)](https://www.npmjs.com/package/pi-on-steroids)
[![License](https://img.shields.io/github/license/sacca97/pi-on-steroids?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()

An all-in-one extension for the [Pi coding agent](https://github.com/mariozechner/pi). Configure everything with `/steroids`.

`pi-on-steroids` keeps tool calls compact (optionally grouped into one line per run), shows only the final assistant reply if you want, adds richer diff rendering, runs long bash commands in the background, gives you a `/btw` side chat, a `/goal` mode that keeps the agent working until an objective is done, and brief compactions backed by searchable session history. Each feature is opt-in and independent.

Background tasks and `/btw` are modelled on [pi-patty-bg-tasks](https://github.com/patty-io/pi-patty-bg-tasks) and [pi-btw](https://github.com/dbachelder/pi-btw).

</div>

## Features

- **Compact built-in tool rendering** for `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`
- **Adaptive edit/write diffs** with split or unified layouts, syntax highlighting, inline emphasis, and narrow-pane width clamping
- **Workspace-scoped projected pending edit/write previews** that show `pending edit`, `pending overwrite`, and `pending create` diffs while partial tool calls are still streaming
- **Progressive collapsed diff hints** that shorten automatically on small terminal widths instead of overflowing
- **Hashline-anchor diff gutters** that preserve `LINE#HASH` labels from anchored read/edit output when those lines are rendered in diffs
- **Grouped tool calls** (`groupToolCalls`) that collapse each run of tool calls into one line like `✓ 7 tools · 3 read · 2 bash · 2 edit`; Ctrl+O expands them
- **Hidden assistant commentary** (`hideAssistantCommentary`) so only the final reply is shown, like Claude Code
- **Background tasks** (`backgroundTasks`): `bash` commands move to the background after `backgroundAutoSeconds` (default 120) or on demand, with `bash_bg` and `jobs` tools, completion notifications, a status-bar count, `/bg`, `/bg-list`, Ctrl+Shift+B (background) and Ctrl+Shift+X (kill latest)
- **Side chat** (`btwSideChat`): `/btw` opens a streaming overlay in the same square Zellij frame and dark-grey surface as the `/steroids` settings window, with a Codex/OpenCode-style prompt, backed by a separate in-memory session. Side sessions are **read-only** (`read`, `grep`, `find`, `ls`) and inherit main-session context while the main agent keeps working. Press `Esc` to close/cancel the overlay; `Enter` sends a follow-up. Also available: `/btw:new` (fresh thread), `/btw:clear` and `/btw:inject` (hand the thread to the main agent)
- **Goal mode** (`goalMode`): `/goal <objective>` keeps the agent working turn after turn until it verifies completion (`update_goal complete`) or reports a blocker; `/goal`, `/goal pause`, `/goal resume`, `/goal clear` control it. The goal lives in the session, shows in the footer, pauses on interrupt or after 50 turns. Needs Pi 0.80.4 or newer
- **Compaction history** (`compactionHistory`): compaction summaries stay brief and end with a pointer to the full earlier conversation, which Pi keeps in the session file. The agent retrieves it on demand with `history_search` (keywords over past messages and tool calls; tool outcomes shown as `SUCCESS`/`FAILURE`/`UNKNOWN`, raw output only when asked) and `history_read` (the conversation around an entry id). If the brief summary fails, Pi's default compaction runs instead
- **Display profiles**: `hidden`, `balanced`, `verbose`, plus your own saved `custom-A`, `custom-B`, …
- **Thinking labels** during streaming and final message rendering, with context sanitization to avoid leaking presentation labels back into future model turns
- **Optional native user message box** with markdown-aware rendering and safer ANSI/background handling

## Installation

### Local extension folder

Place this folder in one of Pi's auto-discovery locations:

```text
# Global default (when PI_CODING_AGENT_DIR is unset)
~/.pi/agent/extensions/pi-on-steroids

# Project-specific
.pi/extensions/pi-on-steroids
```

### npm package

```bash
pi install npm:pi-on-steroids
```

### Git repository

```bash
pi install git:github.com/sacca97/pi-on-steroids
```

## Usage

### Interactive settings

```text
/steroids
```

Opens a settings window with a description pane and two sections:

- **Display**: cycle the display profile with Enter, and save the current display settings as a new custom profile or update the active one.
- **Features**: turn background tasks, the `/btw` side chat, goal mode and compaction history on or off (applies after `/reload`).

Type to search, `/` toggles advanced notes, Esc closes. Deleting a profile and everything else is done with `/steroids delete <name>` or in `config.json`.

### Direct commands

```text
/steroids show                # Active profile and feature toggles
/steroids list                # Available profiles
/steroids profile <name>      # Switch display profile
/steroids save [name]         # Save current display settings (default name: next free custom-A, custom-B, ...)
/steroids delete <name>       # Delete a custom profile
/steroids reset               # Back to the hidden profile
```

## Source layout

Each feature lives in `src/features/<name>`: `tool-rendering`, `tool-grouping`, `bg-tasks`, `btw`, `goal`, `compaction-history`, `thinking-label` and `user-message-box`. Shared config, profiles and the settings window stay in `src/`.

## Display profiles

A profile is a named set of **display** settings: output modes, previews, diff rendering, tool-call grouping, hidden commentary and the user message box. Switching profile never changes the feature toggles (background tasks, `/btw`, goal mode, compaction history).

| Profile | Read | Search | Bash | Preview lines | Bash lines | Grouped calls + hidden commentary |
|---------|------|--------|------|---------------|------------|-----------------------------------|
| `hidden` (default) | hidden | hidden | opencode | 8 | 10 | yes |
| `balanced` | summary | count | summary | 8 | 10 | no |
| `verbose` | preview | preview | preview | 12 | 20 | no |

- **`hidden`**: tool runs collapse to one summary line and only the final assistant reply is shown
- **`balanced`**: compact summaries with line counts and match totals
- **`verbose`**: larger previews for read/search/bash output

Custom profiles are saved in `config.json` under `customProfiles`. If you change a display setting by hand, `/steroids show` reports the profile as `modified` until you save it.

### Bash Output Modes

| Mode | Behavior |
|------|----------|
| `opencode` | Classic collapsed output using `bashCollapsedLines` limit with expansion hint |
| `summary` | Shows only line count (e.g., "↳ 3 lines returned") — no output displayed |
| `preview` | Shows actual output lines using `previewLines` limit |

## Configuration

Runtime configuration is stored at:

```text
Default global path: ~/.pi/agent/extensions/pi-on-steroids/config.json
Actual global path: $PI_CODING_AGENT_DIR/extensions/pi-on-steroids/config.json when PI_CODING_AGENT_DIR is set
```

A starter template is included at `config/config.example.json`.

### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for the whole extension |
| `profile` | string | `"hidden"` | Active display profile (built-in or a key of `customProfiles`) |
| `customProfiles` | object | `{}` | Saved display profiles, `{ "custom-A": { ...display settings } }` |
| `backgroundTasks` | boolean | `false` | Background bash tasks (applies after `/reload`) |
| `backgroundAutoSeconds` | number | `120` | Seconds before a running bash command moves to the background; `0` disables |
| `btwSideChat` | boolean | `false` | `/btw` side chat (applies after `/reload`) |
| `goalMode` | boolean | `false` | `/goal` mode with `get_goal` / `update_goal` (applies after `/reload`; needs Pi 0.80.4+) |
| `compactionHistory` | boolean | `false` | Brief compaction summaries plus `history_search` / `history_read` (applies after `/reload`) |
| `groupToolCalls` | boolean | `true` | Collapse each run of tool calls into one summary line |
| `hideAssistantCommentary` | boolean | `true` | Show only the final assistant reply |
| `enableNativeUserMessageBox` | boolean | `true` | Enable bordered user prompt rendering |
| `readOutputMode` | string | `"hidden"` | `hidden`, `summary`, or `preview` |
| `searchOutputMode` | string | `"hidden"` | `hidden`, `count`, or `preview` |
| `previewLines` | number | `8` | Lines shown in collapsed preview mode |
| `expandedPreviewMaxLines` | number | `4000` | Max preview lines when fully expanded |
| `bashOutputMode` | string | `"opencode"` | `opencode` (collapse), `summary` (line count), or `preview` (show lines) |
| `bashCollapsedLines` | number | `10` | Lines shown for collapsed bash output (opencode mode) |
| `diffViewMode` | string | `"auto"` | `auto`, `split`, or `unified` |
| `diffIndicatorMode` | string | `"bars"` | `bars` (vertical indicators), `classic` (+/- markers), or `none` |
| `diffSplitMinWidth` | number | `120` | Minimum width before auto mode prefers split diffs |
| `diffCollapsedLines` | number | `24` | Diff lines shown before collapsing |
| `diffWordWrap` | boolean | `true` | Wrap long diff lines when needed |
| `showTruncationHints` | boolean | `false` | Show truncation indicators for compacted output |

### Example config

`config/config.example.json` holds every option at its default:

```json
{
  "enabled": true,
  "profile": "hidden",
  "customProfiles": {},
  "enableNativeUserMessageBox": true,
  "groupToolCalls": true,
  "hideAssistantCommentary": true,
  "backgroundTasks": false,
  "btwSideChat": false,
  "goalMode": false,
  "compactionHistory": false,
  "backgroundAutoSeconds": 120,
  "readOutputMode": "hidden",
  "searchOutputMode": "hidden",
  "previewLines": 8,
  "expandedPreviewMaxLines": 4000,
  "bashOutputMode": "opencode",
  "bashCollapsedLines": 10,
  "diffViewMode": "auto",
  "diffIndicatorMode": "bars",
  "diffSplitMinWidth": 120,
  "diffCollapsedLines": 24,
  "diffWordWrap": true,
  "showTruncationHints": false
}
```

## Rendering notes

### Edit and write diffs

`edit` and `write` results use the same diff renderer. In `auto` mode the extension chooses split or unified layout based on available width. On narrow panes it clamps rendered lines and shortens collapsed hint text so the diff stays readable instead of spilling past the terminal width.

While tool arguments are still streaming, partial `edit` and `write` calls can show projected pending previews. Deterministic edits render as `pending edit` diffs against current file contents, writes render as `pending overwrite` or `pending create`, and unresolved projections show a clear preview notice instead of guessing. Preview file reads are scoped to the active workspace so pending previews avoid reading paths outside the current project.

When diff input includes Pi anchored read lines such as `12#AB:content`, the renderer treats the anchor as line metadata and displays the `LINE#HASH` label in the gutter while keeping the content aligned for split, unified, and compact diff layouts.

### Write summaries

When content is available, `write` call summaries include line count and byte size information inline so you can quickly see the size of the pending write before expanding the result.

### Thinking labels

Thinking blocks are labeled during streaming and on final messages. Before the next model turn, the extension sanitizes those presentation labels out of the stored assistant context so they do not accumulate or pollute future prompts.

### Native user message box

When enabled, user prompts render inside a bordered box using Pi's native user message component. The renderer preserves markdown content more safely and normalizes ANSI/background handling to avoid odd nested background artifacts.

## Troubleshooting

### Reload safety

`/reload` is fully supported. On reload, the extension cleans up all tool overrides, prototype patches, timers, and event handlers through its built-in disposal registry, then re-registers everything on the next session lifecycle event. No manual cleanup is needed.

### Config not loading

If your settings are not being applied:

1. Check that the global pi-on-steroids config exists (default: `~/.pi/agent/extensions/pi-on-steroids/config.json`, respects `PI_CODING_AGENT_DIR`)
2. Make sure the JSON is valid
3. Run `/steroids show` to inspect the effective config summary

## Project structure

```text
pi-on-steroids/
├── index.ts                         # Extension entrypoint for Pi auto-discovery
├── src/
│   ├── index.ts                     # Bootstrap: registers every feature and /steroids
│   ├── steroids-command.ts          # /steroids command and subcommands
│   ├── steroids-settings.ts         # Settings window items (Display / Features)
│   ├── settings-inspector-modal.ts  # Split-pane settings window with categories
│   ├── zellij-modal.ts              # Modal UI primitives
│   ├── config-store.ts              # Config load/save and normalization
│   ├── profiles.ts                  # Built-in and custom display profiles
│   ├── types.ts                     # Shared config and type definitions
│   └── features/
│       ├── tool-rendering/          # Compact tool rendering and diffs
│       ├── tool-grouping/           # Grouped tool-call summary and hidden commentary
│       ├── bg-tasks/                # Background jobs, bash_bg, jobs, notifications
│       ├── btw/                     # /btw side chat session and overlay
│       ├── goal/                    # /goal mode and goal tools
│       ├── compaction-history/      # Brief compaction summaries and history tools
│       ├── thinking-label/          # Thinking label formatting and context sanitization
│       └── user-message-box/        # Native user message box renderer
├── config/
│   └── config.example.json          # Starter config template
└── tests/                           # node:test suites, one file per area
```

## Development

```bash
# Type check
npm run build

# Run tests
npm run test

# Full verification
npm run check
```

## License

[MIT](LICENSE)
