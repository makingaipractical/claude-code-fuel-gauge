# Claude Code Fuel Gauge

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=makingaipractical.claude-code-fuel-gauge"><img src="https://img.shields.io/visual-studio-marketplace/v/makingaipractical.claude-code-fuel-gauge?label=VS%20Marketplace&color=1f8ceb" alt="VS Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=makingaipractical.claude-code-fuel-gauge"><img src="https://img.shields.io/visual-studio-marketplace/i/makingaipractical.claude-code-fuel-gauge?label=installs&color=1f8ceb" alt="Installs"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=makingaipractical.claude-code-fuel-gauge"><img src="https://img.shields.io/visual-studio-marketplace/r/makingaipractical.claude-code-fuel-gauge?label=rating&color=1f8ceb" alt="Rating"></a>
</p>

Claude Code Fuel Gauge keeps the answers Claude Code makes you ask for a glance away in your VS Code status bar, for every session you're running: **how full your context window is**, **how long until your prompt cache goes cold**, **which model you're on at what effort level**, and **how much of your session and weekly limits you've used**. No `/context`, no `/model`, no `/usage`.

Claude Code shows context usage inside its own chat panel, but only once you're already about half full. Fuel Gauge shows it in the status bar from 0% — whether the Claude panel is open or you're heads-down in your code — and it works for `claude` sessions running in the integrated terminal, which the built-in indicator doesn't cover. It's color-coded green → yellow → red, so you see the ceiling coming instead of hitting it.

Each VS Code window tracks its own workspace, so if you run several Claude Code sessions across projects at once, each window shows the right one — and which model each session is on, at what effort level.

<p align="center">
  <img src="images/status-active.png" width="360" alt="Claude Code Fuel Gauge in the VS Code status bar: 14% context in green, a 2:42 cache countdown, and an opus·x-high model-effort indicator">
</p>

The **cache countdown** is the part nothing else has. Claude Code caches your prompt prefix so each message comes back fast; that cache goes cold after a few minutes of inactivity (an hour on a Max plan). When it lapses, your next message silently rebuilds it — slower to respond, and on an API-key plan, more expensive too. The countdown shows exactly how long the cache stays warm, so you can get your next message in before it expires.

The **model·effort indicator** shows which model each session is on and at what reasoning effort — `opus·x-high`, `sonnet·medium`, colored by effort with gold for `max`. That visibility does something useful to your habits: when you can *see* you're running `opus·max` on a task that only needed `medium`, you dial it down — and effort is one of the biggest levers on how many tokens a task burns. The gauge turns "which brain am I paying for right now" from a `/model` check into a glance.

The **usage meter** answers the other question you keep opening `/usage` for: how much of your plan is left. Your session (5-hour) and weekly limits live in the hover tooltip, with reset times — and when a window crosses 70%, a colored dot lights up in the bar so you find out while you can still pace yourself, not from a hard stop mid-task.

## Why Fuel Gauge

- **You see it coming.** No more surprise "context low" warnings. The percentage climbs in front of you, so you can plan your exit before quality drops.
- **The cache never goes cold behind your back.** Glance at the countdown, send your next message while the cache is still warm.
- **You spend effort deliberately.** Seeing `opus·x-high` in the bar is a standing nudge to match effort to the task instead of leaving max running from yesterday's debugging — and lower effort means fewer tokens.
- **Limits stop being a surprise.** A dot lights up when your 5-hour or weekly usage crosses 70%; the exact numbers and reset times are one hover away.
- **Always on, from 0%.** Not gated behind a threshold, not hidden in a panel. It's in the status bar whether you're chatting with Claude or writing code.
- **Every session at once.** Run Claude Code across five projects and each window shows its own — no guessing which session the number belongs to.
- **Session planning.** At 60% you know you can fit one more big task; at 80% you know to wrap up. Context becomes a resource you manage, not a cliff you fall off.

### Why not just use the slash commands?

`/context`, `/model` and `/usage` are commands you have to stop and type, and they show you one session at a time. Fuel Gauge is always on, in every window. For context specifically it also counts more honestly: usage is calculated from both input and output tokens plus a compensation for the system-prompt/tool/MCP/CLAUDE.md overhead that Claude Code doesn't expose. With the right `systemOverhead` setting, its percentage tracks the "Context low" point Claude Code actually warns at — so it doesn't report free space when you're effectively full.

## What's in the status bar

Fuel Gauge shows up to four items, right-aligned, and one shared hover tooltip that breaks everything down.

<p align="center">
  <img src="images/tooltip.png" width="360" alt="The Fuel Gauge hover tooltip: model and effort in color, then context %, cache countdown, and the session and weekly usage limits with reset times">
</p>

### Context percentage

- **Active** — colored percentage (green/yellow/red based on your thresholds)
- **Stale** — percentage with a circle-slash icon, no color (no update for over an hour — a genuinely abandoned session)
- **No session** — 0%, no color

### Cache countdown (since v0.6)

A separate item with its own color, so cache urgency reads independently of how full your context is.

- **Counting down** — `M:SS`, inherits the context color while there's comfortable time left
- **Warming (<60s)** — yellow
- **Expiring (<15s)** — red
- **Expired** — `expired` label in red with a circle-slash icon
- **Hidden** — when there's no cache state yet (fresh session, just after `/compact`)

### Model and effort (since v0.8)

A compact item like `opus·x-high`, colored by effort level (gold when you're running `max`). Hover for the full model name and effort spelled out. Hide it with `fuel-gauge.effortStyle: off`. The effort part only appears when the current model reports an effort level.

### Usage limits (since v0.8)

Your session (5-hour) and weekly usage live in the **hover tooltip**, each with its reset time. To keep the bar quiet, that's the only place the numbers appear — until a limit gets high:

- **Running hot** — when your 5-hour or weekly usage crosses 70%, a colored dot appears in the bar (yellow ≥70%, red ≥90%). Hover it for the exact percentages and reset times.
- **Hidden** — below 70%, and whenever Claude Code sends no limit data (API-key sessions, or before the session's first response). Hidden means hidden: no misleading 0%.

Turn the whole usage display off with `fuel-gauge.showUsage: false`.

## Install

Search for **Claude Code Fuel Gauge** in the VS Code Extensions panel, or install from the command line:

```bash
code --install-extension makingaipractical.claude-code-fuel-gauge
```

For VS Code forks like Antigravity, download the `.vsix` from the [Releases page](https://github.com/makingaipractical/claude-code-fuel-gauge/releases) and install via the extensions panel (three dots > "Install from VSIX").

Restart any running Claude Code sessions after installing. The extension sets up everything else automatically.

## How it works

Claude Code has a [statusline feature](https://code.claude.com/docs/en/statusline) that exposes session data as JSON. Fuel Gauge uses it in two parts:

1. **Bridge script** — installed automatically on first activation. Claude Code pipes session data to it, and it writes one small JSON file per session to `~/.claude/fuel-gauge/`.
2. **Extension** — polls that directory every 15 seconds, finds the session matching your current workspace, and shows the numbers in the status bar.

Everything — context, cache, model, effort, usage limits — rides that same local feed. No network calls, no tokens, no accounts.

Works for both the built-in VS Code extension's sessions and `claude` sessions in the integrated terminal.

The cache countdown auto-detects your plan's TTL by watching whether the cache survives a >5-minute idle gap. Once detected, Fuel Gauge persists it to `~/.claude/fuel-gauge/account_ttl.json` so new sessions inherit it without re-detecting. If a later session sees the persisted value is wrong (a cache miss across a 6–55 minute gap), it corrects itself.

## Requirements

- VS Code 1.93+ (or a compatible fork)
- Claude Code CLI — works with any model and with both the 200k and 1M-token context windows
- Python 3 (used by the bridge script to parse JSON)
- Usage limits display: a Claude subscription plan (Pro/Max). API-key sessions don't have these limits, so the display stays hidden.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `fuel-gauge.pollInterval` | 15 | How often to check for updates (seconds) |
| `fuel-gauge.warningThreshold` | 60 | Context % at which the indicator turns yellow |
| `fuel-gauge.dangerThreshold` | 80 | Context % at which the indicator turns red |
| `fuel-gauge.systemOverhead` | 18000 | Estimated system token overhead (invisible to the statusline). Increase if Fuel Gauge underreports vs Claude's "Context low" warning |
| `fuel-gauge.cacheTTL` | `null` (auto) | Prompt-cache TTL in seconds. Leave null to auto-detect. Common: `300` (5 min, API key), `3600` (1 hour, Max) |
| `fuel-gauge.cacheWarningSeconds` | `null` (off) | Play 3 short beeps when the cache countdown drops below this many seconds. macOS only. Example: `180` for a 3-minute warning |
| `fuel-gauge.effortStyle` | `text` | Model·effort item: `text` to show it, `off` to hide it |
| `fuel-gauge.showUsage` | `true` | Show session/weekly usage in the hover, with the alert dot when a limit is high |

## Known issues

**Accuracy depends on system overhead.** Claude Code uses hidden tokens (system prompt, tool definitions, MCP configs, CLAUDE.md) that aren't in the statusline data. Fuel Gauge compensates with the configurable `systemOverhead` setting (default 18,000). If your percentage consistently underreports vs Claude's "Context low" warning, raise it. In practice the default is close.

**Usage is all-models only — no per-model bar.** `/usage` shows Max users a separate weekly bar for one model family; Claude Code doesn't include that number in the statusline data. The only way to get it is an undocumented web request using your login credentials, and Fuel Gauge deliberately doesn't do network calls. If Anthropic adds it to the statusline, it'll show up here.

**Usage can be missing entirely.** The limit fields are only sent on subscription plans, only after the first response, and there are upstream reports of them missing on some account types. Fuel Gauge hides the display instead of showing 0.

**Status bar stays empty in an untrusted folder.** Claude Code only runs the statusline command after you've accepted its workspace-trust prompt. Until then it shows "statusline skipped · restart to fix" and Fuel Gauge has no data to show. Trust the folder and restart the session.

**Status bar stops updating on macOS (rare).** Claude Code has had an upstream bug where the statusline command can silently stop firing on macOS ([#32660](https://github.com/anthropics/claude-code/issues/32660)). When it happens, Fuel Gauge shows a stale percentage or stays at 0%. Restarting the Claude Code session fixes it.

**Workspace matching.** Fuel Gauge shows context for the Claude Code session whose project directory matches the open VS Code workspace. If you launch Claude Code from a different directory than the one open in VS Code, it won't pick it up — by design, since the status bar belongs to the workspace.

**Icon differences across editors.** In VS Code the status bar shows a Claude icon next to a dashboard gauge. In forks like Antigravity that lack newer codicons, only the gauge appears. Functionality is identical.

## Privacy

No API calls, no telemetry, no runtime dependencies. Everything runs locally on Claude Code's own statusline data — including the usage numbers.

## Not affiliated with Anthropic

This is a community tool. Not made by, endorsed by, or affiliated with Anthropic.

## Version History

**v0.8.0** — Two new readouts. A **model·effort indicator** (`opus·x-high`, colored by effort, gold at `max`) so you always know which brain each session is running — and can dial effort down when it's overkill. And a **usage meter**: your session (5-hour) and weekly limits in the hover tooltip with reset times, plus an alert dot that lights up in the bar (yellow ≥70%, red ≥90%) when you're running hot. Both ride the same local statusline feed — no network calls. `fuel-gauge.effortStyle` and `fuel-gauge.showUsage` control them.

**v0.6.3** — Persists the detected cache TTL to `~/.claude/fuel-gauge/account_ttl.json` so new sessions inherit the 1h (or 5m) value without re-detecting each time. Later downgrade events (a cache miss across a 6–55 min gap) update the persisted value automatically. Avoids the "every new session starts at 5 minutes" feel for Max users.

**v0.6.2** — Optional audio warning: when the cache countdown drops below `fuel-gauge.cacheWarningSeconds` (default off), Fuel Gauge plays 3 short beeps. macOS only. Fires once per cache cycle, not on every tick.

**v0.6.1** — Adds a prompt-cache countdown in a second status bar item. Shows time until cache expiry in `M:SS`, color-coded for urgency (yellow under 60s, red under 15s). Auto-detects 5-minute vs 1-hour TTL from observed cache behavior; the `fuel-gauge.cacheTTL` setting overrides detection.

**v0.5.0** — Renamed from BrainDrain CC to Claude Code Fuel Gauge. New dashboard gauge icon, new screenshots, improved Marketplace discoverability.

Previously released as BrainDrain CC (v0.1.0–v0.4.4).
