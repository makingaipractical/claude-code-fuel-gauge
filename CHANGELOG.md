# Change Log

All notable changes to Brain Drain for Claude Code (called Claude Code Fuel Gauge up to v0.9.1).

## v0.10.2

- The cache countdown keeps a colour of its own. It used to take the context gauge's colour while time was comfortable, so a cache with 57 minutes left turned yellow as soon as the context passed your warning threshold. It is now green until its own steps: for the one-hour cache yellow from 25 minutes left and red from 5; for the five-minute cache yellow under a minute and red under 15 seconds, as before. `expired` stays red. `fuel-gauge.cacheWarningSeconds` still sets only the beep.
- With several VS Code windows open, a Claude Code session one window saw end is no longer forgotten when another window records an end of its own. Up to now the later window's list replaced the shared one, and the ended session's leftover mod copy could show the gauge again for up to 36 hours.
- You can put your own text in Claude Code's status line while the bridge holds it. Make an executable file at `~/.claude/fuel-gauge/status-line`: the bridge runs it on each update, after writing the session file, with the same JSON on stdin, and shows what it prints. It survives extension updates, which rewrite the bridge itself. It is skipped if it is not yours, if others can write to it, if it fails, or if it takes over 2 seconds. Without it the bridge prints nothing, as before.
- A reading over an hour old now says in its hover when it was last updated, and that a session in the chat panel of Anthropic's Claude Code extension writes nothing the gauge reads. Up to now the gauge only went grey, and nothing said why it could differ from the panel.

## v0.10.1 — 2026-11-03

- When Claude Code sends a weekly limit but no 5-hour one, the 5-hour item now reads `5h –` instead of disappearing, and its hover says your plan reports no 5-hour limit right now. Up to now a missing figure looked like a broken gauge. With neither figure (API-key sessions, or before the first response) both items stay hidden, and `fuel-gauge.showUsage: false` still hides them.

## v0.10.0 — 2026-11-02

- The status bar takes the look of the Brain Drain mod: `🧠 34%` `◷ 59:59` `5h 12% ↻22:40` `wk 25%` `opus·x-high`. The context gauge opens with 🧠 instead of the Claude and dashboard icons, and the cache countdown with ◷. The 5-hour and weekly limits are now always in the bar, each as its own item with its own colour: none below 70% used, yellow from 70%, red from 90%. The 5-hour item shows its reset time while it lies ahead. They replace the numberless alert dot. If you had hidden the alert dot, the 5-hour limit stays hidden: it takes over the dot's entry in the status bar's right-click menu. The weekly limit is a new entry there and shows until you hide it. `fuel-gauge.showUsage: false` still hides both.
- With the Brain Drain mod installed, the gauge also reads the mod's copy of a session. While the bridge is your status line the mod writes its copy to `~/.claude/fuel-gauge-mod/`, a folder the gauge used to ignore. It now draws the mod's copy for a session the bridge wrote no file for; where both wrote, the bridge's file still counts.
- In a multi-root workspace, a session started in any of its folders now shows the gauge. Up to now only the first folder counted.
- Show Diagnostics has a new line, "Brain Drain mod". It names the newest session file the mod wrote in the last 36 hours and its age, or says there is none.
- Show Diagnostics now says what the mod means for the status line: that Brain Drain left it alone and Connect Status Line takes it, or, when the bridge holds it and the mod is writing, that Restore Previous Status Line gives your own back.
- Show Diagnostics now reads managed settings on Linux and WSL (`/etc/claude-code/`), and on every platform reads the `.json` files in `managed-settings.d/`. A policy file there that switches hooks off is now named.
- A bridge you edited by hand is no longer replaced without a copy when `context-bridge.sh.fuel-gauge.orig` is already there. The first copy stays as it is, and a later, different edit is copied to `context-bridge.sh.fuel-gauge.orig.latest`, which holds the most recent one.
- The package is smaller: it leaves out a screenshot the README does not show.
- When the session transcript gives no cache lifetime, the bridge now takes it from the status line's own `prompt_cache` field before falling back on older guesses. The transcript still decides when both are there.

## v0.9.3 — 2026-10-15

- The gauge no longer freezes on its last reading when Brain Drain cannot read its session folder. It used to hide for a second and then draw the old number again, so a gauge that had stopped updating looked healthy.
- When Claude Code sends no percentage of its own, the fallback no longer counts output tokens. It now adds up input, cache creation and cache reads, as Claude Code's own figure does, so it no longer marks a reading unreliable when the input fits in the window. The hover on an unreliable reading names the check that actually fired.
- After **Restore Previous Status Line**, the readouts go dark as the dialog says they will, instead of showing the bridge's last reading for up to 36 hours. A reading written after the restore still shows.
- **Show Diagnostics** names `disableAllHooks` or `allowManagedHooksOnly` when either is set, and the settings file that sets it. Either one turns a custom status line off. It reads the managed settings file on macOS and Windows only, and not a `managed-settings.d/` folder beside it; policies set by device management or by a server are not files. So a clean line here does not rule a policy out.
- When the gauge is hidden because the folder's own `.claude/settings.json` or `.claude/settings.local.json` sets a status line, **Show Diagnostics** says so on its no-session line and names the file. Claude Code runs a project's status line instead of the one in `~/.claude`. Brain Drain still writes nothing to project settings.
- When VS Code's environment sets `CLAUDE_CONFIG_DIR`, **Show Diagnostics** names it and says whether that folder's `settings.json` runs Brain Drain's bridge. Claude Code sessions that use another config folder never run the status line wired in `~/.claude/settings.json`.
- **Show Diagnostics** reuses one entry in the Output panel instead of adding a new one each time it runs.
- Upgrading no longer copies Brain Drain's own previous bridge aside as `context-bridge.sh.fuel-gauge.orig`. A bridge you edited by hand is still copied there before it is replaced, unless an earlier copy is already there. Bridges installed before this version carry no mark of being ours, so on a machine with no copy yet, this upgrade makes one a last time.
- The bridge starts Python once per update instead of twice, and refuses a session id that is not a plain file name.
- With the Brain Drain mod: the bridge leaves alone a session file the mod wrote in the last 30 seconds, and takes it back once the mod has moved out after **Connect Status Line**, so that session's gauge keeps updating. The extension also does not ask for Claude Code's status line while the mod has written a session file in the last 36 hours. **Connect Status Line** still takes it when you ask.
- Documentation: the README says who Brain Drain is for and how the project is maintained, and the review request has a line of its own, linking both registries. A pull request template for contributors. SUPPORT.md and the bug template now name the command as it appears in the Command Palette, **Brain Drain: Show Diagnostics**.

## v0.9.2 — 2026-10-11

- Renamed from Claude Code Fuel Gauge to **Brain Drain for Claude Code**. Only the name you read changes: the extension id stays `makingaipractical.claude-code-fuel-gauge`, so this arrives as an ordinary update. Your `fuel-gauge.*` settings, the status bar items you have hidden, and the bridge's `~/.claude/fuel-gauge/` folder all carry over untouched. Commands now appear in the Command Palette as **Brain Drain: Show Diagnostics**, **Brain Drain: Connect Status Line** and **Brain Drain: Restore Previous Status Line**.
- When Claude Code reports a context window smaller than the tokens already in the session, the percentage is shown uncoloured with a warning glyph and a hover saying the window it reported cannot be true ([claude-code#63447](https://github.com/anthropics/claude-code/issues/63447)). The number is left exactly as Claude Code gave it: Anthropic's own indicator clamps an impossible reading to 100%, Brain Drain flags it, because a confident wrong number is worse than a visibly unreliable one.
- A fifth status bar item says **wrong folder**, in red, when Claude is started from a terminal in this window in a folder the window does not have open. A start in a subfolder, or in any root of a multi-root workspace, is ordinary and says nothing. Nothing is changed for you: the item reads and warns.
- Security: the status line bridge now starts Python with `-I`. Claude Code runs the bridge from your project folder, and Python looked there first for the modules it imports, so a file named `json.py` in a project you opened (a cloned repository, say) ran on every status line update. With `-I`, Python ignores that folder.
- The extension manifest now declares its licence, MIT, matching the LICENSE file in the repository.
- Development tools updated: `@vscode/vsce` 3.9.2 → 4.0.0 and `@types/node` 20 → 26. These are build-time only; the extension still has no runtime dependencies.

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
