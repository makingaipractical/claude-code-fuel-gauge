# Change Log

All notable changes to Claude Code Fuel Gauge.

## v0.9.1 — 2026-08-31

Two fixes and three smaller changes.


**The cache countdown now reads your cache lifetime instead of guessing it.** Earlier versions worked out whether your plan uses a five-minute or a one-hour prompt cache by watching token counts: a cache that survived a long idle gap meant an hour, and a cache miss after a six-minute gap meant five minutes. The second rule was wrong. A cache miss after a short gap usually means something earlier in the conversation changed and invalidated the cache, not that the cache expired — and because the answer was saved for the whole account, one bad guess put every window on a five-minute countdown and showed `expired` beside sessions that were very much alive. Claude Code writes down which cache it asked for on every turn, so Fuel Gauge now reads that instead of inferring it. The reading is exact, it corrects itself on the next update, and there is nothing for you to change. If that record cannot be read — an older Claude Code that does not say where the transcript is, a file that is not readable — Fuel Gauge falls back to the one thing the token counts can prove on their own: a cache that survived more than five minutes is not a five-minute cache. `fuel-gauge.cacheTTL` still overrides everything.

**No more green 0% straight after `/compact`.** Claude Code hands the status line an empty context window for the moment between a compact finishing and your next message — nothing is wrong, it simply has no number yet ([claude-code#86785](https://github.com/anthropics/claude-code/issues/86785)). Fuel Gauge used to show that as `0%` in green, which is the most reassuring thing it can say at the exact moment you look to check whether the compact worked. The window is not empty at that point — it holds the summary and your CLAUDE.md — so the gauge now keeps the last number it had, writes it with a tilde (`~42%`) and drops the colour, and the hover explains that the reading updates on your next turn.

**Each item can now be hidden on its own.** The four items are named in VS Code's status bar right-click menu — Fuel Gauge: context, cache countdown, model and effort, usage alert — so you can switch off the ones you do not want and VS Code remembers.

**The cache hover says "expires at 01:22 PM".** The bar shows how long the cache has left (`59:19`) and the hover shows when it runs out. Both used to be printed as `NN:NN`, so they read as two countdowns that disagreed. The hover now names the clock time in your system's format, the same way the usage reset times are shown.

**The gauge hides itself when there is nothing to measure.** When no Claude Code session belongs to the folder you have open, earlier versions showed `0%` — which reads as a real measurement of an empty context window, when in fact there is nothing to measure. All four items now disappear instead, and come back on their own when a session starts in that folder. If a window is empty and you expected it not to be, run **Claude Code Fuel Gauge: Show Diagnostics**: it names the folder the window has open and says whether any session matches it. Claude Code sessions are matched by the folder they were started in, which is the usual reason.

## v0.9.0 — 2026-08-31

Two changes.


**The context percentage now matches Claude Code exactly.** Earlier versions worked the percentage out themselves: they counted output tokens as well as input tokens, and they subtracted an estimated 18,000 tokens of system overhead from the size of the window, on the assumption that the system prompt, the tool definitions and CLAUDE.md were invisible to the status line. Those tokens are not invisible — Claude Code counts them in the figures it already sends — so the correction was inflating the reading. Fuel Gauge now displays the number Claude Code sends, unchanged, which is the same number you get from `/context`.

**What you will notice: your percentage drops.** On a 200,000-token context window it falls by about 9% of the number you see today, so a gauge reading 68% will read about 62%. On a 1,000,000-token window it falls by about 2%. Nothing about your session has changed — the gauge had been overstating and has stopped. The colours move with it: red at 80% now means you are genuinely 80% full, where before it lit up at a true fill of around 72%. The `fuel-gauge.systemOverhead` setting is deprecated and you can delete it from your settings; if you leave a value there it applies only in the rare case where Claude Code sends no percentage at all.

**Fuel Gauge no longer takes Claude Code's status line without asking.** Earlier versions overwrote `statusLine.command` in `~/.claude/settings.json` on every activation, silently destroying a custom status line if you had one. Now Fuel Gauge asks first, saves your command, and adds **Restore Previous Status Line** to put it back — plus **Show Diagnostics** for when the gauge is dark, and `fuel-gauge.manageStatusLine` to keep it away from your settings entirely. It also stops rewriting a `settings.json` it cannot parse, preserves other keys in the `statusLine` object, and copies a hand-edited bridge script aside before replacing it. If a previous version destroyed your status line, I'm sorry — there was no backup taken then, so there is nothing I can restore for you now. Upgrading is a no-op if you already had Fuel Gauge working.

## v0.8.1 — 2026-08-19

Documentation only. Restores the Marketplace badges at the top of this page: shields.io retired its Visual Studio Marketplace badge service in April 2026, so they had been rendering as "retired". No code changes from v0.8.0.


## v0.8.0 — 2026-07-10

Two new readouts. A **model·effort indicator** (`opus·x-high`, colored by effort, gold at `max`) so you always know which brain each session is running — and can dial effort down when it's overkill. And a **usage meter**: your session (5-hour) and weekly limits in the hover tooltip with reset times, plus an alert dot that lights up in the bar (yellow ≥70%, red ≥90%) when you're running hot. Both ride the same local statusline feed — no network calls. `fuel-gauge.effortStyle` and `fuel-gauge.showUsage` control them.


## v0.6.3 — 2026-05-18

Persists the detected cache TTL to `~/.claude/fuel-gauge/account_ttl.json` so new sessions inherit the 1h (or 5m) value without re-detecting each time. Later downgrade events (a cache miss across a 6–55 min gap) update the persisted value automatically. Avoids the "every new session starts at 5 minutes" feel for Max users.


## v0.6.2 — 2026-05-18

Optional audio warning: when the cache countdown drops below `fuel-gauge.cacheWarningSeconds` (default off), Fuel Gauge plays 3 short beeps. macOS only. Fires once per cache cycle, not on every tick.


## v0.6.1 — 2026-05-18

Adds a prompt-cache countdown in a second status bar item. Shows time until cache expiry in `M:SS`, color-coded for urgency (yellow under 60s, red under 15s). Auto-detects 5-minute vs 1-hour TTL from observed cache behavior; the `fuel-gauge.cacheTTL` setting overrides detection.


## v0.5.0 — 2026-04-14

Renamed from BrainDrain CC to Claude Code Fuel Gauge. New dashboard gauge icon, new screenshots, improved Marketplace discoverability.


Previously released as BrainDrain CC (v0.1.0–v0.4.4).
