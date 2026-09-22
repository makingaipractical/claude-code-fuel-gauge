# Change Log

All notable changes to Claude Code Fuel Gauge.

## Unreleased — v0.9.2

- A fifth status bar item says **wrong folder**, in red, when Claude is started from a terminal in this window in a folder the window does not have open. A start in a subfolder, or in any root of a multi-root workspace, is ordinary and says nothing. Nothing is changed for you: the item reads and warns.

## v0.9.1 — 2026-08-31

- The cache countdown now reads your plan's cache lifetime (5 minutes or 1 hour) from Claude Code's own session record instead of inferring it from token behaviour. The reading is exact and corrects itself on the next update; `fuel-gauge.cacheTTL` still overrides it. This ends the false `expired` some sessions saw.
- After `/compact`, the gauge holds its last reading as `~42%`, uncoloured, instead of showing a green 0% while Claude Code has no number yet ([claude-code#86785](https://github.com/anthropics/claude-code/issues/86785)).
- Each of the four status bar items can be hidden on its own from the status bar's right-click menu, and VS Code remembers the choice.
- The cache hover names the clock time the cache expires ("expires at 01:22 PM") instead of a second countdown that read like it disagreed with the bar.
- The gauge hides itself in windows with no matching Claude Code session, instead of showing 0%. **Show Diagnostics** names the folder the window has open and the sessions Fuel Gauge can see.

## v0.9.0 — 2026-08-31

- The context percentage is now exactly the one Claude Code reports — the same number `/context` gives you. Earlier versions applied a correction that read a few points too high, so the percentage drops a little on upgrade; nothing about your session changed. `fuel-gauge.systemOverhead` is deprecated and safe to delete; it applies only if Claude Code sends no percentage of its own.
- Fuel Gauge now asks before taking Claude Code's status line slot, saves the previous command, and adds **Restore Previous Status Line**, **Show Diagnostics** and the `fuel-gauge.manageStatusLine` setting. It no longer rewrites a `settings.json` it cannot parse, preserves other keys in the `statusLine` object, and copies a hand-edited bridge script aside before replacing it.

## v0.8.1 — 2026-08-19

Documentation only. Restores the Marketplace badges at the top of this page: shields.io retired its Visual Studio Marketplace badge service in April 2026, so they had been rendering as "retired". No code changes from v0.8.0.

## v0.8.0 — 2026-07-10

Two new readouts. A **model·effort indicator** (`opus·x-high`, colored by effort, gold at `max`) so you always know which brain each session is running — and can dial effort down when it's overkill. And a **usage meter**: your session (5-hour) and weekly limits in the hover tooltip with reset times, plus an alert dot that lights up in the bar (yellow ≥70%, red ≥90%) when you're running hot. Both ride the same local statusline feed — no network calls. `fuel-gauge.effortStyle` and `fuel-gauge.showUsage` control them.

## v0.6.3 — 2026-05-18

Persists the detected cache TTL to `~/.claude/fuel-gauge/account_ttl.json` so new sessions inherit the 1h (or 5m) value without re-detecting each time.

## v0.6.2 — 2026-05-18

Optional audio warning: when the cache countdown drops below `fuel-gauge.cacheWarningSeconds` (default off), Fuel Gauge plays 3 short beeps. macOS only. Fires once per cache cycle, not on every tick.

## v0.6.1 — 2026-05-18

Adds a prompt-cache countdown in a second status bar item. Shows time until cache expiry in `M:SS`, color-coded for urgency (yellow under 60s, red under 15s). Auto-detects 5-minute vs 1-hour TTL from observed cache behavior; the `fuel-gauge.cacheTTL` setting overrides detection.

## v0.5.0 — 2026-04-14

Renamed from BrainDrain CC to Claude Code Fuel Gauge. New dashboard gauge icon, new screenshots, improved Marketplace discoverability.

Previously released as BrainDrain CC (v0.1.0–v0.4.4).
