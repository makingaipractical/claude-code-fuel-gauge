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

let TMPROOT, answers, messages, settingsPath, globalStorage, configStore;

function makeVscode() {
  const cfg = {
    get: (k, d) => (k in configStore ? configStore[k] : d),
    update: async (k, v) => { configStore[k] = v; },
  };
  const bar = () => ({
    text: '', tooltip: '', color: undefined, command: undefined,
    show() {}, hide() {}, dispose() {},
  });
  return {
    window: {
      createStatusBarItem: bar,
      createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} }),
      showInformationMessage: async (m, ...rest) => { messages.push(['info', m]); return answers.shift(); },
      showWarningMessage: async (m, ...rest) => { messages.push(['warn', m]); return answers.shift(); },
      showErrorMessage: async (m, ...rest) => { messages.push(['error', m]); return answers.shift(); },
      showTextDocument: async () => {},
      onDidCloseTerminal: () => ({ dispose() {} }),
      onDidOpenTerminal: () => ({ dispose() {} }),
      onDidChangeActiveTerminal: () => ({ dispose() {} }),
      terminals: [],
      activeTerminal: undefined,
    },
    workspace: {
      getConfiguration: () => cfg,
      onDidChangeConfiguration: () => ({ dispose() {} }),
      workspaceFolders: [],
      fs: {},
    },
    commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; } },
    extensions: { getExtension: () => ({ packageJSON: { version: '0.9.0-test' } }) },
    Uri: { file: (p) => ({ fsPath: p, path: p }) },
    StatusBarAlignment: { Right: 2, Left: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ThemeColor: class { constructor(id) { this.id = id; } },
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

    check('no temp files left behind in the fuel-gauge directory',
      fs.readdirSync(fgDir).every((f) => !f.endsWith('.tmp')),
      fs.readdirSync(fgDir).join(', '));
    check('the bridge logged no errors',
      !fs.existsSync(path.join(fgDir, 'bridge.log')) ||
      fs.readFileSync(path.join(fgDir, 'bridge.log'), 'utf-8').trim() === '',
      fs.existsSync(path.join(fgDir, 'bridge.log'))
        ? fs.readFileSync(path.join(fgDir, 'bridge.log'), 'utf-8') : '');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
