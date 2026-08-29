# Claude Code Fuel Gauge

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=makingaipractical.claude-code-fuel-gauge"><img src="https://vsmarketplacebadges.dev/version-short/makingaipractical.claude-code-fuel-gauge.svg?label=VS%20Marketplace&color=1f8ceb" alt="VS Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=makingaipractical.claude-code-fuel-gauge"><img src="https://vsmarketplacebadges.dev/installs-short/makingaipractical.claude-code-fuel-gauge.svg?label=installs&color=1f8ceb" alt="Installs"></a>
</p>

Fuel Gauge puts four Claude Code readouts in your VS Code status bar: how full the context window is, how long your prompt cache has left, which model and effort level the session is running, and how close you are to your usage limits. One window, one session, no slash commands.

<p align="center">
  <img src="images/status-active.png" width="360" alt="Two Claude Code sessions in separate VS Code windows, each with its own Fuel Gauge: context % in green, a cache countdown, and the model-effort indicator — opus·high in one, fable·x-high in the other">
</p>

## Everything stays on your machine

Fuel Gauge never logs into your Claude account. It has no account of its own, no API key and no telemetry, and it makes no network calls of any kind — not to me, not to Anthropic, not even to check for a new version. Every number it shows comes from files Claude Code already writes on your own disk.

I checked that rather than assumed it. The code was audited for network calls on 21 August 2026, and again on 24 August, when the extension started reading the tail of the session transcript.

This is the complete list of what it reads and writes:

| File or folder | What Fuel Gauge does with it |
| --- | --- |
| `~/.claude/settings.json` | Reads it. Writes one key, `statusLine.command`, and only after you agree to it. Every other setting is left as it was. |
| `~/.claude/scripts/context-bridge.sh` | Writes the bridge script that Claude Code pipes its status line data to. If a different script is already there, it is copied aside first. |
| `~/.claude/fuel-gauge/` | Writes one small JSON file per Claude Code session, and reads them back to draw the status bar. |
| Claude Code's session transcript, under `~/.claude/projects/` | Reads the end of the current session's file, to find out whether your plan's prompt cache lasts five minutes or an hour. Two token counters are used. Nothing is written there, and no message text is read. |
| VS Code global storage | Writes a copy of your previous status line command, so that Restore Previous Status Line always has something to give back. |

Nothing else is read, nothing else is written, and nothing leaves the machine. The same list is in [SECURITY.md](SECURITY.md), together with how to report a vulnerability privately.

## The cache countdown

Anthropic keeps the front of your conversation warm in a prompt cache, for five minutes or an hour depending on your plan. While it is warm, your next message reuses it. Let it go cold and the whole conversation is read again from the start: the next turn is slower, and on API billing it costs more.

Fuel Gauge shows the time you have left as its own status bar item, with its own colour, so cache urgency reads independently of how full your context is. As of August 2026 no other VS Code extension shows this. Here a comfortable `34%` context sits in green next to an `expired` cache in red.

<p align="center">
  <img src="images/cache-expired.png" width="300" alt="Status bar showing 34% context in green next to an expired cache countdown in red, and opus·x-high — the cache carries its own color">
</p>

- **Counting down** — `M:SS`, inherits the context colour while there is comfortable time left
- **Warming (<60s)** — yellow
- **Expiring (<15s)** — red
- **Expired** — `expired` label in red with a circle-slash icon
- **Hidden** — when there is no cache state yet (fresh session, just after `/compact`)

**How exact it is.** The cache lifetime is read, not guessed. Claude Code records on every turn which cache it asked for, the five-minute one or the one-hour one, and Fuel Gauge reads the most recent of those entries from the end of the session transcript. That reading is exact, and it corrects itself on the next update. The answer is saved to `~/.claude/fuel-gauge/account_ttl.json`, so a new session's countdown is right from its first second.

The countdown itself starts again from the full lifetime on every status line update, so it tracks the last activity Claude Code reported. If the record cannot be read — an older Claude Code that does not say where the transcript is, or a file that will not open — Fuel Gauge falls back to the one thing the token counts can prove on their own: a cache that survived more than five minutes is not a five-minute cache. `fuel-gauge.cacheTTL` overrides all of it, if you would rather fix the value yourself.

## The other three readouts

Fuel Gauge shows up to four items, right-aligned, and one shared hover tooltip that breaks everything down.

<p align="center">
  <img src="images/tooltip.png" width="360" alt="The Fuel Gauge hover tooltip: model and effort in color, then context %, cache countdown, and the session and weekly usage limits with reset times">
</p>

### Context percentage

How full the window is, live from 0% and colour-coded green → yellow → red. It covers `claude` sessions in the integrated terminal, which Claude Code's own indicator does not.

- **Active** — coloured percentage, using your thresholds
- **Stale** — percentage with a circle-slash icon, no colour (no update for over an hour, a genuinely abandoned session)
- **Reading paused** — `~42%`, no colour: right after `/compact` Claude Code reports an empty context window until your next turn, so the gauge holds the last number it had and marks it with a tilde rather than dropping to a green 0%
- **No session** — the gauge is hidden. It appears when a Claude Code session starts in the folder this window has open

The percentage is exactly the one Claude Code reports. Run `/context` in a session, or read Claude Code's own status line, and you will see the same figure. It will not match the small pie in the VS Code prompt box, or the "Context low" message in the terminal, because those two measure how much room is left before Claude Code compacts your conversation automatically, and they measure it against a smaller window. They answer a different question, so their numbers differ. See [Known issues](#known-issues).

### Model and effort

A compact item like `opus·x-high`, coloured by effort level, gold when you are running `max`. Hover for the full model name and the effort spelled out. Seeing `opus·max` on a medium-sized task is what makes you dial it down, and effort is a large lever on tokens burned. Hide the item with `fuel-gauge.effortStyle: off`. The effort part only appears when the current model reports an effort level.

### Usage limits

Your session (5-hour) and weekly usage live in the **hover tooltip**, each with its reset time. To keep the bar quiet, that is the only place the numbers appear, until a limit gets high:

- **Running hot** — when your 5-hour or weekly usage crosses 70%, a coloured dot appears in the bar (yellow ≥70%, red ≥90%). Hover it for the exact percentages and reset times.
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

### The status line slot, and what Fuel Gauge writes

Claude Code allows **one** status line command. Fuel Gauge needs it, because the 5-hour and
weekly usage percentages exist nowhere else on your machine — they are not in the session
transcripts and no hook receives them.

So if you already run your own status line (ccstatusline, a powerline script, anything),
Fuel Gauge asks before taking the slot, saves what was there, and can put it back:

- **Fuel Gauge: Restore Previous Status Line** — puts your command back and stops Fuel Gauge managing the slot.
- **Fuel Gauge: Connect Status Line** — asks again if you declined.
- **Claude Code Fuel Gauge: Show Diagnostics** — read-only report if the gauge is dark.
- `fuel-gauge.manageStatusLine` — set to `false` to keep Fuel Gauge away from your settings entirely.

The two cannot run at the same time. That is a Claude Code limitation, not a choice we made.

## Requirements

- VS Code 1.93+ (or a compatible fork)
- Claude Code CLI — works with any model and with both the 200k and 1M-token context windows
- `bash` and Python 3 — the bridge script is a shell script that uses `python3` to read Claude Code's JSON.
  On macOS, `python3` comes with the Xcode Command Line Tools. Most developers already have them; if you do not,
  the first run pops Apple's "Install command line developer tools?" dialog. Install them once with
  `xcode-select --install` and the gauge works from then on.
- Usage limits display: a Claude subscription plan (Pro/Max). API-key sessions don't have these limits, so the display stays hidden.
- Usage limits on a **Team plan**: Claude Code does not send the limit numbers to the status line for Team plan sessions ([claude-code#84995](https://github.com/anthropics/claude-code/issues/84995)), so the usage alert dot and the 5-hour and weekly lines in the hover stay empty there. Everything else works normally.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `fuel-gauge.pollInterval` | 15 | How often to check for updates (seconds) |
| `fuel-gauge.warningThreshold` | 60 | Context % at which the indicator turns yellow |
| `fuel-gauge.dangerThreshold` | 80 | Context % at which the indicator turns red |
| `fuel-gauge.systemOverhead` | 0 | Deprecated, and safe to delete from your settings. A number of tokens to subtract from the context window before working out the percentage. Used only if Claude Code sends no percentage of its own |
| `fuel-gauge.cacheTTL` | `null` (auto) | How long the prompt cache lives, in seconds. Leave it empty and Fuel Gauge reads the answer from Claude Code's own record. Set `300` (5 minutes) or `3600` (1 hour) only to override that |
| `fuel-gauge.cacheWarningSeconds` | `null` (off) | Play 3 short beeps when the cache countdown drops below this many seconds. macOS only. Example: `180` for a 3-minute warning |
| `fuel-gauge.effortStyle` | `text` | Model·effort item: `text` to show it, `off` to hide it |
| `fuel-gauge.showUsage` | `true` | Show session/weekly usage in the hover, with the alert dot when a limit is high |
| `fuel-gauge.manageStatusLine` | `true` | Let Fuel Gauge use Claude Code's status line slot. Set to `false` to keep it out of `~/.claude/settings.json` entirely — the gauge then shows nothing |

To hide one of the four items without hiding the rest, right-click the status bar itself: VS Code lists them as **Fuel Gauge: context**, **cache countdown**, **model and effort** and **usage alert**, and remembers what you switch off. No setting needed.

## Known issues

**Claude Code shows two different context percentages, and Fuel Gauge follows one of them.** Fuel Gauge shows the figure Claude Code's `/context` command and its status line report: how full the context window is, measured against the whole window. Claude Code also draws a pie in the VS Code prompt box and prints a "Context low" message in the terminal. Those two report something else — how close you are to the point where Claude Code compacts the conversation for you — and they measure it against a smaller window, so they will not agree with Fuel Gauge. They also stay hidden until the window is more than half full, while Fuel Gauge shows a number from the first message onwards. Neither reading is wrong; they are counting different things.

**Usage is all-models only — no per-model bar.** `/usage` shows Max users a separate weekly bar for one model family; Claude Code doesn't include that number in the statusline data. The only way to get it is an undocumented web request using your login credentials, and Fuel Gauge deliberately doesn't do network calls. If Anthropic adds it to the statusline, it'll show up here.

**Usage can be missing entirely.** The limit fields are only sent on subscription plans, only after the first response, and there are upstream reports of them missing on some account types. Fuel Gauge hides the display instead of showing 0.

**Status bar stays empty in an untrusted folder.** Claude Code only runs the statusline command after you've accepted its workspace-trust prompt. Until then it shows "statusline skipped · restart to fix" and Fuel Gauge has no data to show. Trust the folder and restart the session.

**Status bar stops updating on macOS (rare).** Claude Code has had an upstream bug where the statusline command can silently stop firing on macOS ([#32660](https://github.com/anthropics/claude-code/issues/32660)). When it happens, Fuel Gauge shows a stale percentage or stays at 0%. Restarting the Claude Code session fixes it.

**Workspace matching.** Fuel Gauge shows context for the Claude Code session whose project directory matches the open VS Code workspace. If you launch Claude Code from a different directory than the one open in VS Code, it won't pick it up — by design, since the status bar belongs to the workspace.

**Icon differences across editors.** In VS Code the status bar shows a Claude icon next to a dashboard gauge. In forks like Antigravity that lack newer codicons, only the gauge appears. Functionality is identical.

## Questions, bugs and ideas

If something is broken, [open an issue](https://github.com/makingaipractical/claude-code-fuel-gauge/issues/new/choose) and pick the bug report template. It asks you to paste the output of the **Claude Code Fuel Gauge: Show Diagnostics** command, which lists your settings file, the bridge script and the session files Fuel Gauge can see — that report answers most of the questions I would otherwise have to ask you, so please include it. Questions about how any of this works belong in [Discussions under Q&A](https://github.com/makingaipractical/claude-code-fuel-gauge/discussions/categories/q-a), and things you would like Fuel Gauge to do belong in [Discussions under Ideas](https://github.com/makingaipractical/claude-code-fuel-gauge/discussions/categories/ideas). If the extension is working for you, please [leave a review on the Marketplace](https://marketplace.visualstudio.com/items?itemName=makingaipractical.claude-code-fuel-gauge&ssr=false#review-details) — reviews are how other people find it.

## Privacy

No API calls, no telemetry, no runtime dependencies, no account. Everything runs locally on Claude Code's own statusline data, including the usage numbers. The files Fuel Gauge reads and writes are listed in full under [Everything stays on your machine](#everything-stays-on-your-machine), and in [SECURITY.md](SECURITY.md).

## Not affiliated with Anthropic

This is a community tool. Not made by, endorsed by, or affiliated with Anthropic.

## Version History

**v0.9.1** — Two fixes.

**The cache countdown now reads your cache lifetime instead of guessing it.** Earlier versions worked out whether your plan uses a five-minute or a one-hour prompt cache by watching token counts: a cache that survived a long idle gap meant an hour, and a cache miss after a six-minute gap meant five minutes. The second rule was wrong. A cache miss after a short gap usually means something earlier in the conversation changed and invalidated the cache, not that the cache expired — and because the answer was saved for the whole account, one bad guess put every window on a five-minute countdown and showed `expired` beside sessions that were very much alive. Claude Code writes down which cache it asked for on every turn, so Fuel Gauge now reads that instead of inferring it. The reading is exact, it corrects itself on the next update, and there is nothing for you to change. If that record cannot be read — an older Claude Code that does not say where the transcript is, a file that is not readable — Fuel Gauge falls back to the one thing the token counts can prove on their own: a cache that survived more than five minutes is not a five-minute cache. `fuel-gauge.cacheTTL` still overrides everything.

**No more green 0% straight after `/compact`.** Claude Code hands the status line an empty context window for the moment between a compact finishing and your next message — nothing is wrong, it simply has no number yet ([claude-code#86785](https://github.com/anthropics/claude-code/issues/86785)). Fuel Gauge used to show that as `0%` in green, which is the most reassuring thing it can say at the exact moment you look to check whether the compact worked. The window is not empty at that point — it holds the summary and your CLAUDE.md — so the gauge now keeps the last number it had, writes it with a tilde (`~42%`) and drops the colour, and the hover explains that the reading updates on your next turn.

**Each item can now be hidden on its own.** The four items are named in VS Code's status bar right-click menu — Fuel Gauge: context, cache countdown, model and effort, usage alert — so you can switch off the ones you do not want and VS Code remembers.

**The gauge hides itself when there is nothing to measure.** When no Claude Code session belongs to the folder you have open, earlier versions showed `0%` — which reads as a real measurement of an empty context window, when in fact there is nothing to measure. All four items now disappear instead, and come back on their own when a session starts in that folder. If a window is empty and you expected it not to be, run **Claude Code Fuel Gauge: Show Diagnostics**: it names the folder the window has open and says whether any session matches it. Claude Code sessions are matched by the folder they were started in, which is the usual reason.

**v0.9.0** — Two changes.

**The context percentage now matches Claude Code exactly.** Earlier versions worked the percentage out themselves: they counted output tokens as well as input tokens, and they subtracted an estimated 18,000 tokens of system overhead from the size of the window, on the assumption that the system prompt, the tool definitions and CLAUDE.md were invisible to the status line. Those tokens are not invisible — Claude Code counts them in the figures it already sends — so the correction was inflating the reading. Fuel Gauge now displays the number Claude Code sends, unchanged, which is the same number you get from `/context`.

**What you will notice: your percentage drops.** On a 200,000-token context window it falls by about 9% of the number you see today, so a gauge reading 68% will read about 62%. On a 1,000,000-token window it falls by about 2%. Nothing about your session has changed — the gauge had been overstating and has stopped. The colours move with it: red at 80% now means you are genuinely 80% full, where before it lit up at a true fill of around 72%. The `fuel-gauge.systemOverhead` setting is deprecated and you can delete it from your settings; if you leave a value there it applies only in the rare case where Claude Code sends no percentage at all.

**Fuel Gauge no longer takes Claude Code's status line without asking.** Earlier versions overwrote `statusLine.command` in `~/.claude/settings.json` on every activation, silently destroying a custom status line if you had one. Now Fuel Gauge asks first, saves your command, and adds **Restore Previous Status Line** to put it back — plus **Show Diagnostics** for when the gauge is dark, and `fuel-gauge.manageStatusLine` to keep it away from your settings entirely. It also stops rewriting a `settings.json` it cannot parse, preserves other keys in the `statusLine` object, and copies a hand-edited bridge script aside before replacing it. If a previous version destroyed your status line, I'm sorry — there was no backup taken then, so there is nothing I can restore for you now. Upgrading is a no-op if you already had Fuel Gauge working.

**v0.8.1** — Documentation only. Restores the Marketplace badges at the top of this page: shields.io retired its Visual Studio Marketplace badge service in April 2026, so they had been rendering as "retired". No code changes from v0.8.0.

**v0.8.0** — Two new readouts. A **model·effort indicator** (`opus·x-high`, colored by effort, gold at `max`) so you always know which brain each session is running — and can dial effort down when it's overkill. And a **usage meter**: your session (5-hour) and weekly limits in the hover tooltip with reset times, plus an alert dot that lights up in the bar (yellow ≥70%, red ≥90%) when you're running hot. Both ride the same local statusline feed — no network calls. `fuel-gauge.effortStyle` and `fuel-gauge.showUsage` control them.

**v0.6.3** — Persists the detected cache TTL to `~/.claude/fuel-gauge/account_ttl.json` so new sessions inherit the 1h (or 5m) value without re-detecting each time. Later downgrade events (a cache miss across a 6–55 min gap) update the persisted value automatically. Avoids the "every new session starts at 5 minutes" feel for Max users.

**v0.6.2** — Optional audio warning: when the cache countdown drops below `fuel-gauge.cacheWarningSeconds` (default off), Fuel Gauge plays 3 short beeps. macOS only. Fires once per cache cycle, not on every tick.

**v0.6.1** — Adds a prompt-cache countdown in a second status bar item. Shows time until cache expiry in `M:SS`, color-coded for urgency (yellow under 60s, red under 15s). Auto-detects 5-minute vs 1-hour TTL from observed cache behavior; the `fuel-gauge.cacheTTL` setting overrides detection.

**v0.5.0** — Renamed from BrainDrain CC to Claude Code Fuel Gauge. New dashboard gauge icon, new screenshots, improved Marketplace discoverability.

Previously released as BrainDrain CC (v0.1.0–v0.4.4).
