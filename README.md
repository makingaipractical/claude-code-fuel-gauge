# Claude Code Fuel Gauge

Claude Code Fuel Gauge shows you how much context runway you have in your current session, even when you are running multiple sessions at a time.

In Claude Code's VS Code extension, you don't see context usage until it warns you. Fuel Gauge puts a live percentage in your status bar, color-coded green → yellow → red, so you see it coming.

Works in VS Code, Antigravity, and other VS Code forks.

As of v0.6, Fuel Gauge also shows a **cache countdown** in a second status bar item. Claude Code caches your prompt prefix so subsequent messages are cheaper and faster — but the cache expires (5 minutes for Pro/API, 1 hour for Max main agent). When that window closes, your next message rebuilds the cache and pays the full base-input price plus a 1.25× or 2× cache-write premium on the rebuild. The countdown tells you exactly how much time you have left before that happens.

<p align="center">
  <img src="images/status-active.png" width="350" alt="Claude Code Fuel Gauge showing 14% context usage in green, alongside a 2:42 cache countdown in green">
</p>

## Why Fuel Gauge

- **You see it coming.** No more surprise "context low" warnings. You see the percentage climbing and can plan your exit before quality drops.
- **Stay in the flow.** No command to type, no window to open. Glance at the status bar, keep working.
- **Session planning.** At 60%, you know you can fit one more big task. At 80%, you know to wrap up. Context becomes a resource you manage, not a cliff you fall off.
- You stop needing the `/context` command in Claude Code.
- You can disable `/autocompact` and manage your own context because you can see it.

### Why not just use `/context`?

Fuel Gauge calculates usage from both input and output tokens, and compensates for system token overhead that Claude Code doesn't expose in its statusline data. Claude Code's `/context` command and its statusline `used_percentage` only count input tokens and exclude system overhead, so they can report free space when you're effectively at the limit. With the right `systemOverhead` setting, Fuel Gauge's percentage closely tracks the "Context low" warning that Claude Code shows in the terminal.

## Display states

### Context percentage

- **Active** — colored percentage (green/yellow/red based on thresholds)
- **Stale** — percentage with a circle-slash icon, no color (no bridge update for >1 hour — genuinely abandoned session)
- **No session** — 0%, no color

<p align="center">
  <img src="images/status-states.png" width="350" alt="Fuel Gauge display states — red critical, green active, yellow warning, grey inactive">
</p>

### Cache countdown (since v0.6)

- **Counting down** — `M:SS` format, color inherits from the context percentage
- **Warming (<60s)** — yellow
- **Expiring (<15s)** — red
- **Expired** — `expired` label in red with a circle-slash icon
- **Hidden** — when no cache state is available yet (fresh session, just after `/compact`, etc.)

## Install

Search for **Claude Code Fuel Gauge** in the VS Code Extensions panel, or install from the command line:

```bash
code --install-extension makingaipractical.claude-code-fuel-gauge
```

For VS Code forks like Antigravity, download the `.vsix` from the [Releases page](https://github.com/makingaipractical/claude-code-fuel-gauge/releases) and install via the extensions panel (three dots > "Install from VSIX").

Restart any running Claude Code sessions after installing. The extension sets up everything automatically.

## How it works

Claude Code has a [statusline feature](https://code.claude.com/docs/en/statusline) that exposes context window data as JSON. Fuel Gauge uses this in two parts:

1. **Bridge script** — automatically installed on first activation. Claude Code pipes context data to this script, which writes a JSON file per session to `~/.claude/fuel-gauge/`.

2. **Extension** — polls that directory every 15 seconds, finds the session matching your current workspace, and displays the percentage in the status bar.

Each VS Code window shows the context for its own workspace. Multiple concurrent Claude Code sessions are supported — one per project directory.

The cache countdown auto-detects your plan's TTL by observing whether the cache survives a >5-minute idle gap. Once detected, the TTL persists for that session; new sessions re-detect from scratch.

## Requirements

- VS Code 1.93+ (or compatible fork)
- Claude Code CLI (works with both 200k and 1M token context windows)
- Python 3 (used by the bridge script to parse JSON)

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `fuel-gauge.pollInterval` | 15 | How often to check for updates (seconds) |
| `fuel-gauge.warningThreshold` | 60 | % at which indicator turns yellow |
| `fuel-gauge.dangerThreshold` | 80 | % at which indicator turns red |
| `fuel-gauge.systemOverhead` | 18000 | Estimated system token overhead (invisible to statusline). Increase if Fuel Gauge underreports vs Claude's "Context low" warning |
| `fuel-gauge.cacheTTL` | `null` (auto) | Prompt-cache TTL in seconds. Leave null to auto-detect from observed cache behavior. Common: `300` (5 min, Pro/API), `3600` (1 hour, Max) |

## Known issues

**Accuracy depends on system overhead.** Claude Code uses hidden tokens (system prompt, tool definitions, MCP configs, CLAUDE.md) that aren't reported in statusline data. Fuel Gauge compensates with a configurable `systemOverhead` setting (default 18,000 tokens). If your percentage consistently underreports compared to Claude's "Context low" warning, increase this value. In practice, the default overhead is quite accurate.

**Status bar stops updating on macOS.** Claude Code has an upstream bug ([#32660](https://github.com/anthropics/claude-code/issues/32660)) where the statusline command can silently stop firing on macOS. When this happens (sometimes after "/resume", but not always), Fuel Gauge shows a stale percentage or stays at 0%. Restarting the Claude Code session usually fixes it. No workaround exists at this time.

**WSL + VS Code extension: statusLine hook doesn't fire.** When running Claude Code through the VS Code extension on WSL, the statusLine hook may never trigger, leaving Fuel Gauge stuck at 0%. This also affects the Stop hook. A workaround is available — see [WSL fallback](#wsl-fallback-transcript-watcher) below.

## WSL Fallback: Transcript Watcher

When the statusLine hook doesn't fire (WSL, some VS Code extension setups), you can use the bundled transcript watcher as a fallback. It monitors Claude Code's transcript files via Linux `inotify` and writes session data in the same format as the standard bridge script — Fuel Gauge picks it up with no other changes.

### Requirements

- Linux with inotify support (WSL2, native Linux)
- Python 3.7+ (stdlib only, no pip packages)
- `systemctl --user` support

### Install

```bash
# One-command install as a systemd user service
python3 wsl/context-watcher.py --install
```

### Verify

```bash
python3 wsl/context-watcher.py --status
```

### How it works

```
inotify watches ~/.claude/projects/*/
  → transcript .jsonl modified
  → extract last assistant usage
  → compute percentage (respects systemOverhead from config.json)
  → write ~/.claude/fuel-gauge/{session_id}.json
  → Fuel Gauge extension polls the directory → updates status bar
```

- **Per-session**: each session gets its own JSON file, matching by `project_dir`
- **Event-driven**: uses kernel inotify, not polling (zero CPU when idle)
- **Debounced**: 2-second minimum interval per file to avoid redundant processing
- **No dependencies**: pure Python 3 stdlib (ctypes for inotify)

### Uninstall

```bash
python3 wsl/context-watcher.py --uninstall
```

**Workspace matching.** The status bar shows context for the Claude Code session whose project directory matches the VS Code workspace folder. If you run Claude Code from a different directory than the one open in VS Code, Fuel Gauge won't pick it up. This is by design — the status bar belongs to the workspace.

**Icon differences across editors.** In VS Code, the status bar shows a Claude icon alongside a dashboard gauge. In forks like Antigravity that don't include newer codicons, only the gauge appears. Functionality is identical.

## Privacy

No API calls, no telemetry, no runtime dependencies. Everything runs locally using Claude Code's own statusline data.

## Not affiliated with Anthropic

This is a community tool. Not made by, endorsed by, or affiliated with Anthropic.

## Version History

**v0.6.1** — Adds a prompt-cache countdown in a second status bar item. Shows time remaining until cache expiry in `M:SS`, color-coded for urgency (yellow under 60s, red under 15s). Auto-detects 5-minute vs 1-hour TTL from observed cache behavior; `fuel-gauge.cacheTTL` setting overrides if you want to skip detection.

**v0.5.0** — Renamed from BrainDrain CC to Claude Code Fuel Gauge. New dashboard gauge icon, new screenshots, improved Marketplace discoverability.

Previously released as BrainDrain CC (v0.1.0–v0.4.4).
