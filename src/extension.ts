import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

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

# Read system overhead from config (written by VS Code extension)
overhead = 18000
config_path = os.path.join(os.path.expanduser('~'), '.claude', 'fuel-gauge', 'config.json')
try:
    with open(config_path) as f:
        cfg = json.load(f)
        overhead = cfg.get('systemOverhead', 18000)
except Exception:
    pass

# Compute percentage including output tokens for accurate effective usage
# (used_percentage from Claude Code is input-only and underreports at high context)
# Subtract system overhead from window size to account for invisible tokens
# (system prompt, tool definitions, MCP configs, CLAUDE.md)
inp = cu.get('input_tokens', 0) or 0
out = cu.get('output_tokens', 0) or 0
cache_create = cu.get('cache_creation_input_tokens', 0) or 0
cache_read = cu.get('cache_read_input_tokens', 0) or 0
total = inp + out + cache_create + cache_read

if total > 0 and window_size > 0:
    effective_window = max(1, window_size - overhead)
    used_pct = min(100.0, total * 100.0 / effective_window)
    remaining_pct = max(0.0, 100.0 - used_pct)
else:
    used_pct = cw.get('used_percentage', 0) or 0
    remaining_pct = cw.get('remaining_percentage', 100) or 100

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

# Rate limit pass-through (defensive — field may be absent)
rate_limit_5h_pct = -1
try:
    rate_limit_5h_pct = data.get('rate_limits', {}).get('five_hour', {}).get('used_percentage', -1)
    if rate_limit_5h_pct is None:
        rate_limit_5h_pct = -1
except Exception:
    rate_limit_5h_pct = -1

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
    'effort_level': effort_level,
}

print(json.dumps(output, indent=2))
" > "$BD_DIR/$session_id.json.tmp" 2>>"$BD_LOG" && mv "$BD_DIR/$session_id.json.tmp" "$BD_DIR/$session_id.json"
`;

let statusBarItem: vscode.StatusBarItem;
let cacheStatusBarItem: vscode.StatusBarItem;
let effortStatusBarItem: vscode.StatusBarItem;
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
  const systemOverhead = config.get<number>('systemOverhead', 18000);

  try {
    fs.mkdirSync(fuelGaugeDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ systemOverhead }, null, 2) + '\n');
  } catch {
    // Config write is best-effort
  }
}

export function activate(context: vscode.ExtensionContext) {
  setupBridge();
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

  startPolling();
  startCountdown();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fuel-gauge')) {
        writeBridgeConfig();
        startPolling();
      }
    })
  );
}

function setupBridge() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const scriptsDir = path.join(claudeDir, 'scripts');
  const bridgePath = path.join(scriptsDir, 'context-bridge.sh');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // Install bridge script
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(bridgePath, BRIDGE_SCRIPT, { mode: 0o755 });

  // Configure statusLine in settings.json
  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    }
  } catch {
    // Start fresh if settings file is corrupt
  }

  const currentCommand = (settings.statusLine as Record<string, unknown>)?.command;
  if (currentCommand === bridgePath) {
    return; // Already configured
  }

  settings.statusLine = {
    type: 'command',
    command: bridgePath,
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  if (!currentCommand) {
    vscode.window.showInformationMessage(
      'Fuel Gauge: Bridge installed. Restart Claude Code to see context usage.'
    );
  } else {
    vscode.window.showWarningMessage(
      `Fuel Gauge: Updated statusLine command (was: ${currentCommand}). Restart Claude Code to apply.`
    );
  }
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

// Severity → ThemeColor for the merged context+cache item (0 green, 1 yellow, 2 red).
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
  statsLine: string
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
  md.appendMarkdown(lines.join('<br>'));
  return md;
}

function renderStatus() {
  const data = cachedData;
  const { modelCap, effortCap, effortLevel } = renderModelEffort(data);

  // The cache countdown is merged into the main item now, so its own status bar
  // item stays hidden permanently.
  cacheStatusBarItem.hide();

  if (!data) {
    statusBarItem.text = '$(claude)$(dashboard) 0%';
    statusBarItem.color = undefined;
    statusBarItem.tooltip = 'Fuel Gauge — No active Claude Code session';
    statusBarItem.show();
    return;
  }

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

  // Cache state — only meaningful if bridge has populated last_api_call_ts
  const lastApiCallTs = data.last_api_call_ts ?? 0;
  const detectedTtl = data.detected_ttl ?? 0;
  const hasCacheInfo = lastApiCallTs > 0;

  // Ultimate file-age safety floor: if bridge file hasn't updated in over an hour,
  // surface it explicitly. (Below this, cache-expiry handles the freshness signal.)
  const fileAgeSeconds = (Date.now() / 1000) - data.timestamp;
  const fileAbandoned = fileAgeSeconds > 3600;

  if (!hasCacheInfo) {
    statusBarItem.text = `$(claude)$(dashboard) ${pct}%`;
    statusBarItem.color = fileAbandoned ? undefined : severityColor(contextSeverity);
    statusBarItem.tooltip = buildTooltip(
      modelCap, effortCap, effortLevel, `Context&nbsp;${pct}%`
    );
    statusBarItem.show();
    return;
  }

  const { ttl, source } = resolveTTL(detectedTtl);
  const remaining = ttl - ((Date.now() / 1000) - lastApiCallTs);
  const ttlLabel = describeTTLSource(ttl, source);

  maybePlayCacheWarningBeep(data, remaining);

  let cacheText: string;
  let cacheSeverity = 0;
  let cacheTooltipFragment: string;

  if (remaining <= 0) {
    cacheText = '$(circle-slash) expired';
    cacheSeverity = 2;
    cacheTooltipFragment = `Cache: expired (${ttlLabel})`;
  } else {
    cacheText = formatCountdown(remaining);
    if (remaining < 15) {
      cacheSeverity = 2;
    } else if (remaining < 60) {
      cacheSeverity = 1;
    }
    cacheTooltipFragment = `Cache: ${formatCountdown(remaining)} remaining (${ttlLabel})`;
  }

  // Rate-limit warning when overage downgrade is imminent
  const rl = data.rate_limit_5h_pct ?? -1;
  const rateLimitWarning = rl >= 95
    ? ` &middot; 5h limit ${rl}% — TTL may downgrade`
    : '';

  // Merged item: percentage + cache countdown; color reflects the more urgent
  // of the two signals (the numbers themselves say which one is in danger).
  statusBarItem.text = `$(claude)$(dashboard) ${pct}% · ${cacheText}`;
  statusBarItem.color = fileAbandoned
    ? undefined
    : severityColor(Math.max(contextSeverity, cacheSeverity));
  statusBarItem.tooltip = buildTooltip(
    modelCap,
    effortCap,
    effortLevel,
    `Context&nbsp;${pct}%<br>${cacheTooltipFragment}${rateLimitWarning}`
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
