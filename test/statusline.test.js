// Drives the REAL compiled out/extension.js against a sandboxed HOME with a stubbed
// `vscode` module. Every filesystem path the extension touches must land under TMPROOT;
// the harness asserts that at the end of every scenario.
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
