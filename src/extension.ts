import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execFileSync } from 'child_process';

interface ContextStatus {
  cwd: string;
  project_dir: string;
  used_percentage: number;
  remaining_percentage: number;
  total_input_tokens: number;
  total_output_tokens: number;
  context_window_size: number;
  model: string;
  session_id: string;
  timestamp: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  detected_ttl?: number;
  last_api_call_ts?: number;
  rate_limit_5h_pct?: number;
  rate_limit_5h_reset?: number;
  rate_limit_7d_pct?: number;
  rate_limit_7d_reset?: number;
  effort_level?: string;
}

const BRIDGE_SCRIPT = `#!/bin/bash
# Claude Code Fuel Gauge — Context Bridge
# Reads statusline JSON from stdin, writes to ~/.claude/fuel-gauge/{session_id}.json

input=$(cat)

BD_DIR="$HOME/.claude/fuel-gauge"
BD_LOG="$BD_DIR/bridge.log"
mkdir -p "$BD_DIR"

session_id=$(echo "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>>"$BD_LOG")

if [ -z "$session_id" ]; then
  echo "[$(date -Iseconds)] No session_id in input" >> "$BD_LOG"
  exit 0
fi

echo "$input" | BD_SESSION_ID="$session_id" BD_DIR="$BD_DIR" python3 -c "
import sys, json, time, os

data = json.load(sys.stdin)
cw = data.get('context_window', {})
cu = cw.get('current_usage') or {}
window_size = cw.get('context_window_size', 200000) or 200000

# Read system overhead from config (written by VS Code extension). Only used on the
# fallback path below, when Claude Code sends no pre-computed percentage.
overhead = 0
config_path = os.path.join(os.path.expanduser('~'), '.claude', 'fuel-gauge', 'config.json')
try:
    with open(config_path) as f:
        cfg = json.load(f)
        overhead = cfg.get('systemOverhead', 0)
except Exception:
    pass

# Claude Code already computes the context percentage and puts it in the payload as
# used_percentage: round((input + cache_creation + cache_read) / context_window_size * 100).
# That is the number /context and the Claude Code status line show, so pass it straight
# through and the two always agree. Only fall back to computing a percentage ourselves
# when Claude Code sends no used_percentage at all.
inp = cu.get('input_tokens', 0) or 0
out = cu.get('output_tokens', 0) or 0
cache_create = cu.get('cache_creation_input_tokens', 0) or 0
cache_read = cu.get('cache_read_input_tokens', 0) or 0
total = inp + out + cache_create + cache_read

used_raw = cw.get('used_percentage')
if isinstance(used_raw, (int, float)) and not isinstance(used_raw, bool):
    used_pct = float(used_raw)
    remaining_pct = max(0.0, 100.0 - used_pct)
elif total > 0 and window_size > 0:
    # Fallback only. systemOverhead, if the user set one, is subtracted here.
    effective_window = max(1, window_size - overhead)
    used_pct = min(100.0, total * 100.0 / effective_window)
    remaining_pct = max(0.0, 100.0 - used_pct)
else:
    used_pct = 0
    remaining_pct = 100

# Use workspace.project_dir (stable launch dir) with cwd as fallback
ws = data.get('workspace', {})
project_dir = ws.get('project_dir', '') or data.get('cwd', '')

# Cache TTL detection — read previous file for prior state
bd_dir = os.environ.get('BD_DIR', '')
session_id = os.environ.get('BD_SESSION_ID', '')
prev_total_in = 0
prev_detected_ttl = 0
prev_last_api_call_ts = 0
if bd_dir and session_id:
    prev_file = os.path.join(bd_dir, session_id + '.json')
    try:
        with open(prev_file) as f:
            prev = json.load(f)
            prev_total_in = prev.get('total_input_tokens', 0) or 0
            prev_detected_ttl = prev.get('detected_ttl', 0) or 0
            prev_last_api_call_ts = prev.get('last_api_call_ts', 0) or 0
    except Exception:
        pass

# Account-level TTL persistence — once detection fires in any session,
# future sessions inherit the TTL until a downgrade event proves it wrong
account_ttl_file = os.path.join(bd_dir, 'account_ttl.json') if bd_dir else ''
account_ttl = 0
if account_ttl_file:
    try:
        with open(account_ttl_file) as f:
            account_ttl = json.load(f).get('detected_ttl', 0) or 0
    except Exception:
        pass

if prev_detected_ttl == 0 and account_ttl > 0:
    prev_detected_ttl = account_ttl

now = time.time()
total_in_now = cw.get('total_input_tokens', 0) or 0
api_call_happened = total_in_now > prev_total_in

if not cu:
    # /compact wiped current_usage — reset cache state
    detected_ttl = 0
    last_api_call_ts = 0
elif api_call_happened:
    gap = (now - prev_last_api_call_ts) if prev_last_api_call_ts > 0 else 0
    last_api_call_ts = now
    detected_ttl = prev_detected_ttl
    # Upgrade: cache survived past 5m → must be 1h TTL
    if gap > 310 and cache_read > 0:
        detected_ttl = 3600
    # Downgrade: had 1h, but a 6–55m gap produced a cache miss
    elif detected_ttl == 3600 and 360 < gap < 3300 and cache_read == 0 and cache_create > 0:
        detected_ttl = 300
else:
    last_api_call_ts = prev_last_api_call_ts
    detected_ttl = prev_detected_ttl

# Persist to account-level file when detection produced a different value
# (covers both the first upgrade to 3600 and any subsequent downgrade)
if account_ttl_file and detected_ttl > 0 and detected_ttl != account_ttl:
    try:
        with open(account_ttl_file, 'w') as f:
            json.dump({'detected_ttl': detected_ttl, 'detected_at': now}, f)
    except Exception:
        pass

# Rate limit pass-through (defensive — each window may be independently
# absent; -1 pct / 0 reset means 'not available', the extension hides it)
def rl_num(obj, key, absent):
    try:
        v = obj.get(key, absent) if isinstance(obj, dict) else absent
        return v if isinstance(v, (int, float)) else absent
    except Exception:
        return absent

rl = data.get('rate_limits')
rl_5h = rl.get('five_hour') if isinstance(rl, dict) else None
rl_7d = rl.get('seven_day') if isinstance(rl, dict) else None
rate_limit_5h_pct = rl_num(rl_5h, 'used_percentage', -1)
rate_limit_5h_reset = rl_num(rl_5h, 'resets_at', 0)
rate_limit_7d_pct = rl_num(rl_7d, 'used_percentage', -1)
rate_limit_7d_reset = rl_num(rl_7d, 'resets_at', 0)

# Reasoning effort level (statusline 'effort.level'; the whole 'effort'
# object is absent when the current model doesn't support the effort parameter)
effort_level = ''
try:
    eff = data.get('effort')
    if isinstance(eff, dict):
        effort_level = eff.get('level', '') or ''
except Exception:
    effort_level = ''

output = {
    'cwd': data.get('cwd', ''),
    'project_dir': project_dir,
    'used_percentage': used_pct,
    'remaining_percentage': remaining_pct,
    'total_input_tokens': total_in_now,
    'total_output_tokens': cw.get('total_output_tokens', 0),
    'context_window_size': window_size,
    'model': data.get('model', {}).get('id', 'unknown') if isinstance(data.get('model'), dict) else data.get('model', 'unknown'),
    'session_id': data.get('session_id', ''),
    'timestamp': now,
    'cache_read_input_tokens': cache_read,
    'cache_creation_input_tokens': cache_create,
    'detected_ttl': detected_ttl,
    'last_api_call_ts': last_api_call_ts,
    'rate_limit_5h_pct': rate_limit_5h_pct,
    'rate_limit_5h_reset': rate_limit_5h_reset,
    'rate_limit_7d_pct': rate_limit_7d_pct,
    'rate_limit_7d_reset': rate_limit_7d_reset,
    'effort_level': effort_level,
}

print(json.dumps(output, indent=2))
" > "$BD_DIR/$session_id.json.tmp" 2>>"$BD_LOG" && mv "$BD_DIR/$session_id.json.tmp" "$BD_DIR/$session_id.json"
`;

let statusBarItem: vscode.StatusBarItem;
let cacheStatusBarItem: vscode.StatusBarItem;
let effortStatusBarItem: vscode.StatusBarItem;
let usageStatusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;
let countdownTimer: NodeJS.Timeout | undefined;
let cleanupTimer: NodeJS.Timeout | undefined;
let cachedData: ContextStatus | undefined;
let lastBeepedCycleKey: string | undefined;
const DEFAULT_TTL = 300;
const META_FILES = new Set(['config.json', 'account_ttl.json']);

// Reasoning-effort levels, ordinal: low → medium → high → xhigh → max.
// 'xhigh' also covers "ultracode" (Claude Code reports it as xhigh).
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

// Compact label shown in the status bar for each effort level.
const EFFORT_LABELS: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'x-high',
  max: 'max',
};

// Effort colors — a warm Anthropic-leaning ramp (clay → rust), with a
// standout gold for 'max'. Hex is intentional (fixed brand hue, not a theme
// token); the whole model·effort item takes one of these.
const EFFORT_COLORS: Record<string, string> = {
  low: '#8A8A8A',    // neutral — lowest intensity
  medium: '#C2996B', // light clay
  high: '#CC785C',   // Anthropic clay
  xhigh: '#B85C38',  // deeper rust
  max: '#E3B341',    // gold — standout
};

// Model green used in the tooltip (bar item is single-color = effort color).
const MODEL_GREEN = '#6BA66A';

// Map a raw model id (e.g. 'claude-opus-4-8...') to a short family name.
function shortModelName(modelId: string | undefined): string {
  const m = (modelId ?? '').toLowerCase();
  if (m.includes('opus')) { return 'opus'; }
  if (m.includes('sonnet')) { return 'sonnet'; }
  if (m.includes('haiku')) { return 'haiku'; }
  if (m.includes('fable')) { return 'fable'; }
  return '';
}

function listSessionFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && !META_FILES.has(f));
}

// Terminal Shell Integration tracking (VS Code 1.93+)
let trackedSessionId: string | undefined;
let trackedExecution: vscode.TerminalShellExecution | undefined;
let trackedTerminal: vscode.Terminal | undefined;
let claudeStartTime: number | undefined;
let lastTrackedTimestamp: number | undefined;

function isClaudeCommand(commandLine: string): boolean {
  const firstToken = commandLine.trim().split(/\s+/)[0];
  if (!firstToken) { return false; }
  const basename = path.basename(firstToken);
  return basename === 'claude';
}

function clearTracking() {
  // Delete session file so Tier 3 doesn't pick up stale data
  if (trackedSessionId) {
    const filePath = path.join(os.homedir(), '.claude', 'fuel-gauge', `${trackedSessionId}.json`);
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  }
  trackedSessionId = undefined;
  trackedExecution = undefined;
  trackedTerminal = undefined;
  claudeStartTime = undefined;
  lastTrackedTimestamp = undefined;
}

function setupTerminalTracking(context: vscode.ExtensionContext) {
  // Feature-detect: Shell Integration API requires VS Code 1.93+
  if (!('onDidStartTerminalShellExecution' in vscode.window)) {
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;

  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      const commandLine = event.execution.commandLine.value;
      if (!isClaudeCommand(commandLine)) { return; }

      // If we have a workspace, check terminal cwd matches
      if (workspaceRoot && event.terminal.shellIntegration?.cwd) {
        const terminalCwd = event.terminal.shellIntegration.cwd.fsPath;
        if (terminalCwd !== workspaceRoot && !terminalCwd.startsWith(workspaceRoot + '/')) {
          return;
        }
      }

      // Clean up previous tracking (handles missed onDidEnd events from /exit)
      clearTracking();

      claudeStartTime = Date.now();
      trackedTerminal = event.terminal;
      trackedExecution = event.execution;
      trackedSessionId = undefined; // Will be discovered on next poll
    })
  );

  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution((event) => {
      if (trackedExecution && event.execution === trackedExecution) {
        clearTracking();
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (trackedTerminal && terminal === trackedTerminal) {
        clearTracking();
      }
    })
  );
}

function writeBridgeConfig() {
  const fuelGaugeDir = path.join(os.homedir(), '.claude', 'fuel-gauge');
  const configPath = path.join(fuelGaugeDir, 'config.json');
  const config = vscode.workspace.getConfiguration('fuel-gauge');
  const systemOverhead = config.get<number>('systemOverhead', 0);

  try {
    fs.mkdirSync(fuelGaugeDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ systemOverhead }, null, 2) + '\n');
  } catch {
    // Config write is best-effort
  }
}

export function activate(context: vscode.ExtensionContext) {
  installBridgeScript();
  // Never awaited: a modal must not block activation.
  void ensureStatusLineWired(context);
  writeBridgeConfig();
  cleanupStaleSessions();
  cleanupTimer = setInterval(cleanupStaleSessions, 60 * 60 * 1000); // Hourly
  setupTerminalTracking(context);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.tooltip = 'Claude Code Fuel Gauge';
  context.subscriptions.push(statusBarItem);

  cacheStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  context.subscriptions.push(cacheStatusBarItem);

  effortStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98
  );
  context.subscriptions.push(effortStatusBarItem);

  usageStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    97
  );
  context.subscriptions.push(usageStatusBarItem);

  startPolling();
  startCountdown();

  context.subscriptions.push(
    vscode.commands.registerCommand('fuel-gauge.setupStatusLine', () =>
      ensureStatusLineWired(context, true)
    ),
    vscode.commands.registerCommand('fuel-gauge.restoreStatusLine', () =>
      restoreStatusLine(context)
    ),
    vscode.commands.registerCommand('fuel-gauge.showBridgeStatus', () => showBridgeStatus())
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fuel-gauge')) {
        writeBridgeConfig();
        startPolling();
      }
    })
  );
}

type StatusLineOwner = 'ours' | 'foreign' | 'optout' | 'unknown';

interface StatusLineBackup {
  capturedAt: string;
  capturedByVersion: string;
  previousStatusLine: unknown;
  previousCommandString: string | null;
}

let statusLineOwner: StatusLineOwner = 'unknown';
let foreignCommand: string | null = null;

function claudePaths() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const scriptsDir = path.join(claudeDir, 'scripts');
  return {
    claudeDir,
    scriptsDir,
    bridgePath: path.join(scriptsDir, 'context-bridge.sh'),
    settingsPath: path.join(claudeDir, 'settings.json'),
  };
}

// Step 1: the bridge script itself is ours and is rewritten every activation.
// A hand-edited script is copied aside once so the user's edits are never lost.
function installBridgeScript() {
  const { scriptsDir, bridgePath } = claudePaths();
  fs.mkdirSync(scriptsDir, { recursive: true });

  try {
    if (fs.existsSync(bridgePath)) {
      const onDisk = fs.readFileSync(bridgePath, 'utf-8');
      const origPath = bridgePath + '.fuel-gauge.orig';
      if (onDisk !== BRIDGE_SCRIPT && !fs.existsSync(origPath)) {
        fs.copyFileSync(bridgePath, origPath);
      }
    }
  } catch {
    // Preserving a hand-edited script is best-effort; never block the install.
  }

  fs.writeFileSync(bridgePath, BRIDGE_SCRIPT, { mode: 0o755 });
}

// Step 2: never fall through to a write when settings.json cannot be parsed.
type SettingsRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; error: string }
  | { kind: 'ok'; settings: Record<string, unknown> };

function readSettings(): SettingsRead {
  const { settingsPath } = claudePaths();
  if (!fs.existsSync(settingsPath)) {
    return { kind: 'missing' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'unreadable', error: 'settings.json is not a JSON object' };
    }
    return { kind: 'ok', settings: parsed as Record<string, unknown> };
  } catch (err) {
    return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) };
  }
}

// Step 3: four cases, not two. Anything that is not a well-formed object with a
// string command counts as foreign — a bare string, an array, a nested object.
function classifyStatusLine(
  settings: Record<string, unknown>,
  bridgePath: string
): { owner: 'ours' | 'empty' | 'foreign'; command: string | null } {
  const raw = settings.statusLine;

  if (raw === undefined || raw === null) {
    return { owner: 'empty', command: null };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { owner: 'foreign', command: typeof raw === 'string' ? raw : JSON.stringify(raw) };
  }

  const command = (raw as Record<string, unknown>).command;
  if (command === undefined || command === null) {
    return { owner: 'empty', command: null };
  }
  if (typeof command !== 'string') {
    return { owner: 'foreign', command: JSON.stringify(command) };
  }
  if (command === bridgePath) {
    return { owner: 'ours', command };
  }
  return { owner: 'foreign', command };
}

function extensionVersion(): string {
  return vscode.extensions.getExtension('MakingAIpractical.claude-code-fuel-gauge')
    ?.packageJSON?.version ?? 'unknown';
}

// Step 6: the backup lives in globalStorageUri, which no version of Fuel Gauge prunes.
function backupPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'statusline-backup.json');
}

function readBackups(context: vscode.ExtensionContext): StatusLineBackup[] {
  try {
    const raw = fs.readFileSync(backupPath(context), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Append rather than "first capture wins", so Restore never hands back a value
// that predates a change the user made deliberately.
function recordBackup(context: vscode.ExtensionContext, previous: unknown, command: string | null) {
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    const entries = readBackups(context);
    const newest = entries[entries.length - 1];
    if (newest && newest.previousCommandString === command) {
      return; // Unchanged since the last capture.
    }
    entries.push({
      capturedAt: new Date().toISOString(),
      capturedByVersion: extensionVersion(),
      previousStatusLine: previous ?? null,
      previousCommandString: command,
    });
    fs.writeFileSync(backupPath(context), JSON.stringify(entries, null, 2) + '\n');
  } catch {
    // A failed backup must not block the flow, but it must not be silent either.
    vscode.window.showWarningMessage(
      'Fuel Gauge: could not save a backup of your existing status line.'
    );
  }
}

// Step 7: in-place write, object spread. Temp-plus-rename was rejected: it severs
// symlinked dotfiles and widens 0600 to 0644.
function writeStatusLine(settings: Record<string, unknown>, bridgePath: string) {
  const { settingsPath } = claudePaths();
  const existing =
    settings.statusLine && typeof settings.statusLine === 'object' && !Array.isArray(settings.statusLine)
      ? (settings.statusLine as Record<string, unknown>)
      : {};
  settings.statusLine = { ...existing, type: 'command', command: bridgePath };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

// Step 8: activate() runs per window. One dialog, not four.
const MODAL_LOCK_MS = 60 * 1000;

function claimModalLock(context: vscode.ExtensionContext): boolean {
  const key = 'fuel-gauge.statusLineModalLock';
  const last = context.globalState.get<number>(key, 0);
  const now = Date.now();
  if (now - last < MODAL_LOCK_MS) {
    return false;
  }
  void context.globalState.update(key, now);
  return true;
}

// Steps 3-5: the only function permitted to write ~/.claude/settings.json.
async function ensureStatusLineWired(context: vscode.ExtensionContext, force = false) {
  const { bridgePath, settingsPath } = claudePaths();
  const config = vscode.workspace.getConfiguration('fuel-gauge');

  if (!force && config.get<boolean>('manageStatusLine', true) === false) {
    statusLineOwner = 'optout';
    return;
  }

  const read = readSettings();

  if (read.kind === 'unreadable') {
    statusLineOwner = 'unknown';
    const open = 'Open settings.json';
    const choice = await vscode.window.showErrorMessage(
      `Fuel Gauge: could not read ~/.claude/settings.json (${read.error}). Nothing was changed.`,
      open
    );
    if (choice === open) {
      void vscode.window.showTextDocument(vscode.Uri.file(settingsPath));
    }
    return;
  }

  const settings = read.kind === 'ok' ? read.settings : {};
  const state = classifyStatusLine(settings, bridgePath);

  if (state.owner === 'ours') {
    statusLineOwner = 'ours';
    foreignCommand = null;
    return; // The path every existing install takes. No write, no dialog.
  }

  if (state.owner === 'empty') {
    recordBackup(context, settings.statusLine, null);
    writeStatusLine(settings, bridgePath);
    statusLineOwner = 'ours';
    const undo = 'Undo';
    const choice = await vscode.window.showInformationMessage(
      'Fuel Gauge: status line connected. Restart Claude Code to see context usage.',
      undo
    );
    if (choice === undo) {
      await restoreStatusLine(context, true);
    }
    return;
  }

  // Foreign command.
  statusLineOwner = 'foreign';
  foreignCommand = state.command;

  if (!force && !claimModalLock(context)) {
    return; // Another window is already asking.
  }

  const replace = 'Replace';
  const notNow = 'Not now';
  const choice = await vscode.window.showWarningMessage(
    'Fuel Gauge needs Claude Code’s status line slot, which is already in use.',
    {
      modal: true,
      detail:
        `Your current status line command is:\n\n  ${state.command}\n\n` +
        'Fuel Gauge would replace it in ~/.claude/settings.json. Your command will be ' +
        'saved first, and "Fuel Gauge: Restore Previous Status Line" puts it back at any time.\n\n' +
        'Claude Code allows only one status line command, so the two cannot run at once.',
    },
    replace,
    notNow
  );

  // Step 5: Escape returns undefined and must mean "ask again next activation".
  if (choice === undefined) {
    return;
  }

  if (choice === notNow) {
    await config.update('manageStatusLine', false, vscode.ConfigurationTarget.Global);
    statusLineOwner = 'optout';
    void vscode.window.showInformationMessage(
      'Fuel Gauge: leaving your status line alone. Set "fuel-gauge.manageStatusLine" to true, ' +
      'or run "Fuel Gauge: Connect Status Line", if you change your mind.'
    );
    return;
  }

  // Step 4: re-read and re-check before writing. Closes the read-modify-write window.
  const recheck = readSettings();
  if (recheck.kind !== 'ok' && recheck.kind !== 'missing') {
    void vscode.window.showErrorMessage(
      'Fuel Gauge: ~/.claude/settings.json changed and can no longer be read. Nothing was changed.'
    );
    return;
  }
  const fresh = recheck.kind === 'ok' ? recheck.settings : {};
  const freshState = classifyStatusLine(fresh, bridgePath);
  if (freshState.command !== state.command) {
    void vscode.window.showWarningMessage(
      'Fuel Gauge: your status line changed while the dialog was open, so nothing was changed. ' +
      'Run "Fuel Gauge: Connect Status Line" to try again.'
    );
    return;
  }

  recordBackup(context, fresh.statusLine, state.command);
  writeStatusLine(fresh, bridgePath);
  statusLineOwner = 'ours';
  foreignCommand = null;
  void vscode.window.showInformationMessage(
    'Fuel Gauge: status line connected. Restart Claude Code to see context usage.'
  );
}

async function restoreStatusLine(context: vscode.ExtensionContext, silent = false) {
  const { bridgePath, settingsPath } = claudePaths();
  const entries = readBackups(context);
  const backup = entries[entries.length - 1];

  if (!backup) {
    void vscode.window.showInformationMessage(
      'Fuel Gauge: no saved status line to restore. Nothing was changed.'
    );
    return;
  }

  const read = readSettings();
  if (read.kind === 'unreadable') {
    void vscode.window.showErrorMessage(
      `Fuel Gauge: could not read ~/.claude/settings.json (${read.error}). Nothing was changed.`
    );
    return;
  }
  const settings = read.kind === 'ok' ? read.settings : {};
  const current = classifyStatusLine(settings, bridgePath);

  if (!silent) {
    const restore = 'Restore';
    const choice = await vscode.window.showWarningMessage(
      'Restore your previous Claude Code status line?',
      {
        modal: true,
        detail:
          `This will set:\n\n  ${backup.previousCommandString ?? '(no status line)'}\n\n` +
          `replacing:\n\n  ${current.command ?? '(no status line)'}\n\n` +
          'Fuel Gauge will stop managing the status line and its readouts will go dark.',
      },
      restore
    );
    if (choice !== restore) {
      return;
    }
  }

  if (backup.previousStatusLine === null || backup.previousStatusLine === undefined) {
    delete settings.statusLine;
  } else {
    settings.statusLine = backup.previousStatusLine;
  }

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Fuel Gauge: could not write ~/.claude/settings.json (${err instanceof Error ? err.message : String(err)}).`
    );
    return;
  }

  await vscode.workspace
    .getConfiguration('fuel-gauge')
    .update('manageStatusLine', false, vscode.ConfigurationTarget.Global);
  statusLineOwner = 'optout';
  foreignCommand = backup.previousCommandString;

  void vscode.window.showInformationMessage(
    'Fuel Gauge: previous status line restored. Restart Claude Code to apply.'
  );
}

// Step 9: read-only diagnostics, so "my gauge is dark" becomes a paste.
function showBridgeStatus() {
  const { bridgePath, settingsPath, claudeDir } = claudePaths();
  const out = vscode.window.createOutputChannel('Claude Code Fuel Gauge');
  const lines: string[] = [];
  const add = (k: string, v: string) => lines.push(`${k.padEnd(28)} ${v}`);

  add('Extension version', extensionVersion());

  try {
    const st = fs.statSync(bridgePath);
    add('Bridge script', `present, modified ${st.mtime.toISOString()}`);
    add('Bridge matches this version', fs.readFileSync(bridgePath, 'utf-8') === BRIDGE_SCRIPT ? 'yes' : 'NO');
  } catch {
    add('Bridge script', 'MISSING');
  }

  const read = readSettings();
  if (read.kind === 'unreadable') {
    add('~/.claude/settings.json', `UNREADABLE — ${read.error}`);
  } else if (read.kind === 'missing') {
    add('~/.claude/settings.json', 'does not exist');
  } else {
    const state = classifyStatusLine(read.settings, bridgePath);
    add('~/.claude/settings.json', 'parsed OK');
    add('statusLine.command', state.command ?? '(none)');
    add('Owned by Fuel Gauge', state.owner === 'ours' ? 'yes' : 'no');
  }

  add('manageStatusLine setting', String(
    vscode.workspace.getConfiguration('fuel-gauge').get<boolean>('manageStatusLine', true)
  ));
  add('In-memory owner', statusLineOwner);

  // A project-level statusLine outranks ~/.claude and would silently win.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const p = path.join(folder.uri.fsPath, '.claude', name);
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (parsed && typeof parsed === 'object' && 'statusLine' in parsed) {
          add('OVERRIDES US', `${p} also sets statusLine`);
        }
      } catch {
        // Absent or unparseable project settings are not our problem to report.
      }
    }
  }

  try {
    const dir = path.join(claudeDir, 'fuel-gauge');
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !META_FILES.has(f))
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (files.length) {
      const ageMin = Math.round((Date.now() - files[0].m) / 60000);
      add('Newest session file', `${files[0].f} (${ageMin} min old)`);
    } else {
      add('Newest session file', 'none — no session has written yet');
    }
    add('Session files', String(files.length));
  } catch {
    add('Session directory', 'MISSING');
  }

  try {
    execFileSync('python3', ['--version'], { stdio: 'pipe' });
    add('python3', 'found');
  } catch {
    add('python3', 'NOT FOUND — the bridge cannot parse payloads without it');
  }

  out.clear();
  out.appendLine('Claude Code Fuel Gauge — diagnostics');
  out.appendLine('');
  lines.forEach((l) => out.appendLine(l));
  out.show();
}

function cleanupStaleSessions() {
  const fuelGaugeDir = path.join(os.homedir(), '.claude', 'fuel-gauge');
  if (!fs.existsSync(fuelGaugeDir)) {
    return;
  }

  const maxAgeMs = 36 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;

  const files = listSessionFiles(fuelGaugeDir);
  for (const file of files) {
    try {
      const filePath = path.join(fuelGaugeDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Skip files that can't be read or deleted
    }
  }

  // Trim bridge log to last 50 lines
  const logPath = path.join(fuelGaugeDir, 'bridge.log');
  try {
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
      if (lines.length > 50) {
        fs.writeFileSync(logPath, lines.slice(-50).join('\n'));
      }
    }
  } catch {
    // Log trimming is best-effort
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  const config = vscode.workspace.getConfiguration('fuel-gauge');
  const intervalSeconds = config.get<number>('pollInterval', 15);

  updateStatus();
  pollTimer = setInterval(updateStatus, intervalSeconds * 1000);
}

function matchesWorkspace(data: ContextStatus, workspaceRoot: string): boolean {
  // Prefer project_dir (stable launch directory) over cwd (can change mid-session)
  const dir = data.project_dir || data.cwd;
  return dir === workspaceRoot || dir.startsWith(workspaceRoot + '/');
}

function findMatchingSession(): ContextStatus | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const fuelGaugeDir = path.join(os.homedir(), '.claude', 'fuel-gauge');

  if (!fs.existsSync(fuelGaugeDir)) {
    return undefined;
  }

  // Tier 1: Locked onto a specific session — read directly, no scanning
  if (trackedSessionId) {
    try {
      const filePath = path.join(fuelGaugeDir, `${trackedSessionId}.json`);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as ContextStatus;

      // If the file hasn't updated since last poll, check whether /clear
      // (or similar) created a new session for this workspace
      if (lastTrackedTimestamp !== undefined && data.timestamp === lastTrackedTimestamp) {
        const files = listSessionFiles(fuelGaugeDir);
        let hasNewer = false;
        for (const file of files) {
          try {
            const otherRaw = fs.readFileSync(path.join(fuelGaugeDir, file), 'utf-8');
            const other: ContextStatus = JSON.parse(otherRaw);
            if (other.session_id !== trackedSessionId &&
                matchesWorkspace(other, workspaceRoot) &&
                other.timestamp > data.timestamp) {
              hasNewer = true;
              break;
            }
          } catch { /* skip */ }
        }
        if (hasNewer) {
          // Release session lock but keep claudeStartTime (terminal still alive)
          trackedSessionId = undefined;
          lastTrackedTimestamp = undefined;
          // Fall through to Tier 2/3 for rediscovery
        } else {
          return data;
        }
      } else {
        lastTrackedTimestamp = data.timestamp;
        return data;
      }
    } catch {
      // File gone or unreadable — clear lock, fall through to Tier 3
      clearTracking();
    }
  }

  // Tier 2: Claude started, waiting to discover session file
  if (claudeStartTime) {
    const startTimeSec = (claudeStartTime / 1000) - 30; // 30s grace for clock skew
    const files = listSessionFiles(fuelGaugeDir);
    let newestMatch: ContextStatus | undefined;

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(fuelGaugeDir, file), 'utf-8');
        const data: ContextStatus = JSON.parse(raw);

        if (matchesWorkspace(data, workspaceRoot) && data.timestamp >= startTimeSec) {
          if (!newestMatch || data.timestamp > newestMatch.timestamp) {
            newestMatch = data;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (newestMatch) {
      trackedSessionId = newestMatch.session_id;
      lastTrackedTimestamp = newestMatch.timestamp;
      return newestMatch;
    }

    // Not found yet — keep waiting (return nothing rather than wrong session)
    return undefined;
  }

  // Tier 3: Fallback — scan all, match workspace, pick newest
  let bestMatch: ContextStatus | undefined;
  const files = listSessionFiles(fuelGaugeDir);

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(fuelGaugeDir, file), 'utf-8');
      const data: ContextStatus = JSON.parse(raw);

      if (matchesWorkspace(data, workspaceRoot)) {
        if (!bestMatch || data.timestamp > bestMatch.timestamp) {
          bestMatch = data;
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return bestMatch;
}

function updateStatus() {
  try {
    cachedData = findMatchingSession();
    renderStatus();
  } catch {
    statusBarItem.hide();
    cacheStatusBarItem.hide();
    usageStatusBarItem.hide();
  }
}

function startCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
  }
  countdownTimer = setInterval(renderStatus, 1000);
}

function resolveTTL(detectedTtl: number): { ttl: number; source: 'configured' | 'detected' | 'default' } {
  const config = vscode.workspace.getConfiguration('fuel-gauge');
  const override = config.get<number | null>('cacheTTL', null);
  if (override !== null && override !== undefined && override > 0) {
    return { ttl: override, source: 'configured' };
  }
  if (detectedTtl > 0) {
    return { ttl: detectedTtl, source: 'detected' };
  }
  return { ttl: DEFAULT_TTL, source: 'default' };
}

function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

function describeTTLSource(ttl: number, source: 'configured' | 'detected' | 'default'): string {
  if (source === 'configured') {
    if (ttl === 300) { return 'configured 5m'; }
    if (ttl === 3600) { return 'configured 1h'; }
    const m = Math.round(ttl / 60);
    return `configured ${m}m`;
  }
  if (source === 'detected') {
    return ttl === 3600 ? 'detected 1h TTL' : `detected ${Math.round(ttl / 60)}m TTL`;
  }
  return '5m default';
}

function maybePlayCacheWarningBeep(data: ContextStatus, remaining: number) {
  if (process.platform !== 'darwin') { return; }
  const config = vscode.workspace.getConfiguration('fuel-gauge');
  const threshold = config.get<number | null>('cacheWarningSeconds', null);
  if (threshold === null || threshold === undefined || threshold <= 0) { return; }
  if (remaining <= 0 || remaining > threshold) { return; }

  const cycleKey = `${data.session_id}:${data.last_api_call_ts}`;
  if (lastBeepedCycleKey === cycleKey) { return; }
  lastBeepedCycleKey = cycleKey;

  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      try {
        spawn('afplay', ['/System/Library/Sounds/Tink.aiff'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } catch {
        // afplay missing or blocked — silently ignore
      }
    }, i * 300);
  }
}

// Severity → ThemeColor (0 green, 1 yellow, 2 red).
function severityColor(sev: number): vscode.ThemeColor {
  if (sev >= 2) { return new vscode.ThemeColor('charts.red'); }
  if (sev >= 1) { return new vscode.ThemeColor('charts.yellow'); }
  return new vscode.ThemeColor('charts.green');
}

// Title-case a hyphenated label: 'x-high' → 'X-High', 'opus' → 'Opus'.
function titleCase(s: string): string {
  return s
    .split('-')
    .map(p => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join('-');
}

// Renders the combined model·effort item, colored by effort level. Returns the
// display fragments so the caller can fold them into the shared tooltip.
// Hidden when disabled ('off'), no session, or neither model nor effort known.
function renderModelEffort(
  data: ContextStatus | undefined
): { modelCap: string; effortCap: string; effortLevel: string } {
  const config = vscode.workspace.getConfiguration('fuel-gauge');
  const style = config.get<string>('effortStyle', 'text');

  const model = shortModelName(data?.model);
  const level = data?.effort_level ?? '';
  const hasEffort = EFFORT_ORDER.indexOf(level) >= 0;
  const effortLabel = hasEffort ? EFFORT_LABELS[level] : '';

  const modelCap = model ? titleCase(model) : '';
  const effortCap = effortLabel ? titleCase(effortLabel) : '';

  if (style === 'off' || !data || (!model && !effortLabel)) {
    effortStatusBarItem.hide();
    return { modelCap, effortCap, effortLevel: level };
  }

  // Single-color item: model+effort share the effort color (or neutral when
  // only the model is known). The green-model / colored-effort split lives in
  // the tooltip, which is the only surface that supports two colors + stacking.
  let text: string;
  if (model && effortLabel) {
    text = `${model}·${effortLabel}`;
  } else {
    text = model || effortLabel;
  }

  effortStatusBarItem.text = text;
  effortStatusBarItem.color = hasEffort ? EFFORT_COLORS[level] : undefined;
  effortStatusBarItem.show();
  return { modelCap, effortCap, effortLevel: level };
}

// Builds the shared hover tooltip: model over effort (stacked + color-coded),
// then the context / cache stats. This is where the two-line, two-color layout
// the status bar itself can't do actually lives.
function buildTooltip(
  modelCap: string,
  effortCap: string,
  effortLevel: string,
  statsLine: string,
  usageFragment: string = ''
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = true;

  const lines: string[] = [];
  if (modelCap) {
    lines.push(`<span style="color:${MODEL_GREEN};"><b>${modelCap}</b></span>`);
  }
  if (effortCap) {
    const c = EFFORT_COLORS[effortLevel] ?? '#8A8A8A';
    lines.push(`<span style="color:${c};"><b>${effortCap}</b></span>`);
  }
  lines.push(statsLine);
  if (usageFragment) {
    lines.push(usageFragment);
  }
  md.appendMarkdown(lines.join('<br>'));
  return md;
}

// Usage-limit color thresholds (percent used). Fixed on purpose — the context
// thresholds don't transfer (60% context is late in a session; 60% weekly on a
// Wednesday is normal pacing).
const USAGE_WARN_PCT = 70;
const USAGE_DANGER_PCT = 90;

function usageSeverity(pct: number): number {
  if (pct >= USAGE_DANGER_PCT) { return 2; }
  if (pct >= USAGE_WARN_PCT) { return 1; }
  return 0;
}

// ' · resets 23:10' for the 5h window; weekday + date added for the weekly one.
function formatResetSuffix(epochSeconds: number | undefined, weekly: boolean): string {
  if (!epochSeconds || epochSeconds <= 0) { return ''; }
  const d = new Date(epochSeconds * 1000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!weekly) { return ` · resets ${time}`; }
  const day = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return ` · resets ${day}, ${time}`;
}

// Session/weekly usage limits (statusline rate_limits pass-through). Usage
// lives in the main gauge's hover tooltip; this returns that tooltip fragment
// for the caller to fold in. The standalone chip only reappears in the bar as
// a warning light when a limit is elevated (severity >= 1: yellow >=70%, red
// >=90%). Returns '' — and shows nothing — when disabled, no session, stale
// file, or Claude Code sent no limit data (API-key plans; before the session's
// first response). Absent data renders as nothing, never as 0%.
function renderUsage(data: ContextStatus | undefined, fileAbandoned: boolean): string {
  const config = vscode.workspace.getConfiguration('fuel-gauge');
  const show = config.get<boolean>('showUsage', true);

  const pct5h = data?.rate_limit_5h_pct ?? -1;
  const pct7d = data?.rate_limit_7d_pct ?? -1;

  if (!show || !data || fileAbandoned || (pct5h < 0 && pct7d < 0)) {
    usageStatusBarItem.hide();
    return '';
  }

  const tipLines: string[] = [];
  let severity = 0;

  if (pct5h >= 0) {
    tipLines.push(`Session limit (5h): ${Math.round(pct5h)}% used${formatResetSuffix(data.rate_limit_5h_reset, false)}`);
    severity = Math.max(severity, usageSeverity(pct5h));
  }
  if (pct7d >= 0) {
    tipLines.push(`Weekly limit (all models): ${Math.round(pct7d)}% used${formatResetSuffix(data.rate_limit_7d_reset, true)}`);
    severity = Math.max(severity, usageSeverity(pct7d));
  }

  const tipFragment = tipLines.join('<br>');

  // Warning-light behavior: usage normally lives only in the hover tooltip
  // (returned below). When a limit is elevated the chip reappears in the bar
  // as a numberless alert light — a single colored dot, no percentages or
  // labels (those stay in the dot's own hover) — colored by the more urgent
  // of the two windows. The dot signals "you're running hot" without adding
  // more figures to the bar.
  if (severity >= 1) {
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    md.appendMarkdown(tipFragment);

    usageStatusBarItem.text = '$(circle-filled)';
    usageStatusBarItem.color = severityColor(severity);
    usageStatusBarItem.tooltip = md;
    usageStatusBarItem.show();
  } else {
    usageStatusBarItem.hide();
  }

  return tipFragment;
}

function renderStatus() {
  const data = cachedData;
  const { modelCap, effortCap, effortLevel } = renderModelEffort(data);

  // Ultimate file-age safety floor: if the bridge file hasn't updated in over
  // an hour the session is genuinely abandoned — strip color below, and hide
  // the usage item (stale limit numbers mislead).
  const fileAbandoned = data
    ? ((Date.now() / 1000) - data.timestamp) > 3600
    : false;
  // Usage lives in the main gauge's hover tooltip; renderUsage returns that
  // fragment (and independently pops its own warning dot when a limit is high).
  const usageTip = renderUsage(data, fileAbandoned);

  if (!data) {
    if (statusLineOwner === 'foreign' || statusLineOwner === 'optout') {
      statusBarItem.text = '$(claude)$(dashboard) $(warning)';
      statusBarItem.color = undefined;
      statusBarItem.tooltip =
        statusLineOwner === 'optout'
          ? 'Fuel Gauge is not connected — you chose to keep your own status line. Click to connect.'
          : `Fuel Gauge is not connected — Claude Code's status line is used by:\n  ${foreignCommand ?? 'another command'}\nClick to connect.`;
      statusBarItem.command = 'fuel-gauge.setupStatusLine';
      statusBarItem.show();
      cacheStatusBarItem.hide();
      return;
    }
    statusBarItem.text = '$(claude)$(dashboard) 0%';
    statusBarItem.color = undefined;
    statusBarItem.tooltip = 'Fuel Gauge — No active Claude Code session';
    statusBarItem.command = undefined;
    statusBarItem.show();
    cacheStatusBarItem.hide();
    return;
  }

  // The click target is only ever set on the not-connected path above; clear it
  // on every other path or the assignment sticks.
  statusBarItem.command = undefined;

  const pct = Math.round(data.used_percentage);
  const config = vscode.workspace.getConfiguration('fuel-gauge');
  const warningThreshold = config.get<number>('warningThreshold', 60);
  const dangerThreshold = config.get<number>('dangerThreshold', 80);

  // Context severity (0 green, 1 yellow, 2 red).
  let contextSeverity = 0;
  if (pct >= dangerThreshold) {
    contextSeverity = 2;
  } else if (pct >= warningThreshold) {
    contextSeverity = 1;
  }
  const contextColor = fileAbandoned ? undefined : severityColor(contextSeverity);

  // Main item: context percentage only. The cache countdown is a separate item
  // (below) so it can carry its own urgency color independent of context.
  statusBarItem.text = `$(claude)$(dashboard) ${pct}%`;
  statusBarItem.color = contextColor;

  // Cache state — only meaningful if bridge has populated last_api_call_ts.
  const lastApiCallTs = data.last_api_call_ts ?? 0;
  const detectedTtl = data.detected_ttl ?? 0;
  const hasCacheInfo = lastApiCallTs > 0;

  if (!hasCacheInfo) {
    cacheStatusBarItem.hide();
    statusBarItem.tooltip = buildTooltip(
      modelCap, effortCap, effortLevel, `Context&nbsp;${pct}%`, usageTip
    );
    statusBarItem.show();
    return;
  }

  const { ttl, source } = resolveTTL(detectedTtl);
  const remaining = ttl - ((Date.now() / 1000) - lastApiCallTs);
  const ttlLabel = describeTTLSource(ttl, source);

  maybePlayCacheWarningBeep(data, remaining);

  // Cache color is independent of context: it inherits the context color while
  // there's comfortable time left, then escalates on its own countdown
  // thresholds — yellow under 60s, red under 15s / expired.
  let cacheText: string;
  let cacheColor: vscode.ThemeColor | undefined;
  let cacheTooltipFragment: string;

  if (remaining <= 0) {
    cacheText = '$(circle-slash) expired';
    cacheColor = new vscode.ThemeColor('charts.red');
    cacheTooltipFragment = `Cache: expired (${ttlLabel})`;
  } else {
    cacheText = formatCountdown(remaining);
    if (remaining < 15) {
      cacheColor = new vscode.ThemeColor('charts.red');
    } else if (remaining < 60) {
      cacheColor = new vscode.ThemeColor('charts.yellow');
    } else {
      cacheColor = contextColor;
    }
    cacheTooltipFragment = `Cache: ${formatCountdown(remaining)} remaining (${ttlLabel})`;
  }

  // Rate-limit warning when overage downgrade is imminent.
  const rl = data.rate_limit_5h_pct ?? -1;
  const rateLimitWarning = rl >= 95
    ? ` · 5h limit ${rl}% — TTL may downgrade`
    : '';

  cacheStatusBarItem.text = cacheText;
  cacheStatusBarItem.color = fileAbandoned ? undefined : cacheColor;
  cacheStatusBarItem.tooltip = `${cacheTooltipFragment}${rateLimitWarning}`;
  cacheStatusBarItem.show();

  // Main gauge tooltip keeps the full stacked layout: model / effort / context
  // / cache / usage.
  statusBarItem.tooltip = buildTooltip(
    modelCap,
    effortCap,
    effortLevel,
    `Context&nbsp;${pct}%<br>${cacheTooltipFragment}${rateLimitWarning}`,
    usageTip
  );
  statusBarItem.show();
}

export function deactivate() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  if (countdownTimer) {
    clearInterval(countdownTimer);
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }
  clearTracking();
}
