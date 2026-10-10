#!/bin/bash
# Brain Drain for Claude Code — Context Bridge
# Reads statusline JSON from stdin, writes to ~/.claude/fuel-gauge/{session_id}.json
# Configure in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "/path/to/context-bridge.sh" }

input=$(cat)

BD_DIR="$HOME/.claude/fuel-gauge"
BD_LOG="$BD_DIR/bridge.log"
mkdir -p "$BD_DIR"

session_id=$(echo "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>>"$BD_LOG")

if [ -z "$session_id" ]; then
  echo "[$(date -Iseconds)] No session_id in input" >> "$BD_LOG"
  exit 0
fi

echo "$input" | python3 -c "
import sys, json, time

data = json.load(sys.stdin)
cw = data.get('context_window', {})
cu = cw.get('current_usage') or {}
window_size = cw.get('context_window_size', 200000) or 200000

# Compute percentage including output tokens for accurate effective usage
# (used_percentage from Claude Code is input-only and underreports at high context)
inp = cu.get('input_tokens', 0) or 0
out = cu.get('output_tokens', 0) or 0
cache_create = cu.get('cache_creation_input_tokens', 0) or 0
cache_read = cu.get('cache_read_input_tokens', 0) or 0
total = inp + out + cache_create + cache_read

if total > 0 and window_size > 0:
    used_pct = min(100.0, total * 100.0 / window_size)
    remaining_pct = max(0.0, 100.0 - used_pct)
else:
    used_pct = cw.get('used_percentage', 0) or 0
    remaining_pct = cw.get('remaining_percentage', 100) or 100

# Use workspace.project_dir (stable launch dir) with cwd as fallback
ws = data.get('workspace', {})
project_dir = ws.get('project_dir', '') or data.get('cwd', '')

output = {
    'cwd': data.get('cwd', ''),
    'project_dir': project_dir,
    'used_percentage': used_pct,
    'remaining_percentage': remaining_pct,
    'total_input_tokens': cw.get('total_input_tokens', 0),
    'total_output_tokens': cw.get('total_output_tokens', 0),
    'context_window_size': window_size,
    'model': data.get('model', {}).get('id', 'unknown') if isinstance(data.get('model'), dict) else data.get('model', 'unknown'),
    'session_id': data.get('session_id', ''),
    'timestamp': time.time()
}

print(json.dumps(output, indent=2))
" > "$BD_DIR/$session_id.json" 2>>"$BD_LOG"
