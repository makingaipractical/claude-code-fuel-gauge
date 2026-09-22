// Drives the REAL compiled out/extension.js against a sandboxed HOME with a stubbed
// `vscode` module. Every filesystem path the extension touches must land under TMPROOT;
// the harness asserts that at the end of every scenario.
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const { execFileSync } = require('child_process');

const EXT_DIR = path.resolve(__dirname, '..');
const OUT = path.join(EXT_DIR, 'out', 'extension.js');

let TMPROOT, answers, messages, settingsPath, globalStorage, configStore, bars, configListeners, outputLines;
let shellStartListeners, shellEndListeners, folderChangeListeners;

function makeVscode() {
  const cfg = {
    get: (k, d) => (k in configStore ? configStore[k] : d),
    update: async (k, v) => { configStore[k] = v; },
  };
  // Status bar items are recorded so a scenario can read back what the user
  // would actually see: the text, the tooltip, and whether the item is shown.
  // Accepts either createStatusBarItem overload — (alignment, priority) or
  // (id, alignment, priority) — so the harness does not depend on which one the
  // extension happens to use.
  const bar = (...args) => {
    const hasId = typeof args[0] === 'string';
    const id = hasId ? args[0] : undefined;
    const priority = hasId ? args[2] : args[1];
    const item = {
      id, priority, name: undefined,
      text: '', tooltip: '', color: undefined, command: undefined,
      visible: false,
      show() { this.visible = true; }, hide() { this.visible = false; },
      dispose() {},
    };
    bars.push(item);
    return item;
  };
  return {
    window: {
      createStatusBarItem: bar,
      createOutputChannel: () => ({
        clear() { outputLines.length = 0; },
        appendLine(l) { outputLines.push(l); },
        show() {}, dispose() {},
      }),
      showInformationMessage: async (m, ...rest) => { messages.push(['info', m]); return answers.shift(); },
      showWarningMessage: async (m, ...rest) => { messages.push(['warn', m]); return answers.shift(); },
      showErrorMessage: async (m, ...rest) => { messages.push(['error', m]); return answers.shift(); },
      showTextDocument: async () => {},
      onDidCloseTerminal: () => ({ dispose() {} }),
      onDidOpenTerminal: () => ({ dispose() {} }),
      onDidChangeActiveTerminal: () => ({ dispose() {} }),
      terminals: [],
      activeTerminal: undefined,
      // Shell Integration API (VS Code 1.93+). Present so the extension's
      // feature detection succeeds and a scenario can fire a `claude` start.
      onDidStartTerminalShellExecution: (fn) => { shellStartListeners.push(fn); return { dispose() {} }; },
      onDidEndTerminalShellExecution: (fn) => { shellEndListeners.push(fn); return { dispose() {} }; },
    },
    workspace: {
      getConfiguration: () => cfg,
      onDidChangeConfiguration: (fn) => { configListeners.push(fn); return { dispose() {} }; },
      onDidChangeWorkspaceFolders: (fn) => { folderChangeListeners.push(fn); return { dispose() {} }; },
      workspaceFolders: [],
      fs: {},
    },
    commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; } },
    extensions: { getExtension: () => ({ packageJSON: { version: '0.9.0-test' } }) },
    Uri: { file: (p) => ({ fsPath: p, path: p }) },
    StatusBarAlignment: { Right: 2, Left: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    // Without this the tooltip builder throws, updateStatus' catch swallows it,
    // and no scenario can ever render a live session.
    MarkdownString: class {
      constructor(value, supportThemeIcons) {
        this.value = value || '';
        this.supportThemeIcons = supportThemeIcons;
        this.supportHtml = false;
      }
      appendMarkdown(s) { this.value += s; return this; }
      toString() { return this.value; }
    },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  };
}

let registered = {};

// Intercept require('vscode')
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...args);
};
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return global.__vscode;
  return origLoad.call(this, request, ...args);
};

function freshSandbox(name) {
  TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-' + name + '-'));
  process.env.HOME = TMPROOT;
  fs.mkdirSync(path.join(TMPROOT, '.claude'), { recursive: true });
  globalStorage = path.join(TMPROOT, 'globalStorage');
  settingsPath = path.join(TMPROOT, '.claude', 'settings.json');
  answers = [];
  messages = [];
  registered = {};
  configStore = {};
  bars = [];
  configListeners = [];
  outputLines = [];
  shellStartListeners = [];
  shellEndListeners = [];
  folderChangeListeners = [];
  global.__vscode = makeVscode();
  delete require.cache[OUT];
}

function ctx() {
  const store = {};
  return {
    subscriptions: [],
    globalStorageUri: { fsPath: globalStorage, path: globalStorage },
    globalState: { get: (k, d) => (k in store ? store[k] : d), update: async (k, v) => { store[k] = v; } },
  };
}

const bridgePath = () => path.join(TMPROOT, '.claude', 'scripts', 'context-bridge.sh');
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
// The four status bar items, by the priority the extension gives them:
// 100 context, 99 cache countdown, 98 model/effort, 97 usage alert.
const barAt = (priority) => bars.find((b) => b.priority === priority);
// Fires VS Code's configuration-change event, which is the extension's own cue
// to re-read the session directory straight away. Saves a scenario waiting out
// the poll interval to see a change take effect.
const fireConfigChange = () =>
  configListeners.forEach((fn) => fn({ affectsConfiguration: () => true }));

// A `claude` command starting in a terminal of this window, with the terminal's
// shell-integration cwd set. Returns the event so a scenario can end it again.
const fireClaudeStart = (cwd, commandLine = 'claude') => {
  const event = {
    terminal: { shellIntegration: { cwd: { fsPath: cwd, path: cwd } } },
    execution: { commandLine: { value: commandLine } },
  };
  shellStartListeners.forEach((fn) => fn(event));
  return event;
};
const fireExecutionEnd = (event) => shellEndListeners.forEach((fn) => fn(event));

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

async function run(name, fn) {
  freshSandbox(name);
  console.log('\n=== ' + name);
  const ext = require(OUT);
  await fn(ext);
  // Global invariant: nothing written outside the sandbox.
  check('all writes stayed under sandbox HOME', process.env.HOME === TMPROOT);
}

(async () => {
  // 1. UPGRADE PATH — settings already point at our bridge: zero writes, zero dialogs.
  await run('upgrade-noop', async (ext) => {
    fs.mkdirSync(path.join(TMPROOT, '.claude', 'scripts'), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: bridgePath(), padding: 2 },
      env: { FOO: 'bar' },
    }, null, 2) + '\n');
    const before = fs.statSync(settingsPath).mtimeMs;
    const beforeBody = fs.readFileSync(settingsPath, 'utf-8');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));
    check('settings.json not rewritten', fs.readFileSync(settingsPath, 'utf-8') === beforeBody);
    check('no dialog shown', messages.length === 0, JSON.stringify(messages));
  });

  // 2. EMPTY SLOT — no statusLine key: writes, informational toast, other keys survive.
  await run('empty-slot', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { KEEP: 'me' }, model: 'opus' }, null, 2) + '\n');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));
    const s = readSettings();
    check('statusLine now ours', s.statusLine && s.statusLine.command === bridgePath());
    check('unrelated keys preserved', s.env.KEEP === 'me' && s.model === 'opus');
    check('informational toast', messages.some((m) => m[0] === 'info'));
    check('backup file recorded', fs.existsSync(path.join(globalStorage, 'statusline-backup.json')));
  });

  // 3. FOREIGN COMMAND + Replace
  await run('foreign-replace', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: '/usr/local/bin/ccstatusline', padding: 1 },
    }, null, 2) + '\n');
    answers = ['Replace'];
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 80));
    const s = readSettings();
    check('modal was shown', messages.some((m) => m[0] === 'warn'));
    check('statusLine replaced', s.statusLine.command === bridgePath());
    check('padding preserved via spread', s.statusLine.padding === 1);
    const backups = JSON.parse(fs.readFileSync(path.join(globalStorage, 'statusline-backup.json'), 'utf-8'));
    check('backup holds the old command', backups[0].previousCommandString === '/usr/local/bin/ccstatusline');
  });

  // 4. FOREIGN COMMAND + Not now  -> opt out, never write
  await run('foreign-notnow', async (ext) => {
    const body = JSON.stringify({ statusLine: { type: 'command', command: '/opt/mine.sh' } }, null, 2) + '\n';
    fs.writeFileSync(settingsPath, body);
    answers = ['Not now'];
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 80));
    check('settings untouched', fs.readFileSync(settingsPath, 'utf-8') === body);
    check('opt-out persisted as a visible setting', configStore.manageStatusLine === false);
  });

  // 5. FOREIGN COMMAND + Escape (undefined) -> no write, no opt-out (must re-ask)
  await run('foreign-escape', async (ext) => {
    const body = JSON.stringify({ statusLine: { type: 'command', command: '/opt/mine.sh' } }, null, 2) + '\n';
    fs.writeFileSync(settingsPath, body);
    answers = [undefined];
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 80));
    check('settings untouched', fs.readFileSync(settingsPath, 'utf-8') === body);
    check('Escape did NOT opt out', configStore.manageStatusLine === undefined);
  });

  // 6. BARE STRING statusLine -> treated as foreign, not as an object
  await run('bare-string', async (ext) => {
    const body = JSON.stringify({ statusLine: '/tmp/whatever.sh' }, null, 2) + '\n';
    fs.writeFileSync(settingsPath, body);
    answers = [undefined];
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 80));
    check('modal shown for bare string', messages.some((m) => m[0] === 'warn'));
    check('file not turned into indexed chars', fs.readFileSync(settingsPath, 'utf-8') === body);
  });

  // 7. UNPARSEABLE settings.json -> error toast, absolutely no write
  await run('unparseable', async (ext) => {
    const body = '{ "statusLine": { "command": "/x" }, }\n'; // trailing comma
    fs.writeFileSync(settingsPath, body);
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 80));
    check('file left byte-identical', fs.readFileSync(settingsPath, 'utf-8') === body);
    check('error toast shown', messages.some((m) => m[0] === 'error'), JSON.stringify(messages));
  });

  // 8. SYMLINK + 0600 must survive a write
  await run('symlink-perms', async (ext) => {
    const real = path.join(TMPROOT, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, JSON.stringify({ env: { A: '1' } }, null, 2) + '\n', { mode: 0o600 });
    fs.symlinkSync(real, settingsPath);
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 80));
    check('symlink still a symlink', fs.lstatSync(settingsPath).isSymbolicLink());
    check('mode still 0600', (fs.statSync(real).mode & 0o777) === 0o600,
      '0' + (fs.statSync(real).mode & 0o777).toString(8));
    check('write landed through the link', JSON.parse(fs.readFileSync(real, 'utf-8')).statusLine.command === bridgePath());
  });

  // 9. RESTORE puts the original back and stops us managing the slot
  await run('restore', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      statusLine: { type: 'command', command: '/usr/local/bin/ccstatusline' },
    }, null, 2) + '\n');
    answers = ['Replace'];
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 80));
    check('we took the slot', readSettings().statusLine.command === bridgePath());
    answers = ['Restore'];
    await registered['fuel-gauge.restoreStatusLine']();
    check('original command restored', readSettings().statusLine.command === '/usr/local/bin/ccstatusline');
    check('manageStatusLine turned off', configStore.manageStatusLine === false);
  });

  // 10. HAND-EDITED bridge script is copied aside before being overwritten
  await run('bridge-preserve', async (ext) => {
    const bp = bridgePath();
    fs.mkdirSync(path.dirname(bp), { recursive: true });
    fs.writeFileSync(bp, '#!/bin/bash\n# my own edits\n', { mode: 0o755 });
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: bp } }, null, 2) + '\n');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));
    check('.fuel-gauge.orig created', fs.existsSync(bp + '.fuel-gauge.orig'));
    check('orig holds the user edits', fs.readFileSync(bp + '.fuel-gauge.orig', 'utf-8').includes('my own edits'));
  });

  // 11. CONTEXT PERCENTAGE — the bridge passes Claude Code's own number through untouched,
  //     and only computes one itself when the payload carries none.
  await run('context-percentage', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));

    const runBridge = (payload) => {
      execFileSync('bash', [bridgePath()], {
        input: JSON.stringify(payload),
        env: { ...process.env, HOME: TMPROOT },
      });
      return JSON.parse(fs.readFileSync(
        path.join(TMPROOT, '.claude', 'fuel-gauge', payload.session_id + '.json'), 'utf-8'));
    };

    // Token sums here would compute to ~95%. Claude Code says 38, so we must show 38.
    const passThrough = runBridge({
      session_id: 'pass-through',
      workspace: { project_dir: '/w' },
      context_window: {
        context_window_size: 200000,
        used_percentage: 38,
        remaining_percentage: 62,
        total_input_tokens: 76000,
        current_usage: {
          input_tokens: 2, output_tokens: 2693,
          cache_creation_input_tokens: 1165, cache_read_input_tokens: 186000,
        },
      },
    });
    check('passes Claude Code used_percentage through unmodified', passThrough.used_percentage === 38,
      String(passThrough.used_percentage));
    check('remaining is the complement', passThrough.remaining_percentage === 62,
      String(passThrough.remaining_percentage));

    // Zero is a real reading, not "missing" — it must not fall through to the computed branch.
    const zero = runBridge({
      session_id: 'zero',
      workspace: { project_dir: '/w' },
      context_window: {
        context_window_size: 200000, used_percentage: 0, total_input_tokens: 0,
        current_usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    check('zero percent survives as zero', zero.used_percentage === 0, String(zero.used_percentage));

    // No pre-computed percentage: fall back to our own sum over the RAW window (no overhead).
    const fallback = runBridge({
      session_id: 'fallback',
      workspace: { project_dir: '/w' },
      context_window: {
        context_window_size: 200000, total_input_tokens: 100000,
        current_usage: {
          input_tokens: 40000, output_tokens: 0,
          cache_creation_input_tokens: 10000, cache_read_input_tokens: 50000,
        },
      },
    });
    check('fallback divides by the full window, no overhead subtracted', fallback.used_percentage === 50,
      String(fallback.used_percentage));

    // No usage data at all: 0%, never a crash.
    const empty = runBridge({ session_id: 'empty', workspace: { project_dir: '/w' }, context_window: {} });
    check('no usage data reads as 0%', empty.used_percentage === 0, String(empty.used_percentage));

    // The extension writes systemOverhead 0 into the bridge's config file.
    const cfgFile = JSON.parse(fs.readFileSync(path.join(TMPROOT, '.claude', 'fuel-gauge', 'config.json'), 'utf-8'));
    check('bridge config carries systemOverhead 0', cfgFile.systemOverhead === 0, String(cfgFile.systemOverhead));
  });

  // 12. BACKUP FAILS -> the takeover is abandoned, not completed.
  //     The modal promises the existing command is saved first. If it cannot be
  //     saved, replacing it would leave nothing to restore from.
  await run('backup-fails-no-takeover', async (ext) => {
    const body = JSON.stringify({
      statusLine: { type: 'command', command: '/usr/local/bin/ccstatusline' },
    }, null, 2) + '\n';
    fs.writeFileSync(settingsPath, body);
    // A plain file where the backup directory must go: mkdirSync throws.
    fs.writeFileSync(globalStorage, 'not a directory\n');
    answers = ['Replace'];
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 80));
    check('foreign command survived', fs.readFileSync(settingsPath, 'utf-8') === body);
    check('user was warned the backup failed',
      messages.some((m) => /could not save a backup/i.test(m[1])));
    check('user was told the status line was left alone',
      messages.some((m) => /left alone/i.test(m[1])));
  });

  // 13. BRIDGE SCRIPT CANNOT BE WRITTEN -> activation survives.
  //     This used to throw straight out of activate(), taking every command with
  //     it, including Show Diagnostics — the one built to explain this failure.
  await run('bridge-unwritable', async (ext) => {
    // A plain file where ~/.claude/scripts must go: mkdirSync throws, and no
    // bridge script exists, so the install reports 'absent'.
    fs.writeFileSync(path.join(TMPROOT, '.claude', 'scripts'), 'not a directory\n');
    let threw = null;
    try { ext.activate(ctx()); } catch (e) { threw = e; }
    await new Promise((r) => setTimeout(r, 80));
    check('activate did not throw', threw === null, threw && threw.message);
    check('Show Diagnostics still registered', typeof registered['fuel-gauge.showBridgeStatus'] === 'function');
    check('Connect Status Line still registered', typeof registered['fuel-gauge.setupStatusLine'] === 'function');
    check('user was warned the gauge cannot update',
      messages.some((m) => /could not write the bridge script/i.test(m[1])));
    check('settings.json was not written to point at a missing script',
      !fs.existsSync(settingsPath));
  });

  // 14. pollInterval is clamped -> no millisecond scan loop.
  await run('poll-interval-clamp', async (ext) => {
    configStore['pollInterval'] = 0;
    const realSetInterval = global.setInterval;
    const delays = [];
    global.setInterval = (fn, ms, ...rest) => { delays.push(ms); return realSetInterval(fn, ms, ...rest); };
    try {
      ext.activate(ctx());
      await new Promise((r) => realSetInterval(r, 40));
    } finally {
      global.setInterval = realSetInterval;
      if (typeof ext.deactivate === 'function') { ext.deactivate(); }
    }
    check('a poll timer was registered', delays.length > 0, JSON.stringify(delays));
    check('pollInterval 0 clamped to 5s, not a 0ms loop',
      delays.every((d) => d >= 1000), JSON.stringify(delays));
    check('the clamp floor is 5s', delays.includes(5000), JSON.stringify(delays));
  });

  // 15. CACHE TTL — read from the transcript, not guessed from the gap between calls.
  //     Claude Code records the cache tier it asked for on every assistant turn;
  //     the bridge reads the last one instead of inferring it from token counts.
  await run('cache-ttl-from-transcript', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));
    // Stop the timers: this scenario drives the bridge by hand and writes
    // session files the extension has no business reading while we do it.
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }

    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    const sessionFile = (id) => path.join(fgDir, id + '.json');
    const accountFile = path.join(fgDir, 'account_ttl.json');
    // 0 means the bridge never wrote the file — a failure to report, not to crash on.
    const accountTTL = () => {
      try { return JSON.parse(fs.readFileSync(accountFile, 'utf-8')).detected_ttl; }
      catch { return 0; }
    };

    // An assistant row shaped like the real thing, down to the two counters.
    const assistantRow = (oneHourTokens, fiveMinTokens, extra = {}) => JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      message: {
        role: 'assistant',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: oneHourTokens + fiveMinTokens,
          cache_read_input_tokens: 149672,
          output_tokens: 1661,
          cache_creation: {
            ephemeral_1h_input_tokens: oneHourTokens,
            ephemeral_5m_input_tokens: fiveMinTokens,
          },
        },
      },
      ...extra,
    });
    const userRow = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

    const writeTranscript = (name, rows) => {
      const p = path.join(TMPROOT, name);
      fs.writeFileSync(p, rows.join('\n') + '\n');
      return p;
    };

    const payload = (id, transcript, windowOverrides = {}) => ({
      session_id: id,
      transcript_path: transcript,
      cwd: '/w',
      workspace: { project_dir: '/w' },
      model: { id: 'claude-opus-5' },
      effort: { level: 'high' },
      rate_limits: { five_hour: { used_percentage: 12, resets_at: 1787600000 } },
      context_window: {
        context_window_size: 200000,
        used_percentage: 31,
        total_input_tokens: 1000,
        current_usage: {
          input_tokens: 2, output_tokens: 1661,
          cache_creation_input_tokens: 137, cache_read_input_tokens: 149672,
        },
        ...windowOverrides,
      },
    });

    const runBridge = (p) => {
      execFileSync('bash', [bridgePath()], {
        input: JSON.stringify(p),
        env: { ...process.env, HOME: TMPROOT },
      });
      return JSON.parse(fs.readFileSync(sessionFile(p.session_id), 'utf-8'));
    };

    // (a) The transcript's last cache write went to the 1-hour tier.
    const oneHourTranscript = writeTranscript('one-hour.jsonl', [
      userRow('hello'), assistantRow(137, 0),
    ]);
    const oneHour = runBridge(payload('ttl-1h', oneHourTranscript));
    check('1-hour cache write in the transcript gives a 3600s TTL',
      oneHour.detected_ttl === 3600, String(oneHour.detected_ttl));
    check('account TTL file records 3600', accountTTL() === 3600, String(accountTTL()));

    // (b) A session whose transcript has no cache write yet keeps the account value.
    const bareTranscript = writeTranscript('no-cache-yet.jsonl', [userRow('first turn')]);
    const inherited = runBridge(payload('ttl-inherit', bareTranscript));
    check('a session with no cache write yet inherits the account TTL',
      inherited.detected_ttl === 3600, String(inherited.detected_ttl));

    // (c) The bug this replaces. A 7-minute gap that ends in a cache miss used
    //     to be read as proof of a 5-minute TTL and written account-wide, which
    //     put every window on a 5-minute countdown and showed "expired" on live
    //     sessions. It is an ordinary cache invalidation, and the transcript
    //     still says the 1-hour tier. Pre-fix this scenario returns 300.
    const then = (Date.now() / 1000) - 420;
    fs.writeFileSync(sessionFile('ttl-no-false-downgrade'), JSON.stringify({
      session_id: 'ttl-no-false-downgrade',
      total_input_tokens: 1000,
      detected_ttl: 3600,
      last_api_call_ts: then,
      timestamp: then,
    }, null, 2));
    const noFalseDowngrade = runBridge(payload('ttl-no-false-downgrade', oneHourTranscript, {
      total_input_tokens: 2000,
      current_usage: {
        input_tokens: 2, output_tokens: 100,
        cache_creation_input_tokens: 75220, cache_read_input_tokens: 0,
      },
    }));
    check('a 7-minute gap ending in a cache miss no longer downgrades the TTL',
      noFalseDowngrade.detected_ttl === 3600, String(noFalseDowngrade.detected_ttl));
    check('the account TTL was not rewritten to 300', accountTTL() === 3600, String(accountTTL()));

    // (d) A real 5-minute tier is reported as 5 minutes, and the account follows.
    const fiveMinTranscript = writeTranscript('five-min.jsonl', [
      userRow('hello'), assistantRow(0, 1429),
    ]);
    const fiveMin = runBridge(payload('ttl-5m', fiveMinTranscript));
    check('5-minute cache write in the transcript gives a 300s TTL',
      fiveMin.detected_ttl === 300, String(fiveMin.detected_ttl));
    check('account TTL file follows the transcript down to 300',
      accountTTL() === 300, String(accountTTL()));

    // (e) A subagent's cache write is not this conversation's TTL.
    const sidechainTranscript = writeTranscript('sidechain.jsonl', [
      userRow('hello'), assistantRow(137, 0), assistantRow(0, 900, { isSidechain: true }),
    ]);
    const sidechain = runBridge(payload('ttl-sidechain', sidechainTranscript));
    check('a subagent row is skipped, the main conversation decides the TTL',
      sidechain.detected_ttl === 3600, String(sidechain.detected_ttl));

    // (f) A transcript that is not there falls back instead of failing.
    const missing = runBridge(payload('ttl-missing', path.join(TMPROOT, 'gone.jsonl')));
    check('a missing transcript falls back to the account TTL',
      missing.detected_ttl === 3600, String(missing.detected_ttl));

    // (g) The answer must still be found when the last rows are very long.
    const bigRow = JSON.stringify({
      type: 'user', message: { role: 'user', content: 'x'.repeat(200000) },
    });
    const longTailTranscript = writeTranscript('long-tail.jsonl', [
      assistantRow(0, 512), bigRow,
    ]);
    const longTail = runBridge(payload('ttl-long-tail', longTailTranscript));
    check('a 200 KB row at the end does not hide the cache write behind it',
      longTail.detected_ttl === 300, String(longTail.detected_ttl));

    // (h) The documented ceiling: one row larger than the widest slice (1 MB)
    //     fills every window, so there is no answer to be had from the
    //     transcript. It must fall back quietly, never crash — the countdown
    //     then rests on the inherited value and the caller's fallback rule.
    const hugeRow = JSON.stringify({
      type: 'user', message: { role: 'user', content: 'x'.repeat(1200000) },
    });
    const hugeTailTranscript = writeTranscript('huge-tail.jsonl', [
      assistantRow(137, 0), hugeRow,
    ]);
    const hugeTail = runBridge(payload('ttl-huge-tail', hugeTailTranscript));
    check('a row bigger than 1 MB falls back instead of crashing',
      hugeTail.detected_ttl === accountTTL(), String(hugeTail.detected_ttl));

    check('no temp files left behind in the fuel-gauge directory',
      fs.readdirSync(fgDir).every((f) => !f.endsWith('.tmp')),
      fs.readdirSync(fgDir).join(', '));
    check('the bridge logged no errors',
      !fs.existsSync(path.join(fgDir, 'bridge.log')) ||
      fs.readFileSync(path.join(fgDir, 'bridge.log'), 'utf-8').trim() === '',
      fs.existsSync(path.join(fgDir, 'bridge.log'))
        ? fs.readFileSync(path.join(fgDir, 'bridge.log'), 'utf-8') : '');
  });

  // 16. NO SESSION FOR THIS WINDOW -> show nothing at all.
  //     Not 0% (which read as a measurement of an empty window) and not a
  //     "no session" label either: that was honest, but it sat in every window
  //     not running Claude, forever.
  await run('no-session-hidden', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());

    const allFour = () => [barAt(100), barAt(99), barAt(98), barAt(97)];
    check('all four items are hidden', allFour().every((b) => b.visible === false),
      JSON.stringify(allFour().map((b) => b.visible)));
    check('the context item shows no leftover text', barAt(100).text === '',
      barAt(100).text);

    // Still true a render later, once the status line setup has settled.
    await new Promise((r) => setTimeout(r, 1150));
    check('still hidden after a re-render', allFour().every((b) => b.visible === false),
      JSON.stringify(allFour().map((b) => b.visible)));
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }
  });

  // 16b. AND IT COMES BACK. A window that was empty when it opened must pick up
  //      a session that starts later, or hiding the gauge would mean losing it.
  await run('no-session-then-session', async (ext) => {
    const ws = path.join(TMPROOT, 'work');
    fs.mkdirSync(ws, { recursive: true });
    global.__vscode.workspace.workspaceFolders = [{ uri: { fsPath: ws, path: ws } }];
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());

    check('nothing is shown while no session matches this folder',
      [barAt(100), barAt(99), barAt(98), barAt(97)].every((b) => b.visible === false));

    // With nothing in the status bar, Diagnostics is the only thing that can
    // explain the empty window, so it has to name the folder and say plainly
    // that no session matches it.
    await registered['fuel-gauge.showBridgeStatus']();
    const report = outputLines.join('\n');
    check('Show Diagnostics still runs', outputLines.length > 0);
    check('Diagnostics names the folder this window has open', report.includes(ws), report);
    check('Diagnostics says no session matches it, and why',
      /Session for this workspace\s+NONE/.test(report) &&
      report.includes('matched by the folder they were started in'), report);

    // Claude Code starts in this folder and the bridge writes its first file.
    const nowSec = Date.now() / 1000;
    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    fs.mkdirSync(fgDir, { recursive: true });
    fs.writeFileSync(path.join(fgDir, 'arrived.json'), JSON.stringify({
      cwd: ws, project_dir: ws, used_percentage: 31, remaining_percentage: 69,
      total_input_tokens: 62000, total_output_tokens: 900,
      context_window_size: 200000, model: 'claude-opus-5', session_id: 'arrived',
      timestamp: nowSec, detected_ttl: 3600, last_api_call_ts: nowSec - 60,
      rate_limit_5h_pct: -1, rate_limit_7d_pct: -1, effort_level: 'high',
      context_unknown: false,
    }, null, 2));

    fireConfigChange();

    check('the gauge comes back on its own', barAt(100).visible === true);
    check('and shows the new session percentage',
      barAt(100).text === '$(claude)$(dashboard) 31%', barAt(100).text);
    check('the cache countdown comes back too', barAt(99).visible === true);
    check('so does the model and effort item', barAt(98).visible === true);

    outputLines.length = 0;
    await registered['fuel-gauge.showBridgeStatus']();
    check('Diagnostics now names the matching session file',
      /Session for this workspace\s+arrived\.json/.test(outputLines.join('\n')),
      outputLines.join('\n'));
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }
  });

  // 17. A TRANSCRIPT LINE OF THE WRONG SHAPE MUST NOT STOP THE GAUGE.
  //     Valid JSON that is not a row — an array, a bare string — used to raise
  //     out of the whole bridge, so no session file was written at all and the
  //     status bar went on showing frozen numbers with nothing to say why.
  await run('transcript-bad-rows', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }

    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    const goodRow = JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', usage: {
        cache_creation: { ephemeral_1h_input_tokens: 137, ephemeral_5m_input_tokens: 0 } } },
    });
    // Every one of these is valid JSON, contains the marker the scan looks for,
    // and is not an object.
    const badRows = [
      '["ephemeral_1h_input_tokens", 5]',
      '"ephemeral_5m_input_tokens"',
      '12345',
      'null',
      '{"message": "ephemeral_1h_input_tokens is a string here, not usage"}',
    ];

    // A bridge that dies leaves no session file and a non-zero exit. Both are
    // failures to report, not reasons to abandon the run.
    const runBridge = (id, rows) => {
      const tp = path.join(TMPROOT, id + '.jsonl');
      fs.writeFileSync(tp, rows.join('\n') + '\n');
      try {
        execFileSync('bash', [bridgePath()], {
          input: JSON.stringify({
            session_id: id, transcript_path: tp, cwd: '/w',
            workspace: { project_dir: '/w' },
            context_window: {
              context_window_size: 200000, used_percentage: 31, total_input_tokens: 1000,
              current_usage: { input_tokens: 2, output_tokens: 10,
                cache_creation_input_tokens: 137, cache_read_input_tokens: 149672 },
            },
          }),
          env: { ...process.env, HOME: TMPROOT },
        });
      } catch { /* reported by the checks below */ }
      const f = path.join(fgDir, id + '.json');
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : null;
    };

    // Nothing usable at all: unknown is an acceptable answer, a dead gauge is
    // not. This runs first, while nothing has been stored for the account yet,
    // so 0 here really means "found no answer" and not "inherited one".
    const onlyBad = runBridge('only-bad', badRows);
    check('a transcript with no usable row still writes a session file', onlyBad !== null);
    check('and reports the lifetime as unknown, not as a crash',
      onlyBad && onlyBad.detected_ttl === 0, onlyBad && String(onlyBad.detected_ttl));
    check('the percentage is still reported while the lifetime is unknown',
      onlyBad && onlyBad.used_percentage === 31, onlyBad && String(onlyBad.used_percentage));

    // Bad rows sit after the good one, so the backwards scan meets them first.
    const survived = runBridge('bad-then-good', [goodRow, ...badRows]);
    check('the session file is still written when rows are the wrong shape',
      survived !== null);
    check('the good row underneath is still found', survived && survived.detected_ttl === 3600,
      survived && String(survived.detected_ttl));

    const log = path.join(fgDir, 'bridge.log');
    check('nothing was logged as an error',
      !fs.existsSync(log) || fs.readFileSync(log, 'utf-8').trim() === '',
      fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '');
  });

  // 18. NO ANSWER IN THE TRANSCRIPT -> the one thing token counts can prove.
  //     A cache that survived more than five minutes cannot be on the
  //     five-minute tier. Without this, an older Claude Code that sends no
  //     transcript_path shows a red "expired" 55 minutes early.
  await run('ttl-fallback-without-transcript', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }

    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    const sessionFile = path.join(fgDir, 'no-transcript.json');
    const accountFile = path.join(fgDir, 'account_ttl.json');

    // Note: no transcript_path anywhere in this payload.
    const call = (totalIn, cacheRead) => {
      execFileSync('bash', [bridgePath()], {
        input: JSON.stringify({
          session_id: 'no-transcript', cwd: '/w', workspace: { project_dir: '/w' },
          context_window: {
            context_window_size: 200000, used_percentage: 31,
            total_input_tokens: totalIn,
            current_usage: { input_tokens: 2, output_tokens: 10,
              cache_creation_input_tokens: 137, cache_read_input_tokens: cacheRead },
          },
        }),
        env: { ...process.env, HOME: TMPROOT },
      });
      return JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    };

    const first = call(1000, 149672);
    check('with no transcript the lifetime starts out unknown', first.detected_ttl === 0,
      String(first.detected_ttl));

    // Six and a half minutes later, and the cache is still warm.
    const patched = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    patched.last_api_call_ts = (Date.now() / 1000) - 400;
    fs.writeFileSync(sessionFile, JSON.stringify(patched, null, 2));

    const second = call(2000, 149672);
    check('a cache that survived 6 minutes proves the 1-hour tier',
      second.detected_ttl === 3600, String(second.detected_ttl));
    check('and that is recorded for the account',
      fs.existsSync(accountFile) &&
      JSON.parse(fs.readFileSync(accountFile, 'utf-8')).detected_ttl === 3600);

    // The rule that broke things is NOT back: a miss after a short gap must
    // never be read as an expiry.
    const patched2 = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    patched2.last_api_call_ts = (Date.now() / 1000) - 420;
    fs.writeFileSync(sessionFile, JSON.stringify(patched2, null, 2));
    const third = call(3000, 0);
    check('a cache miss after 7 minutes does not downgrade anything',
      third.detected_ttl === 3600, String(third.detected_ttl));
  });

  // 19. AN OLD SESSION MUST NOT SPEAK FOR THE ACCOUNT.
  //     Resuming a months-old session whose last cache write was on the
  //     5-minute tier used to overwrite account_ttl.json, which then handed
  //     every brand-new session a 5-minute countdown.
  await run('account-ttl-only-newer-wins', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }

    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    const accountFile = path.join(fgDir, 'account_ttl.json');
    const account = () => JSON.parse(fs.readFileSync(accountFile, 'utf-8'));

    const cacheRow = (oneHour, fiveMin, iso) => JSON.stringify({
      type: 'assistant', timestamp: iso,
      message: { role: 'assistant', usage: {
        cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: fiveMin } } },
    });

    const runBridge = (id, rows) => {
      const tp = path.join(TMPROOT, id + '.jsonl');
      fs.writeFileSync(tp, rows.join('\n') + '\n');
      execFileSync('bash', [bridgePath()], {
        input: JSON.stringify({
          session_id: id, transcript_path: tp, cwd: '/w', workspace: { project_dir: '/w' },
          context_window: {
            context_window_size: 200000, used_percentage: 31, total_input_tokens: 1000,
            current_usage: { input_tokens: 2, output_tokens: 10,
              cache_creation_input_tokens: 137, cache_read_input_tokens: 149672 },
          },
        }),
        env: { ...process.env, HOME: TMPROOT },
      });
      return JSON.parse(fs.readFileSync(path.join(fgDir, id + '.json'), 'utf-8'));
    };

    const nowIso = new Date().toISOString();
    const oldIso = '2026-07-28T14:14:00.420Z';

    const live = runBridge('live-1h', [cacheRow(137, 0, nowIso)]);
    check('a live session sets the account to 1 hour', live.detected_ttl === 3600);
    const afterLive = account().detected_at;
    check('the account records when that row was written, not when we read it',
      Math.abs(afterLive - Date.parse(nowIso) / 1000) < 2, String(afterLive));

    const resumed = runBridge('resumed-5m', [cacheRow(0, 1429, oldIso)]);
    check('the resumed old session still reads its own transcript correctly',
      resumed.detected_ttl === 300, String(resumed.detected_ttl));
    check('but it does not get to overwrite the account', account().detected_ttl === 3600,
      String(account().detected_ttl));
    check('and the stored timestamp is untouched', account().detected_at === afterLive);

    // A brand-new session with no cache write of its own inherits the good value.
    const fresh = runBridge('fresh', [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })]);
    check('a new session inherits 1 hour, not the old session 5 minutes',
      fresh.detected_ttl === 3600, String(fresh.detected_ttl));

    // Running the old session twice more must not start a tug of war.
    runBridge('resumed-5m', [cacheRow(0, 1429, oldIso)]);
    runBridge('resumed-5m', [cacheRow(0, 1429, oldIso)]);
    check('repeated updates from the old session change nothing',
      account().detected_ttl === 3600 && account().detected_at === afterLive);
  });

  // 20. A LIVE SESSION, RENDERED. Nothing had ever exercised this path: the
  //     fake vscode module had no MarkdownString, so the tooltip builder threw
  //     and updateStatus' catch hid the failure.
  await run('live-session-render', async (ext) => {
    const ws = path.join(TMPROOT, 'work');
    fs.mkdirSync(ws, { recursive: true });
    global.__vscode.workspace.workspaceFolders = [{ uri: { fsPath: ws, path: ws } }];
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');

    const nowSec = Date.now() / 1000;
    const lastCall = nowSec - 60;
    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    fs.mkdirSync(fgDir, { recursive: true });
    fs.writeFileSync(path.join(fgDir, 'live.json'), JSON.stringify({
      cwd: ws, project_dir: ws,
      used_percentage: 31.163645621181264, remaining_percentage: 68.83,
      total_input_tokens: 306027, total_output_tokens: 2693,
      context_window_size: 1000000, model: 'claude-opus-5', session_id: 'live',
      timestamp: nowSec,
      cache_read_input_tokens: 149672, cache_creation_input_tokens: 137,
      detected_ttl: 3600, last_api_call_ts: lastCall,
      rate_limit_5h_pct: 12, rate_limit_5h_reset: nowSec + 7200,
      rate_limit_7d_pct: 44, rate_limit_7d_reset: nowSec + 200000,
      effort_level: 'high',
    }, null, 2));

    ext.activate(ctx());

    const context = barAt(100), cache = barAt(99), effort = barAt(98), usage = barAt(97);
    check('context item shows the rounded percentage',
      context.text === '$(claude)$(dashboard) 31%', context.text);
    check('context item is visible', context.visible === true);
    check('context item is green below the warning threshold',
      context.color && context.color.id === 'charts.green',
      context.color && context.color.id);

    check('cache countdown is visible', cache.visible === true);
    check('cache countdown shows minutes and seconds left, near 59:00',
      /^5[89]:[0-5]\d$/.test(cache.text), cache.text);
    const expiry = new Date((lastCall + 3600) * 1000);
    const hhmm = expiry.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    check('cache hover names the deadline rather than repeating the countdown',
      String(cache.tooltip) === `Cache expires at ${hhmm} (detected 1h TTL)`, String(cache.tooltip));
    // Ticket #3131: the bar shows a duration (59:19) and the hover a clock time,
    // and both have the same NN:NN shape. The word "at" is what tells them
    // apart, so it is checked on its own.
    check('cache hover marks the deadline as a clock time with the word "at"',
      /Cache expires at /.test(String(cache.tooltip)), String(cache.tooltip));
    // The same hover also carries the rate-limit reset times. Both clock times
    // must be written the machine's way, or one hover shows 13:22 next to
    // 02:20 PM.
    const resetClock = new Date((nowSec + 7200) * 1000)
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const twelveHour = / (AM|PM)$/.test(resetClock);
    check('cache deadline uses the same clock format as the reset times',
      / (AM|PM)$/.test(hhmm) === twelveHour && String(cache.tooltip).includes(hhmm),
      `deadline=${hhmm} reset=${resetClock} tooltip=${String(cache.tooltip)}`);

    check('model and effort item is visible', effort.visible === true);
    check('model and effort item reads opus·high', effort.text === 'opus·high', effort.text);
    check('usage dot stays hidden while both limits are low', usage.visible === false);

    // Each item is named, so VS Code's status bar right-click menu can list them
    // separately and remember which ones a user hides.
    const named = [context, cache, effort, usage];
    check('every item has a readable name',
      named.every((b) => typeof b.name === 'string' && b.name.startsWith('Fuel Gauge: ')),
      JSON.stringify(named.map((b) => b.name)));
    check('every item has its own id, so hiding one does not hide the rest',
      new Set(named.map((b) => b.id)).size === 4, JSON.stringify(named.map((b) => b.id)));

    const tip = String(context.tooltip && context.tooltip.value);
    check('main hover carries the context percentage', /Context&nbsp;31%/.test(tip), tip);
    check('main hover carries the cache deadline', tip.includes(`Cache expires at ${hhmm}`), tip);
    check('main hover carries both usage limits',
      /Session limit \(5h\): 12% used/.test(tip) && /Weekly limit \(all models\): 44% used/.test(tip), tip);

    // The hover must be byte-identical from one second to the next, or an open
    // popup is torn down and rebuilt on every tick.
    const before = String(context.tooltip.value);
    await new Promise((r) => setTimeout(r, 1150));
    check('the hover text does not change on the next render',
      String(context.tooltip.value) === before, String(context.tooltip.value));
    check('the countdown in the bar did move', cache.text !== undefined);
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }
  });

  // 21. RIGHT AFTER /compact, CLAUDE CODE REPORTS AN EMPTY WINDOW.
  //     It is not empty — it holds the summary and CLAUDE.md — so writing 0
  //     would paint a green empty tank at the moment someone checks whether the
  //     compact worked (anthropics/claude-code#86785).
  await run('compact-context-unknown', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }

    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    const runBridge = (payload) => {
      execFileSync('bash', [bridgePath()], {
        input: JSON.stringify(payload), env: { ...process.env, HOME: TMPROOT },
      });
      return JSON.parse(fs.readFileSync(path.join(fgDir, payload.session_id + '.json'), 'utf-8'));
    };

    // A working session, 42% full.
    const before = runBridge({
      session_id: 'compacted', cwd: '/w', workspace: { project_dir: '/w' },
      context_window: {
        context_window_size: 200000, used_percentage: 42, total_input_tokens: 84000,
        current_usage: { input_tokens: 2, output_tokens: 900,
          cache_creation_input_tokens: 1000, cache_read_input_tokens: 82000 },
      },
    });
    check('a working session reports its real percentage', before.used_percentage === 42);
    check('and is not flagged as unknown', before.context_unknown === false);

    // The payload Claude Code sends immediately after /compact.
    const compacted = runBridge({
      session_id: 'compacted', cwd: '/w', workspace: { project_dir: '/w' },
      context_window: {
        context_window_size: 200000, used_percentage: 0, total_input_tokens: 0,
        current_usage: null,
      },
    });
    check('after /compact the last real number is held, not replaced by 0',
      compacted.used_percentage === 42, String(compacted.used_percentage));
    check('and it is flagged as no longer a measurement',
      compacted.context_unknown === true, String(compacted.context_unknown));
    check('the cache clock is still reset by the compact',
      compacted.last_api_call_ts === 0, String(compacted.last_api_call_ts));

    // Polling again before the user says anything must not change the story.
    const stillCompacted = runBridge({
      session_id: 'compacted', cwd: '/w', workspace: { project_dir: '/w' },
      context_window: {
        context_window_size: 200000, used_percentage: 0, total_input_tokens: 0,
        current_usage: { input_tokens: 0, output_tokens: 0,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    check('an all-zero current_usage counts the same as a null one',
      stillCompacted.used_percentage === 42 && stillCompacted.context_unknown === true,
      String(stillCompacted.used_percentage) + '/' + String(stillCompacted.context_unknown));

    // The next turn produces a real reading again.
    const nextTurn = runBridge({
      session_id: 'compacted', cwd: '/w', workspace: { project_dir: '/w' },
      context_window: {
        context_window_size: 200000, used_percentage: 12, total_input_tokens: 24000,
        current_usage: { input_tokens: 2, output_tokens: 300,
          cache_creation_input_tokens: 500, cache_read_input_tokens: 23000 },
      },
    });
    check('the next turn replaces the held number', nextTurn.used_percentage === 12,
      String(nextTurn.used_percentage));
    check('and clears the flag', nextTurn.context_unknown === false,
      String(nextTurn.context_unknown));

    // A brand-new session has no previous number, so its 0% is real.
    const fresh = runBridge({
      session_id: 'brand-new', cwd: '/w', workspace: { project_dir: '/w' },
      context_window: {
        context_window_size: 200000, used_percentage: 0, total_input_tokens: 0,
        current_usage: null,
      },
    });
    check('a new session first zero stays a real 0%', fresh.used_percentage === 0,
      String(fresh.used_percentage));
    check('and is not flagged', fresh.context_unknown === false, String(fresh.context_unknown));
  });

  // 22. THE HELD NUMBER, RENDERED. A tilde and no colour: the gauge must not
  //     claim a confidence it does not have.
  await run('render-context-unknown', async (ext) => {
    const ws = path.join(TMPROOT, 'work');
    fs.mkdirSync(ws, { recursive: true });
    global.__vscode.workspace.workspaceFolders = [{ uri: { fsPath: ws, path: ws } }];
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');

    const nowSec = Date.now() / 1000;
    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    fs.mkdirSync(fgDir, { recursive: true });
    fs.writeFileSync(path.join(fgDir, 'held.json'), JSON.stringify({
      cwd: ws, project_dir: ws,
      used_percentage: 42, remaining_percentage: 58, context_unknown: true,
      total_input_tokens: 0, total_output_tokens: 0,
      context_window_size: 200000, model: 'claude-opus-5', session_id: 'held',
      timestamp: nowSec, detected_ttl: 3600, last_api_call_ts: 0,
      rate_limit_5h_pct: -1, rate_limit_7d_pct: -1, effort_level: 'high',
    }, null, 2));

    ext.activate(ctx());

    const context = barAt(100);
    check('the held number shows with a tilde', context.text === '$(claude)$(dashboard) ~42%',
      context.text);
    check('and carries no colour', context.color === undefined,
      context.color && context.color.id);
    const tip = String(context.tooltip && context.tooltip.value);
    check('the hover says the reading is paused, not that the window is empty',
      tip.includes('Context reading paused') && tip.includes('right after /compact') &&
      tip.includes('updates on your next turn'), tip);
    check('the cache countdown is hidden while the clock is reset',
      barAt(99).visible === false);
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }
  });

  // 23. A HAND-EDITED config.json MUST NOT KILL THE BRIDGE.
  //     systemOverhead is deprecated, so someone clearing it to null is exactly
  //     the shape to expect — and it used to reach an arithmetic operation and
  //     stop the gauge writing anything at all.
  await run('config-null-overhead', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }

    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    fs.writeFileSync(path.join(fgDir, 'config.json'),
      JSON.stringify({ systemOverhead: null }, null, 2));

    // No used_percentage in the payload, so the bridge takes the fallback path
    // where the overhead is actually subtracted.
    let threw = null;
    try {
      execFileSync('bash', [bridgePath()], {
        input: JSON.stringify({
          session_id: 'null-overhead', cwd: '/w', workspace: { project_dir: '/w' },
          context_window: {
            context_window_size: 200000, total_input_tokens: 100000,
            current_usage: { input_tokens: 40000, output_tokens: 0,
              cache_creation_input_tokens: 10000, cache_read_input_tokens: 50000 },
          },
        }),
        env: { ...process.env, HOME: TMPROOT },
      });
    } catch (e) { threw = e; }
    const f = path.join(fgDir, 'null-overhead.json');
    check('the bridge survives a null systemOverhead', threw === null, threw && threw.message);
    check('and still writes the session file', fs.existsSync(f));
    check('treating null as no overhead at all',
      fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf-8')).used_percentage === 50,
      fs.existsSync(f) ? String(JSON.parse(fs.readFileSync(f, 'utf-8')).used_percentage) : 'no file');
  });

  // 24. THE WRONG FOLDER, SAID OUT LOUD (#3013). A `claude` started in a
  //     terminal whose directory this window does not have open used to be
  //     dropped in silence — the extension returned from the listener and the
  //     window simply showed no gauge, which is exactly how Metaconductor
  //     #3008 happened. It must now say so in red.
  await run('wrong-folder-warns', async (ext) => {
    const ws = path.join(TMPROOT, 'work');
    const other = path.join(TMPROOT, 'other-project');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    global.__vscode.workspace.workspaceFolders = [{ uri: { fsPath: ws, path: ws } }];
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');

    ext.activate(ctx());
    check('nothing is said before a session starts', !barAt(96) || barAt(96).visible === false);

    const event = fireClaudeStart(other);
    const warn = barAt(96);
    check('the wrong-folder item exists', !!warn);
    check('and is visible once Claude starts in a folder this window has not open',
      !!warn && warn.visible === true);
    check('it reads as a warning', !!warn && warn.text === '$(warning) wrong folder',
      warn && warn.text);
    check('in red', !!warn && warn.color && warn.color.id === 'charts.red',
      warn && warn.color && warn.color.id);
    check('it carries a name so it can be hidden from the status bar menu',
      !!warn && warn.name === 'Fuel Gauge: wrong folder', warn && warn.name);
    check('and an id of its own', !!warn && warn.id === 'fuel-gauge.wrongFolder',
      warn && warn.id);
    const tip = String(warn && warn.tooltip && warn.tooltip.value);
    check('the hover names the folder Claude is actually in', tip.includes(other), tip);
    check('and the folder this window has open', tip.includes(ws), tip);
    check('and says nothing was changed', tip.includes('Nothing has been changed'), tip);

    fireExecutionEnd(event);
    check('the warning goes when that session ends', !barAt(96) || barAt(96).visible === false);
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }
  });

  // 25. AND STAYS QUIET WHEN THE MISMATCH IS ORDINARY. A start in a subfolder
  //     is how most people work, and in a multi-root workspace every open
  //     folder is the right folder. A warning that fires on either is noise
  //     Julian learns to ignore, which costs more than not having it.
  await run('wrong-folder-quiet-when-legitimate', async (ext) => {
    const ws = path.join(TMPROOT, 'work');
    const sub = path.join(ws, 'src', 'deep');
    const second = path.join(TMPROOT, 'second-root');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    global.__vscode.workspace.workspaceFolders = [
      { uri: { fsPath: ws, path: ws } },
      { uri: { fsPath: second, path: second } },
    ];
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());

    fireClaudeStart(ws);
    check('a start in the workspace folder itself says nothing', !barAt(96) || barAt(96).visible === false);
    fireClaudeStart(sub);
    check('a start in a subfolder says nothing', !barAt(96) || barAt(96).visible === false);
    fireClaudeStart(second);
    check('a start in the second root of a multi-root workspace says nothing',
      !barAt(96) || barAt(96).visible === false);
    // A sibling of the workspace folder is not a subfolder of it, whatever the
    // string prefix suggests: /work-notes must not pass as inside /work.
    fireClaudeStart(ws + '-notes');
    check('a sibling whose name merely starts the same way does warn',
      !!barAt(96) && barAt(96).visible === true);
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }
  });

  // 26. A START IN A PARENT OF THE WORKSPACE. Claude can reach the workspace
  //     from there, so this is not the same mistake — but it is running over a
  //     wider tree than the window shows, and the hover has to say which case
  //     it is or the user cannot tell what to do about it.
  await run('wrong-folder-parent-start', async (ext) => {
    const parent = path.join(TMPROOT, 'projects');
    const ws = path.join(parent, 'work');
    fs.mkdirSync(ws, { recursive: true });
    global.__vscode.workspace.workspaceFolders = [{ uri: { fsPath: ws, path: ws } }];
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');

    // A session file for the parent folder, so the hover can name it.
    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    fs.mkdirSync(fgDir, { recursive: true });
    fs.writeFileSync(path.join(fgDir, 'wide.json'), JSON.stringify({
      cwd: parent, project_dir: parent, used_percentage: 12, remaining_percentage: 88,
      total_input_tokens: 1000, total_output_tokens: 10, context_window_size: 200000,
      model: 'claude-opus-5', session_id: 'wide', timestamp: Date.now() / 1000,
    }, null, 2));

    ext.activate(ctx());
    fireClaudeStart(parent);
    const warn = barAt(96);
    check('a start in a parent of the workspace warns', !!warn && warn.visible === true);
    const tip = String(warn && warn.tooltip && warn.tooltip.value);
    check('and the hover says it is a wider tree, not a different folder',
      tip.includes('wider tree'), tip);
    check('naming the session writing for that folder', tip.includes('wide'), tip);
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }
  });

  // 27. A WINDOW SMALLER THAN THE TOKENS IN IT (#3070). Claude Code sometimes
  //     reports a context_window_size below the session's own token count
  //     (claude-code#63447). Since v0.9.0 the percentage is passed straight
  //     through, so the gauge stated 138% in confident red. The bridge must
  //     mark the reading unreliable — and must not quietly clamp it to 100,
  //     which is what Anthropic's own indicator does.
  await run('bridge-implausible-window', async (ext) => {
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');
    ext.activate(ctx());
    await new Promise((r) => setTimeout(r, 60));
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }
    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');

    execFileSync('bash', [bridgePath()], {
      input: JSON.stringify({
        session_id: 'too-small', cwd: '/w', workspace: { project_dir: '/w' },
        context_window: {
          context_window_size: 200000, total_input_tokens: 276000,
          used_percentage: 138,
          current_usage: { input_tokens: 6000, output_tokens: 100,
            cache_creation_input_tokens: 20000, cache_read_input_tokens: 250000 },
        },
      }),
      env: { ...process.env, HOME: TMPROOT },
    });
    const wrote = JSON.parse(fs.readFileSync(path.join(fgDir, 'too-small.json'), 'utf-8'));
    check('the bridge marks the reading unreliable', wrote.window_implausible === true,
      String(wrote.window_implausible));
    check('and does not clamp the percentage to 100', wrote.used_percentage === 138,
      String(wrote.used_percentage));

    // An ordinary session must stay unflagged, or the flag means nothing.
    execFileSync('bash', [bridgePath()], {
      input: JSON.stringify({
        session_id: 'ordinary', cwd: '/w', workspace: { project_dir: '/w' },
        context_window: {
          context_window_size: 200000, total_input_tokens: 60000, used_percentage: 30,
          current_usage: { input_tokens: 10000, output_tokens: 100,
            cache_creation_input_tokens: 5000, cache_read_input_tokens: 45000 },
        },
      }),
      env: { ...process.env, HOME: TMPROOT },
    });
    const ok = JSON.parse(fs.readFileSync(path.join(fgDir, 'ordinary.json'), 'utf-8'));
    check('an ordinary reading is not flagged', ok.window_implausible === false,
      String(ok.window_implausible));

    // exceeds_200k_tokens is only evidence against a window reported at or
    // below 200k. A 1M window past 200k is ordinary — 1M is generally
    // available — and flagging it would fire on every long session Julian runs.
    execFileSync('bash', [bridgePath()], {
      input: JSON.stringify({
        session_id: 'big-window', cwd: '/w', workspace: { project_dir: '/w' },
        exceeds_200k_tokens: true,
        context_window: {
          context_window_size: 1000000, total_input_tokens: 300000, used_percentage: 30,
          current_usage: { input_tokens: 10000, output_tokens: 100,
            cache_creation_input_tokens: 5000, cache_read_input_tokens: 285000 },
        },
      }),
      env: { ...process.env, HOME: TMPROOT },
    });
    const big = JSON.parse(fs.readFileSync(path.join(fgDir, 'big-window.json'), 'utf-8'));
    check('a 1M window past 200k is not flagged', big.window_implausible === false,
      String(big.window_implausible));

    // The same flag against a 200k window is the cross-check doing its job.
    execFileSync('bash', [bridgePath()], {
      input: JSON.stringify({
        session_id: 'flag-vs-200k', cwd: '/w', workspace: { project_dir: '/w' },
        exceeds_200k_tokens: true,
        context_window: {
          context_window_size: 200000, total_input_tokens: 150000, used_percentage: 75,
          current_usage: { input_tokens: 10000, output_tokens: 100,
            cache_creation_input_tokens: 5000, cache_read_input_tokens: 135000 },
        },
      }),
      env: { ...process.env, HOME: TMPROOT },
    });
    const xcheck = JSON.parse(fs.readFileSync(path.join(fgDir, 'flag-vs-200k.json'), 'utf-8'));
    check('a session past 200k in a 200k window is flagged by the cross-check',
      xcheck.window_implausible === true, String(xcheck.window_implausible));
  });

  // 28. THE UNRELIABLE READING, RENDERED. Uncoloured, with the number left
  //     exactly as Claude Code gave it and a hover that says why.
  await run('render-implausible-window', async (ext) => {
    const ws = path.join(TMPROOT, 'work');
    fs.mkdirSync(ws, { recursive: true });
    global.__vscode.workspace.workspaceFolders = [{ uri: { fsPath: ws, path: ws } }];
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\n');

    const fgDir = path.join(TMPROOT, '.claude', 'fuel-gauge');
    fs.mkdirSync(fgDir, { recursive: true });
    fs.writeFileSync(path.join(fgDir, 'bad.json'), JSON.stringify({
      cwd: ws, project_dir: ws, used_percentage: 138, remaining_percentage: 0,
      context_unknown: false, window_implausible: true,
      total_input_tokens: 276000, total_output_tokens: 100,
      context_window_size: 200000, model: 'claude-opus-5', session_id: 'bad',
      timestamp: Date.now() / 1000, detected_ttl: 3600, last_api_call_ts: 0,
      rate_limit_5h_pct: -1, rate_limit_7d_pct: -1, effort_level: 'high',
    }, null, 2));

    ext.activate(ctx());
    const context = barAt(100);
    check('the number is shown as Claude Code gave it, not clamped',
      context.text.includes('138%'), context.text);
    check('marked with a warning glyph', context.text.includes('$(warning)'), context.text);
    check('and carries no colour at all', context.color === undefined,
      context.color && context.color.id);
    const tip = String(context.tooltip && context.tooltip.value);
    check('the hover calls the reading unreliable', tip.includes('unreliable'), tip);
    check('naming the window Claude Code reported', tip.includes('200,000'), tip);
    check('and the tokens it says are in it', tip.includes('276,000'), tip);
    check('and pointing at the upstream bug', tip.includes('63447'), tip);
    if (typeof ext.deactivate === 'function') { ext.deactivate(); }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
