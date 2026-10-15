# Contributing

Thank you for wanting to help.

## Running the extension locally

```bash
npm install      # development dependencies only; the extension itself has no runtime dependencies
npm run compile  # TypeScript in src/ becomes out/extension.js
npm test         # the full test suite; the runner prints its own count
```

Press **F5** in VS Code to open an Extension Development Host: a second VS Code window
running your build of the extension. Start a Claude Code session in a folder that window
has open, and the status bar items appear there.

## Where the bridge script lives

The bridge is the shell script that Claude Code pipes its status line data to. It is not a
separate file in this repository. It is embedded in `src/extension.ts` as the
`BRIDGE_SCRIPT` template literal, and the extension writes it to
`~/.claude/scripts/context-bridge.sh` every time it activates.

So edit it in `src/extension.ts`. If you edit the copy in `~/.claude/scripts/`, the next
activation overwrites your changes.

## Before you open a pull request

- Run `npm test`. The whole suite must pass.
- For anything larger than a small fix, open an issue or a discussion first, so we can
  agree on the approach before you write the code.
- By sending a pull request you agree that your contribution is licensed under the same
  [MIT licence](LICENSE) as this repository.

## What happens next

Making AI Practical is one person. If you have heard nothing for a while, a polite
nudge is welcome and will not annoy anyone. A large pull request that arrives unannounced may wait a good while —
which is why the issue-first line above is a kindness to you, not a procedure.
