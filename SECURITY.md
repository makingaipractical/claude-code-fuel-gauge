# Security

## What the extension touches

Brain Drain for Claude Code runs entirely on your own machine. It makes no network calls of any
kind: no telemetry, no update checks, no account, no API keys.

It reads and writes these files, and nothing else:

| File or folder | What the extension does with it |
| --- | --- |
| `~/.claude/settings.json` | Reads it. Writes one key, `statusLine.command`. If the slot is empty, it connects at once and offers Undo. If another command is there, it asks first and saves that command. While the Brain Drain mod feeds the gauge, it does neither until you run Connect Status Line. Every other setting is left as it was. |
| `~/.claude/scripts/context-bridge.sh` | Writes the bridge script that Claude Code pipes its status line data to. If a different script is already there, the extension copies it aside first, to `context-bridge.sh.fuel-gauge.orig`. |
| `~/.claude/fuel-gauge/` | Writes one small JSON file per Claude Code session, and reads them back to draw the status bar. Also `account_ttl.json` (the cache lifetime last seen), `config.json` and `bridge.log`. |
| Claude Code's session transcript, under `~/.claude/projects/` | Reads the end of the current session's file and keeps two token counters from it, to find out whether your prompt cache lasts five minutes or an hour. Message text is never stored or sent anywhere, and nothing is written there. |
| VS Code global storage | Writes a copy of your previous status line command, so that Restore Previous Status Line always has something to give back. |

## Reporting a vulnerability

Please report privately rather than in a public issue. Go to the
[Security tab of this repository](https://github.com/makingaipractical/claude-code-fuel-gauge/security)
and choose **Report a vulnerability**. That opens a private report that only the maintainer
can see. If you prefer email, send it to [info@makingaipractical.com](mailto:info@makingaipractical.com)
with "security" somewhere in the subject line.

Please include what an attacker could do, and the steps to reproduce it. I aim to
acknowledge a report within five working days; if you have heard nothing after that,
please send it again — it will have gone astray rather than been ignored. If the problem
is real, I will fix it as fast as I can, and the report stays private until the fix is
out. I cannot promise a fix by a particular date, and I would rather say that plainly
than imply otherwise.
