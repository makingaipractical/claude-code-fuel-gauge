# Claude Code Fuel Gauge

Claude Code Fuel Gauge keeps two numbers in your VS Code status bar, always visible, for every Claude Code session you're running: **how full your context window is**, and **how long until your prompt cache expires**. Without typing a command.

Claude Code shows context usage inside its own chat panel, but only once you're already about half full. Fuel Gauge shows it in the status bar from 0% — whether the Claude panel is open or you're heads-down in your code — and it works for `claude` sessions running in the integrated terminal, which the built-in indicator doesn't cover. It's color-coded green → yellow → red, so you see the ceiling coming instead of hitting it.

Each VS Code window tracks its own workspace, so if you run several Claude Code sessions across projects at once, each window shows the right one.

The **cache countdown** is the part nothing else has. Claude Code caches your prompt prefix so each message comes back fast; that cache goes cold after a few minutes of inactivity (an hour on a Max plan). When it lapses, your next message silently rebuilds it — slower to respond, and on an API-key plan, more expensive too. The countdown shows exactly how long the cache stays warm, so you can get your next message in before it expires.

<p align="center">
  <img src="images/status-active.png" width="350" alt="Claude Code Fuel Gauge showing 14% context usage in green, alongside a 2:42 cache countdown in green">
</p>

## Why Fuel Gauge

- **You see it coming.** No more surprise "context low" warnings. The percentage climbs in front of you, so you can plan your exit before quality drops.
- **The cache never goes cold behind your back.** Glance at the countdown, send your next message while the cache is still warm.
- **Always on, from 0%.** Not gated behind a threshold, not hidden in a panel. It's in the status bar whether you're chatting with Claude or writing code.
- **Every session at once.** Run Claude Code across five projects and each window shows its own — no guessing which session the number belongs to.
- **Session planning.** At 60% you know you can fit one more big task; at 80% you know to wrap up. Context becomes a resource you manage, not a cliff you fall off.

### Why not just use `/context`?

`/context` is a command you have to stop and type, and it only counts input tokens. Fuel Gauge is always on, and it calculates usage from both input and output tokens plus a compensation for the system-prompt/tool/MCP/CLAUDE.md overhead that Claude Code doesn't expose. With the right `systemOverhead` setting, its percentage tracks the "Context low" point Claude Code actually warns at — so it doesn't report free space when you're effectively full.

## Display states

### Context percentage

- **Active** — colored percentage (green/yellow/red based on your thresholds)
- **Stale** — percentage with a circle-slash icon, no color (no update for over an hour — a genuinely abandoned session)
- **No session** — 0%, no color

<p align="center">
  <img src="images/status-states.png" width="350" alt="Fuel Gauge display states — red critical, green active, yellow warning, grey inactive">
</p>

### Cache countdown (since v0.6)

- **Counting down** — `M:SS`, color inherited from the context percentage
- **Warming (<60s)** — yellow
- **Expiring (<15s)** — red
- **Expired** — `expired` label in red with a circle-slash icon
- **Hidden** — when there's no cache state yet (fresh session, just after `/compact`)

## Install

Search for **Claude Code Fuel Gauge** in the VS Code Extensions panel, or install from the command line:

```bash
code --install-extension makingaipractical.claude-code-fuel-gauge
```

For VS Code forks like Antigravity, download the `.vsix` from the [Releases page](https://github.com/makingaipractical/claude-code-fuel-gauge/releases) and install via the extensions panel (three dots > "Install from VSIX").

Restart any running Claude Code sessions after installing. The extension sets up everything else automatically.

## How it works

Claude Code has a [statusline feature](https://code.claude.com/docs/en/statusline) that exposes context-window data as JSON. Fuel Gauge uses it in two parts:

1. **Bridge script** — installed automatically on first activation. Claude Code pipes context data to it, and it writes one small JSON file per session to `~/.claude/fuel-gauge/`.
2. **Extension** — polls that directory every 15 seconds, finds the session matching your current workspace, and shows the numbers in the status bar.

Works for both the built-in VS Code extension's sessions and `claude` sessions in the integrated terminal.

The cache countdown auto-detects your plan's TTL by watching whether the cache survives a >5-minute idle gap. Once detected, Fuel Gauge persists it to `~/.claude/fuel-gauge/account_ttl.json` so new sessions inherit it without re-detecting. If a later session sees the persisted value is wrong (a cache miss across a 6–55 minute gap), it corrects itself.

## Requirements

- VS Code 1.93+ (or a compatible fork)
- Claude Code CLI — works with any model and with both the 200k and 1M-token context windows
- Python 3 (used by the bridge script to parse JSON)

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `fuel-gauge.pollInterval` | 15 | How often to check for updates (seconds) |
| `fuel-gauge.warningThreshold` | 60 | % at which the indicator turns yellow |
| `fuel-gauge.dangerThreshold` | 80 | % at which the indicator turns red |
| `fuel-gauge.systemOverhead` | 18000 | Estimated system token overhead (invisible to the statusline). Increase if Fuel Gauge underreports vs Claude's "Context low" warning |
| `fuel-gauge.cacheTTL` | `null` (auto) | Prompt-cache TTL in seconds. Leave null to auto-detect. Common: `300` (5 min, API key), `3600` (1 hour, Max) |
| `fuel-gauge.cacheWarningSeconds` | `null` (off) | Play 3 short beeps when the cache countdown drops below this many seconds. macOS only. Example: `180` for a 3-minute warning |

## Known issues

**Accuracy depends on system overhead.** Claude Code uses hidden tokens (system prompt, tool definitions, MCP configs, CLAUDE.md) that aren't in the statusline data. Fuel Gauge compensates with the configurable `systemOverhead` setting (default 18,000). If your percentage consistently underreports vs Claude's "Context low" warning, raise it. In practice the default is close.

**Status bar stays empty in an untrusted folder.** Claude Code only runs the statusline command after you've accepted its workspace-trust prompt. Until then it shows "statusline skipped · restart to fix" and Fuel Gauge has no data to show. Trust the folder and restart the session.

**Status bar stops updating on macOS (rare).** Claude Code has had an upstream bug where the statusline command can silently stop firing on macOS ([#32660](https://github.com/anthropics/claude-code/issues/32660)). When it happens, Fuel Gauge shows a stale percentage or stays at 0%. Restarting the Claude Code session fixes it.

**Workspace matching.** Fuel Gauge shows context for the Claude Code session whose project directory matches the open VS Code workspace. If you launch Claude Code from a different directory than the one open in VS Code, it won't pick it up — by design, since the status bar belongs to the workspace.

**Icon differences across editors.** In VS Code the status bar shows a Claude icon next to a dashboard gauge. In forks like Antigravity that lack newer codicons, only the gauge appears. Functionality is identical.

## Privacy

No API calls, no telemetry, no runtime dependencies. Everything runs locally on Claude Code's own statusline data.

## Not affiliated with Anthropic

This is a community tool. Not made by, endorsed by, or affiliated with Anthropic.

## Version History

**v0.6.3** — Persists the detected cache TTL to `~/.claude/fuel-gauge/account_ttl.json` so new sessions inherit the 1h (or 5m) value without re-detecting each time. Later downgrade events (a cache miss across a 6–55 min gap) update the persisted value automatically. Avoids the "every new session starts at 5 minutes" feel for Max users.

**v0.6.2** — Optional audio warning: when the cache countdown drops below `fuel-gauge.cacheWarningSeconds` (default off), Fuel Gauge plays 3 short beeps. macOS only. Fires once per cache cycle, not on every tick.

**v0.6.1** — Adds a prompt-cache countdown in a second status bar item. Shows time until cache expiry in `M:SS`, color-coded for urgency (yellow under 60s, red under 15s). Auto-detects 5-minute vs 1-hour TTL from observed cache behavior; the `fuel-gauge.cacheTTL` setting overrides detection.

**v0.5.0** — Renamed from BrainDrain CC to Claude Code Fuel Gauge. New dashboard gauge icon, new screenshots, improved Marketplace discoverability.

Previously released as BrainDrain CC (v0.1.0–v0.4.4).
