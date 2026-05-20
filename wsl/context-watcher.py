#!/usr/bin/env python3
"""
WSL Transcript Watcher for Claude Code Fuel Gauge

When Claude Code's statusLine hook doesn't fire (common in WSL + VS Code extension
mode, see upstream bug #32660), this service watches transcript files directly using
Linux inotify and writes per-session JSON to ~/.claude/fuel-gauge/ in the same format
as the standard context-bridge.sh — so the Fuel Gauge extension picks it up seamlessly.

No dependencies beyond Python 3 stdlib (uses ctypes for inotify).

Usage:
    python3 context-watcher.py [--install | --uninstall | --status]

Options:
    --install     Install as systemd user service (context-watchdog.service)
    --uninstall   Remove the systemd user service
    --status      Check if the service is running
    (no args)     Run the watcher in foreground
"""

import ctypes, os, json, time, struct, glob, sys, signal, select, argparse, subprocess

LIBC = ctypes.CDLL("libc.so.6")

IN_MODIFY = 0x00000002
IN_CLOSE_WRITE = 0x00000008
IN_MOVED_TO = 0x00000080
IN_CREATE = 0x00000100

PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
FG_DIR = os.path.expanduser("~/.claude/fuel-gauge")
SERVICE_NAME = "fuel-gauge-watchdog"

running = True


def signal_handler(sig, frame):
    global running
    running = False

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)


# ── Context calculation ──────────────────────────────────────────────

def calc_context(transcript_path):
    """Extract last assistant usage from a transcript JSONL file."""
    last_usage = None
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    entry = json.loads(line.strip())
                    msg = entry.get('message', {})
                    if msg.get('role') == 'assistant' and 'usage' in msg:
                        last_usage = msg['usage']
                except (json.JSONDecodeError, KeyError):
                    pass
    except OSError:
        return None
    return last_usage


def build_session_json(usage, session_id, cwd=""):
    """Build per-session JSON in Fuel Gauge's expected format."""
    if not usage:
        return None

    inp = usage.get('input_tokens', 0) or 0
    out = usage.get('output_tokens', 0) or 0
    cache_create = usage.get('cache_creation_input_tokens', 0) or 0
    cache_read = usage.get('cache_read_input_tokens', 0) or 0
    total = inp + out + cache_create + cache_read

    # Read context window size from Fuel Gauge config if available
    window_size = 200000
    overhead = 0
    config_path = os.path.join(FG_DIR, 'config.json')
    try:
        with open(config_path) as f:
            cfg = json.load(f)
            window_size = cfg.get('contextWindowSize', window_size)
            overhead = cfg.get('systemOverhead', 0)
    except Exception:
        pass

    effective_window = max(1, window_size - overhead)
    used_pct = min(100.0, total * 100.0 / effective_window) if total > 0 else 0
    remaining_pct = max(0.0, 100.0 - used_pct)

    return {
        'cwd': cwd,
        'project_dir': cwd,
        'used_percentage': used_pct,
        'remaining_percentage': remaining_pct,
        'total_input_tokens': inp + cache_read + cache_create,
        'total_output_tokens': out,
        'context_window_size': window_size,
        'model': 'unknown',
        'session_id': session_id,
        'timestamp': time.time()
    }


def process_transcript(transcript_path):
    """Process a single transcript file and write session JSON."""
    session_id = os.path.basename(transcript_path).replace('.jsonl', '')
    if not session_id:
        return

    usage = calc_context(transcript_path)
    if not usage:
        return

    # Extract cwd from transcript
    cwd = ""
    try:
        with open(transcript_path, 'r') as f:
            for line in f:
                try:
                    entry = json.loads(line.strip())
                    if entry.get('cwd'):
                        cwd = entry['cwd']
                        break
                except Exception:
                    pass
    except OSError:
        pass

    data = build_session_json(usage, session_id, cwd)
    if data:
        os.makedirs(FG_DIR, exist_ok=True)
        path = os.path.join(FG_DIR, f"{session_id}.json")
        with open(path, 'w') as f:
            json.dump(data, f, indent=2)


def process_all():
    """Process all active sessions on startup."""
    cutoff = time.time() - 86400
    for jsonl in glob.glob(os.path.join(PROJECTS_DIR, "*", "*.jsonl")):
        try:
            if os.path.getmtime(jsonl) >= cutoff:
                process_transcript(jsonl)
        except OSError:
            pass


# ── inotify watcher ──────────────────────────────────────────────────

def watch():
    fd = LIBC.inotify_init()
    if fd < 0:
        print("inotify_init failed", file=sys.stderr)
        sys.exit(1)

    watched = {}
    for d in glob.glob(os.path.join(PROJECTS_DIR, "*")):
        if os.path.isdir(d):
            wd = LIBC.inotify_add_watch(
                fd, d.encode(),
                IN_MODIFY | IN_CLOSE_WRITE | IN_MOVED_TO | IN_CREATE
            )
            if wd >= 0:
                watched[wd] = d

    process_all()
    print(f"[fuel-gauge-watcher] Watching {len(watched)} directories, "
          f"writing to {FG_DIR}/", flush=True)

    BUF_SIZE = 4096
    debounce = {}

    while running:
        r, _, _ = select.select([fd], [], [], 1.0)
        if not r:
            continue

        data = os.read(fd, BUF_SIZE)
        pos = 0
        now = time.time()
        while pos < len(data):
            wd, mask, cookie, name_len = struct.unpack_from('iIII', data, pos)
            name = data[pos + 16:pos + 16 + name_len].rstrip(b'\x00').decode(
                'utf-8', errors='replace')
            pos += 16 + name_len

            if name.endswith('.jsonl') and wd in watched:
                changed_path = os.path.join(watched[wd], name)
                last = debounce.get(changed_path, 0)
                if now - last < 2.0:
                    continue
                debounce[changed_path] = now
                process_transcript(changed_path)

    for wd in watched:
        LIBC.inotify_rm_watch(fd, wd)
    os.close(fd)


# ── systemd install/uninstall ────────────────────────────────────────

SERVICE_UNIT = f"""[Unit]
Description=Fuel Gauge Transcript Watcher (WSL)
After=default.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 {os.path.abspath(__file__)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"""


def install():
    systemd_dir = os.path.expanduser("~/.config/systemd/user")
    os.makedirs(systemd_dir, exist_ok=True)

    service_path = os.path.join(systemd_dir, f"{SERVICE_NAME}.service")
    with open(service_path, 'w') as f:
        f.write(SERVICE_UNIT)

    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", f"{SERVICE_NAME}.service"], check=True)
    print(f"Installed and started {SERVICE_NAME}.service")
    show_status()


def uninstall():
    subprocess.run(["systemctl", "--user", "disable", "--now", f"{SERVICE_NAME}.service"],
                   capture_output=True)
    service_path = os.path.expanduser(f"~/.config/systemd/user/{SERVICE_NAME}.service")
    if os.path.exists(service_path):
        os.remove(service_path)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    print(f"Uninstalled {SERVICE_NAME}.service")


def show_status():
    result = subprocess.run(
        ["systemctl", "--user", "status", f"{SERVICE_NAME}.service"],
        capture_output=True, text=True
    )
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr)


# ── Main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="WSL Transcript Watcher for Claude Code Fuel Gauge")
    parser.add_argument('--install', action='store_true', help='Install as systemd user service')
    parser.add_argument('--uninstall', action='store_true', help='Remove the systemd user service')
    parser.add_argument('--status', action='store_true', help='Check service status')
    args = parser.parse_args()

    if args.install:
        install()
    elif args.uninstall:
        uninstall()
    elif args.status:
        show_status()
    else:
        watch()


if __name__ == '__main__':
    main()
