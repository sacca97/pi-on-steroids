# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-29

Initial release.

### Added
- Compact rendering for the built-in `read`, `grep`, `find`, `ls`, `bash`, `edit` and `write` tools, with split or unified edit/write diffs, syntax highlighting, pending edit previews while tool calls stream, and width-safe output on narrow terminals.
- Display profiles: `hidden` (default), `balanced`, `verbose`, plus saved custom profiles (`custom-A`, `custom-B`, …). `/steroids` opens the settings window with Display and Features categories, plus `show`, `list`, `profile`, `save`, `delete` and `reset` subcommands.
- `groupToolCalls` collapses each run of tool calls into one summary line (Ctrl+O expands) and `hideAssistantCommentary` shows only the final assistant reply.
- Opt-in `backgroundTasks`: bash commands move to the background after `backgroundAutoSeconds` or on demand, with `run_in_background`, the `bash_bg` and `jobs` tools, completion notifications, a status-bar count, `/bg`, `/bg-list` and Ctrl+Shift+B / Ctrl+Shift+X. Killed jobs get a SIGTERM grace period before SIGKILL, and logs live in a private temporary directory.
- Opt-in `btwSideChat` (`/btw`, `/btw:new`, `/btw:clear`, `/btw:inject`): read-only side questions answered by a separate session in a streaming overlay while the main agent keeps working.
- Opt-in `goalMode` (`/goal`, `get_goal`, `update_goal`): a persistent per-session goal the agent keeps pursuing via hidden continuation turns, with footer status, pause/resume/clear, interrupt handling and a 50-turn cap. Needs Pi 0.80.4 or newer.
- Opt-in `compactionHistory`: brief compaction summaries that point to the full earlier conversation, retrievable on demand with the `history_search` and `history_read` tools.
- Thinking labels during streaming and in final messages, and an optional native user message box.
- Config in `extensions/pi-on-steroids/config.json` (respects `PI_CODING_AGENT_DIR`).
