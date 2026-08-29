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
  /** The reading is the last known one, not a current measurement — see the
   *  post-/compact case in the bridge. */
  context_unknown?: boolean;
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
import sys, json, time, os, calendar

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
# A setting someone typed by hand can be anything at all. An explicit null used
# to reach the subtraction below and kill the bridge, so no session file was
# written and the gauge quietly stopped updating.
if isinstance(overhead, bool) or not isinstance(overhead, (int, float)):
    overhead = 0

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
prev_used_pct = 0
if bd_dir and session_id:
    prev_file = os.path.join(bd_dir, session_id + '.json')
    try:
        with open(prev_file) as f:
            prev = json.load(f)
            prev_total_in = prev.get('total_input_tokens', 0) or 0
            prev_detected_ttl = prev.get('detected_ttl', 0) or 0
            prev_last_api_call_ts = prev.get('last_api_call_ts', 0) or 0
            prev_used_pct = prev.get('used_percentage', 0) or 0
    except Exception:
        pass

# Account-level TTL persistence — a new session inherits the TTL the account
# last used, so its countdown is right before its own first cache write lands
account_ttl_file = os.path.join(bd_dir, 'account_ttl.json') if bd_dir else ''
account_ttl = 0
account_detected_at = 0
if account_ttl_file:
    try:
        with open(account_ttl_file) as f:
            stored = json.load(f)
            account_ttl = stored.get('detected_ttl', 0) or 0
            account_detected_at = stored.get('detected_at', 0) or 0
    except Exception:
        pass

# Cache TTL, read from the transcript instead of guessed.
# On every assistant turn Claude Code records which cache tier it asked the API
# for: message.usage.cache_creation holds two counters, one for the 5-minute
# tier and one for the 1-hour tier. Whichever is non-zero on the most recent
# cache write is the TTL in force — a fact, not an inference. This replaces the
# old rules that read the TTL out of the gap between two calls, which mistook an
# ordinary cache invalidation for an expiry and then put every window on a
# 5-minute countdown.
def row_time(row):
    # '2026-07-28T14:14:00.420Z' (always UTC) -> epoch seconds. Anything else,
    # including a row with no timestamp at all, reads as 0 = 'no idea when'.
    try:
        stamp = row.get('timestamp')
        d, sep, t = stamp.partition('T')
        y, mo, da = [int(x) for x in d.split('-')]
        h, mi, s = [int(x) for x in t[:8].split(':')]
        return calendar.timegm((y, mo, da, h, mi, s, 0, 0, 0))
    except Exception:
        return 0

def ttl_from_transcript(transcript_path):
    # Returns (ttl_seconds, when_that_row_was_written). 0, 0 means no answer.
    if not transcript_path:
        return 0, 0
    try:
        size = os.path.getsize(transcript_path)
    except Exception:
        return 0, 0
    # Only the end of the file is read: transcripts run to many megabytes and
    # the answer is always in the last few rows. The window widens twice, in
    # case a single long row (a large tool result) fills the first slice.
    # Known limit: one row bigger than 1 MB fills even the widest slice, and
    # then there is no answer to be had here. Widening past that would mean an
    # unbounded read on every status line update, so it stops and the caller's
    # fallback takes over.
    for window in (65536, 262144, 1048576):
        start = size - window
        if start < 0:
            start = 0
        try:
            with open(transcript_path, 'rb') as tf:
                tf.seek(start)
                chunk = tf.read()
        except Exception:
            return 0, 0
        lines = chunk.splitlines()
        if start > 0 and lines:
            # A seek into the middle of the file cuts the first row in half.
            lines = lines[1:]
        for line in reversed(lines):
            if b'ephemeral_' not in line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if not isinstance(row, dict):
                # Valid JSON, but not a row: an array, a string, a number.
                continue
            if row.get('isSidechain'):
                # A subagent's own cache, not this conversation's.
                continue
            msg = row.get('message')
            usage = msg.get('usage') if isinstance(msg, dict) else None
            tiers = usage.get('cache_creation') if isinstance(usage, dict) else None
            if not isinstance(tiers, dict):
                continue
            if (tiers.get('ephemeral_1h_input_tokens') or 0) > 0:
                return 3600, row_time(row)
            if (tiers.get('ephemeral_5m_input_tokens') or 0) > 0:
                return 300, row_time(row)
        if start == 0:
            break
    return 0, 0

now = time.time()
total_in_now = cw.get('total_input_tokens', 0) or 0
api_call_happened = total_in_now > prev_total_in
gap = (now - prev_last_api_call_ts) if prev_last_api_call_ts > 0 else 0

# Right after /compact, Claude Code hands the status line an empty context window
# — used_percentage 0, current_usage all zeros — and keeps doing so until the
# user's next turn (anthropics/claude-code#86785, confirmed by a maintainer).
# Reporting that as 0% paints a confident green empty tank at the one moment
# someone looks at the gauge to see whether the compact worked. The window is not
# empty: it holds the summary and CLAUDE.md, and we cannot see how much. So the
# last real number is held and flagged as stale, and the extension says so.
# A brand-new session is a different thing entirely: it has no previous number,
# so its first 0% is real and is left alone.
context_unknown = False
if (inp + out + cache_create + cache_read) == 0 and total_in_now == 0 and prev_used_pct > 0:
    used_pct = prev_used_pct
    remaining_pct = max(0.0, 100.0 - used_pct)
    context_unknown = True

# Nothing about reading someone else's file may stop the gauge. Whatever shape
# a future transcript takes, the worst it can do here is leave the TTL unknown,
# and everything below knows what to do with that.
try:
    transcript_ttl, transcript_time = ttl_from_transcript(data.get('transcript_path', ''))
except Exception:
    transcript_ttl, transcript_time = 0, 0

# The transcript is the answer whenever it has one. detection_time stays 0
# unless this update actually observed something, because only a real
# observation is allowed to speak for the whole account further down.
detection_time = 0
if transcript_ttl > 0:
    detected_ttl = transcript_ttl
    detection_time = transcript_time or now
elif api_call_happened and gap > 310 and cache_read > 0:
    # No answer in the transcript — an old Claude Code that sends no
    # transcript_path, a file we cannot read, a row too big to scan past. Fall
    # back to the one thing token counts can prove: a cache that survived more
    # than five minutes cannot be on the five-minute tier. The opposite rule is
    # deliberately not here. A cache miss after a short gap usually means the
    # conversation changed, not that the cache expired, and reading it as an
    # expiry is the bug this release exists to fix.
    detected_ttl = 3600
    detection_time = now
elif prev_detected_ttl > 0:
    detected_ttl = prev_detected_ttl
else:
    detected_ttl = account_ttl

# When the last API call happened — the moment the countdown counts from.
if not cu:
    # /compact wiped current_usage: the context is new, so the cache clock
    # starts again. The TTL belongs to the account, not to the context, so it
    # is left alone.
    last_api_call_ts = 0
elif api_call_happened:
    last_api_call_ts = now
else:
    last_api_call_ts = prev_last_api_call_ts

# Persist account-wide, but only an observation that is newer than the one
# already stored. Without that test, opening a months-old session would let its
# last cache write speak for the account and put every new session on the wrong
# countdown — the same symptom this release fixes, through a different door.
# Written to a temp file first so two sessions updating at once cannot leave a
# half-written file behind.
if (account_ttl_file and detected_ttl > 0 and detection_time > 0
        and detected_ttl != account_ttl and detection_time >= account_detected_at):
    tmp_account = account_ttl_file + '.' + str(os.getpid()) + '.tmp'
    try:
        with open(tmp_account, 'w') as f:
            json.dump({'detected_ttl': detected_ttl, 'detected_at': detection_time}, f)
        os.replace(tmp_account, account_ttl_file)
    except Exception:
        try:
            os.unlink(tmp_account)
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
    'context_unknown': context_unknown,
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
" > "$BD_DIR/$session_id.json.$$.tmp" 2>>"$BD_LOG" && mv "$BD_DIR/$session_id.json.$$.tmp" "$BD_DIR/$session_id.json"
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

// Drop the lock and rediscover, leaving the file alone. The session file
// belongs to the bridge; a read or parse error is not evidence the session
// ended, and a half-written file from a concurrent bridge run heals itself on
// the next status line update.
function releaseTracking() {
  trackedSessionId = undefined;
  trackedExecution = undefined;
  trackedTerminal = undefined;
  claudeStartTime = undefined;
  lastTrackedTimestamp = undefined;
}

// The session genuinely ended (terminal closed, execution finished). Delete the
// file too, so Tier 3 does not pick up stale data.
function clearTracking() {
  if (trackedSessionId) {
    const filePath = path.join(os.homedir(), '.claude', 'fuel-gauge', `${trackedSessionId}.json`);
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  }
  releaseTracking();
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
  const bridge = installBridgeScript();
  if (bridge === 'absent') {
    void vscode.window.showWarningMessage(
      'Fuel Gauge: could not write the bridge script to ~/.claude/scripts, so the gauge cannot update. ' +
      'Run "Fuel Gauge: Show Diagnostics" for details.'
    );
  } else if (bridge === 'stale') {
    void vscode.window.showWarningMessage(
      'Fuel Gauge: could not update the bridge script in ~/.claude/scripts. An older copy is still ' +
      'in place, so the gauge keeps working. Run "Fuel Gauge: Show Diagnostics" for details.'
    );
  }
  // Never awaited: a modal must not block activation. Skipped when there is no
  // bridge script at all — pointing settings.json at a file that does not exist
  // is worse than leaving the user's status line alone.
  if (bridge !== 'absent') {
    void ensureStatusLineWired(context);
  }
  writeBridgeConfig();
  cleanupStaleSessions();
  cleanupTimer = setInterval(cleanupStaleSessions, 60 * 60 * 1000); // Hourly
  setupTerminalTracking(context);

  // Each item gets its own id and a readable name. VS Code lists status bar
  // items by name in the bar's right-click menu and remembers what a user hides
  // there, so naming them is what lets someone keep, say, the context gauge and
  // hide the cache countdown — without us inventing a setting for it. Items
  // created without an id all share the extension's id and cannot be told apart.
  statusBarItem = vscode.window.createStatusBarItem(
    'fuel-gauge.context',
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.name = 'Fuel Gauge: context';
  statusBarItem.tooltip = 'Claude Code Fuel Gauge';
  context.subscriptions.push(statusBarItem);

  cacheStatusBarItem = vscode.window.createStatusBarItem(
    'fuel-gauge.cache',
    vscode.StatusBarAlignment.Right,
    99
  );
  cacheStatusBarItem.name = 'Fuel Gauge: cache countdown';
  context.subscriptions.push(cacheStatusBarItem);

  effortStatusBarItem = vscode.window.createStatusBarItem(
    'fuel-gauge.modelEffort',
    vscode.StatusBarAlignment.Right,
    98
  );
  effortStatusBarItem.name = 'Fuel Gauge: model and effort';
  context.subscriptions.push(effortStatusBarItem);

  usageStatusBarItem = vscode.window.createStatusBarItem(
    'fuel-gauge.usage',
    vscode.StatusBarAlignment.Right,
    97
  );
  usageStatusBarItem.name = 'Fuel Gauge: usage alert';
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
//
// Every write here is guarded. This is the first thing activate() does, so an
// unwritable ~/.claude/scripts used to throw straight out of activation and
// take the whole extension with it — including Show Diagnostics, the one
// command built to explain that exact failure.
//
//   'installed' — the current script is on disk
//   'stale'     — the rewrite failed but an older script is still there, so
//                 the gauge keeps working
//   'absent'    — no bridge script at all; nothing will update
type BridgeInstall = 'installed' | 'stale' | 'absent';

function installBridgeScript(): BridgeInstall {
  const { scriptsDir, bridgePath } = claudePaths();

  try {
    fs.mkdirSync(scriptsDir, { recursive: true });
  } catch {
    return fs.existsSync(bridgePath) ? 'stale' : 'absent';
  }

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

  try {
    fs.writeFileSync(bridgePath, BRIDGE_SCRIPT, { mode: 0o755 });
    return 'installed';
  } catch {
    return fs.existsSync(bridgePath) ? 'stale' : 'absent';
  }
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
// Returns false when nothing was saved. The caller that is about to replace
// somebody else's command must honour that: the modal promises the existing
// command is kept, and a takeover with no restorable copy breaks the promise.
function recordBackup(context: vscode.ExtensionContext, previous: unknown, command: string | null): boolean {
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    const entries = readBackups(context);
    const newest = entries[entries.length - 1];
    if (newest && newest.previousCommandString === command) {
      return true; // Unchanged since the last capture.
    }
    entries.push({
      capturedAt: new Date().toISOString(),
      capturedByVersion: extensionVersion(),
      previousStatusLine: previous ?? null,
      previousCommandString: command,
    });
    fs.writeFileSync(backupPath(context), JSON.stringify(entries, null, 2) + '\n');
    return true;
  } catch {
    // Never silent, and never ignored by a caller about to overwrite something.
    void vscode.window.showWarningMessage(
      'Fuel Gauge: could not save a backup of your existing status line.'
    );
    return false;
  }
}

// Step 7: in-place write, object spread. Temp-plus-rename was rejected: it severs
// symlinked dotfiles and widens 0600 to 0644.
// Returns false rather than throwing: both callers sit inside a void'd async,
// where an exception is swallowed and the user is told nothing at all.
function writeStatusLine(settings: Record<string, unknown>, bridgePath: string): boolean {
  const { settingsPath } = claudePaths();
  const existing =
    settings.statusLine && typeof settings.statusLine === 'object' && !Array.isArray(settings.statusLine)
      ? (settings.statusLine as Record<string, unknown>)
      : {};
  settings.statusLine = { ...existing, type: 'command', command: bridgePath };
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `Fuel Gauge: could not write ~/.claude/settings.json (${reason}). Your status line was not changed.`
    );
    return false;
  }
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
    // An empty slot holds nothing that can be lost, so a failed backup does not
    // stop the connection here — it only costs the Undo, which needs a saved
    // entry to put the slot back the way it was.
    const backedUp = recordBackup(context, settings.statusLine, null);
    if (!writeStatusLine(settings, bridgePath)) {
      return;
    }
    statusLineOwner = 'ours';
    if (!backedUp) {
      void vscode.window.showInformationMessage(
        'Fuel Gauge: status line connected. Restart Claude Code to see context usage.'
      );
      return;
    }
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

  // The modal told the user their command would be saved first. If it was not,
  // we do not take the slot — a takeover with nothing to restore from is
  // exactly the damage this whole flow exists to prevent.
  if (!recordBackup(context, fresh.statusLine, state.command)) {
    void vscode.window.showWarningMessage(
      'Fuel Gauge: your status line was left alone, because the backup could not be saved.'
    );
    return;
  }
  if (!writeStatusLine(fresh, bridgePath)) {
    return;
  }
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

    // With the status bar items hidden when nothing matches, this is the only
    // place that answers "why is my gauge not there?".
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      add('This workspace', 'no folder is open, so no session can be matched to it');
    } else {
      add('This workspace', workspaceRoot);
      let matched: string | undefined;
      for (const { f } of files) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as ContextStatus;
          if (matchesWorkspace(d, workspaceRoot)) { matched = f; break; }
        } catch {
          // Unreadable or half-written — not this report's problem.
        }
      }
      add('Session for this workspace', matched ?? 'NONE — the gauge is hidden in this window. ' +
        'Claude Code sessions are matched by the folder they were started in, so a session ' +
        'started in a different folder will not appear here.');
    }
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

  // Bridge temp files are named <session>.json.<pid>.tmp and renamed into place
  // immediately. Anything still here an hour later is from a run that died
  // mid-write, and nothing will ever collect it otherwise.
  try {
    const tmpCutoff = Date.now() - (60 * 60 * 1000);
    for (const file of fs.readdirSync(fuelGaugeDir)) {
      if (!file.endsWith('.tmp')) { continue; }
      const tmpPath = path.join(fuelGaugeDir, file);
      try {
        if (fs.statSync(tmpPath).mtimeMs < tmpCutoff) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // Directory listing is best-effort
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
  // Clamped: an unclamped 0, a negative, or a non-number turned this into a
  // full directory scan every millisecond — the one setting a user can get
  // wrong and burn a core with.
  const configured = config.get<number>('pollInterval', 15);
  const intervalSeconds = Number.isFinite(configured)
    ? Math.min(Math.max(configured as number, 5), 3600)
    : 15;

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
      // Unreadable or half-written — drop the lock and rediscover via Tier 3,
      // but never delete: the file is the bridge's, not ours.
      releaseTracking();
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
// Reused instances, not fresh ones: VS Code compares status bar colors by
// reference, so a new ThemeColor on every render forced a needless re-apply
// once a second on three items.
const COLOR_RED = new vscode.ThemeColor('charts.red');
const COLOR_YELLOW = new vscode.ThemeColor('charts.yellow');
const COLOR_GREEN = new vscode.ThemeColor('charts.green');

function severityColor(sev: number): vscode.ThemeColor {
  if (sev >= 2) { return COLOR_RED; }
  if (sev >= 1) { return COLOR_YELLOW; }
  return COLOR_GREEN;
}

// Wall-clock time, for hover text that must stay byte-identical between
// one-second renders. It uses the machine's own clock format, the same call the
// rate-limit reset times use, so that one hover never mixes a 12-hour time with
// a 24-hour one. On a 12-hour machine that difference is what made the cache
// deadline unreadable: the bar showed 59:19 and the hover showed 13:22, and the
// two looked like disagreeing countdowns instead of a countdown and a clock.
function formatClockTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    // Nothing is running for this folder, so there is nothing to report and the
    // gauge gets out of the way. It used to say "0%", which read as a real
    // measurement of an empty context window; a "no session" label was honest
    // but sat in every window that is not running Claude, forever. The gauge
    // comes back on its own as soon as a session writes for this folder.
    // Why a window shows nothing is a question for Fuel Gauge: Show
    // Diagnostics, which names the folder and says whether a session matches it.
    statusBarItem.hide();
    cacheStatusBarItem.hide();
    effortStatusBarItem.hide();
    usageStatusBarItem.hide();
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
  // Right after /compact the number is the last one we had, not a measurement.
  // It shows with a tilde and no colour, because colouring it would state a
  // confidence we do not have.
  const contextUnknown = data.context_unknown === true;
  const contextColor = (fileAbandoned || contextUnknown) ? undefined : severityColor(contextSeverity);
  const contextLine = contextUnknown
    ? 'Context reading paused: Claude Code reports an empty window right after /compact. ' +
      'The number updates on your next turn.'
    : `Context&nbsp;${pct}%`;

  // Main item: context percentage only. The cache countdown is a separate item
  // (below) so it can carry its own urgency color independent of context.
  statusBarItem.text = `$(claude)$(dashboard) ${contextUnknown ? '~' : ''}${pct}%`;
  statusBarItem.color = contextColor;

  // Cache state — only meaningful if bridge has populated last_api_call_ts.
  const lastApiCallTs = data.last_api_call_ts ?? 0;
  const detectedTtl = data.detected_ttl ?? 0;
  const hasCacheInfo = lastApiCallTs > 0;

  if (!hasCacheInfo) {
    cacheStatusBarItem.hide();
    statusBarItem.tooltip = buildTooltip(
      modelCap, effortCap, effortLevel, contextLine, usageTip
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
    cacheColor = COLOR_RED;
    cacheTooltipFragment = `Cache: expired (${ttlLabel})`;
  } else {
    cacheText = formatCountdown(remaining);
    if (remaining < 15) {
      cacheColor = COLOR_RED;
    } else if (remaining < 60) {
      cacheColor = COLOR_YELLOW;
    } else {
      cacheColor = contextColor;
    }
    // The hover names the deadline instead of repeating the countdown that is
    // already ticking in the bar beside it. That keeps the tooltip string
    // identical from tick to tick, and VS Code compares tooltips by content —
    // so an open hover is left alone instead of being torn down every second.
    // Changing an item's text never touches the hover, so the bar keeps
    // counting down as before.
    // "at" marks the number as a clock time. Without it the reader sees two
    // numbers of the same shape — 59:19 in the bar, 13:22 in the hover — and
    // reads the second one as a second countdown that disagrees with the first
    // (ticket #3131).
    cacheTooltipFragment = `Cache expires at ${formatClockTime(lastApiCallTs + ttl)} (${ttlLabel})`;
  }

  // Rate-limit warning when overage downgrade is imminent.
  const rl = data.rate_limit_5h_pct ?? -1;
  const rateLimitWarning = rl >= 95
    ? ` · 5h limit ${Math.round(rl)}% — TTL may downgrade`
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
    `${contextLine}<br>${cacheTooltipFragment}${rateLimitWarning}`,
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
