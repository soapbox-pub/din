"""dindaemon: the key Din seals its secrets with, kept out of reach of
everything else `din` runs.

Din keeps secrets on disk: Mail's account passwords, the bunker's keys,
phone pairings, stream keys, and the key that opens Passwords' vault. Sealed
with the login keyring (Electron's safeStorage, gnome-keyring), any program
running as `din` could open them: the keyring hands an unlocked item to
whoever asks over the session bus. dindaemon runs as its own user, holds a
random key in a directory only it can read, and gives it to one process
alone: Din's main process, the direct child of din-shell.service's
compositor, which nothing else `din` runs can become (the check nostrd's
approver and din-password's askpass make too). Din seals with it in memory
(electron/sealing.mts), so what's on disk is useless without it.

Who's at the other end of a connection is the kernel's word: SO_PEERPIDFD
pins the connecting process, so one that connects and exits can't pass for
a later process that gets its pid, and its parent is read from /proc and
compared with the unit's main process, itself systemd's child.

The protocol is one JSON line each way: {"method": "key"} gets
{"key": "<base64>"}, or {"error": "..."}.

The key is made on first start and never replaced: losing it loses every
secret sealed with it, so a key file that's there but unreadable stops the
daemon rather than being written over.
"""

import argparse
import base64
import ctypes
import json
import os
import pwd
import secrets
import signal
import socket
import struct
import subprocess
import sys
import threading

KEY_BYTES = 32
# Not in Python's socket module yet (Linux 6.5).
SO_PEERPIDFD = 77
PR_SET_DUMPABLE = 4
MAX_REQUEST = 4096


def log(message):
    print(message, file=sys.stderr, flush=True)


def load_key(path):
    """The key, made the first time."""
    try:
        with open(path, "rb") as f:
            key = f.read()
    except FileNotFoundError:
        key = None
    if key is not None:
        if len(key) != KEY_BYTES:
            sys.exit(f"{path} isn't a key; not replacing it, as that would lose every secret sealed with it")
        return key
    key = secrets.token_bytes(KEY_BYTES)
    tmp = f"{path}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, key)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, path)
    dir_fd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    log("made a new key")
    return key


def stat(pid):
    """(ppid, start time in clock ticks since boot) from /proc/<pid>/stat, or None."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            text = f.read()
    except OSError:
        return None
    # The name, in parentheses, may hold anything; fields follow the last ')'.
    fields = text.rsplit(")", 1)[1].split()
    try:
        return int(fields[1]), int(fields[19])
    except (IndexError, ValueError):
        return None


def peer_process(sock):
    """(uid, pid, start) of the connecting process; pid and start None if it can't be pinned."""
    pid, uid, _ = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    try:
        pidfd = sock.getsockopt(socket.SOL_SOCKET, SO_PEERPIDFD)
    except OSError:
        # An older kernel: the pid from SO_PEERCRED, checked as well as it can be.
        info = stat(pid)
        return uid, pid, info[1] if info else None
    try:
        with open(f"/proc/self/fdinfo/{pidfd}") as f:
            pinned = next((int(line.split()[1]) for line in f if line.startswith("Pid:")), -1)
        info = stat(pinned) if pinned > 0 else None
        # What was read is the connecting process's only if it's still alive now.
        signal.pidfd_send_signal(pidfd, 0)
        if not info:
            return uid, None, None
        return uid, pinned, info[1]
    except (OSError, ValueError):
        return uid, None, None
    finally:
        os.close(pidfd)


class Daemon:
    def __init__(self, args):
        self.uid = pwd.getpwnam(args.user).pw_uid
        self.unit = args.unit
        self.systemctl = args.systemctl
        self.key = load_key(os.path.join(args.state_dir, "key"))

    def main_pid(self):
        try:
            shown = subprocess.run(
                [self.systemctl, "show", "--property=MainPID", "--value", self.unit],
                capture_output=True, text=True, timeout=10,
            )
            pid = int(shown.stdout.strip() or 0)
        except (OSError, ValueError, subprocess.SubprocessError):
            return None
        return pid if pid > 1 else None

    def is_din(self, sock):
        """Whether the other end is Din's main process: the user's, and the unit's main process's child."""
        uid, pid, start = peer_process(sock)
        if uid != self.uid or pid is None or start is None:
            return False
        info = stat(pid)
        if not info or info[1] != start:
            return False
        parent = info[0]
        # A service's main process is systemd's child; skip asking systemd otherwise.
        parent_info = stat(parent)
        if not parent_info or parent_info[0] != 1:
            return False
        if self.main_pid() != parent:
            return False
        # Still the same process, still its child.
        info = stat(pid)
        return bool(info) and info == (parent, start)

    def answer(self, request):
        if not isinstance(request, dict) or request.get("method") != "key":
            return {"error": "unknown method"}
        return {"key": base64.b64encode(self.key).decode()}

    def serve_one(self, conn):
        with conn:
            conn.settimeout(5)
            try:
                if not self.is_din(conn):
                    conn.sendall(b'{"error":"only Din can ask"}\n')
                    return
                data = b""
                while b"\n" not in data:
                    chunk = conn.recv(MAX_REQUEST)
                    if not chunk:
                        return
                    data += chunk
                    if len(data) > MAX_REQUEST:
                        return
                try:
                    request = json.loads(data.split(b"\n", 1)[0])
                except ValueError:
                    request = None
                conn.sendall((json.dumps(self.answer(request)) + "\n").encode())
            except OSError:
                pass

    def serve(self, path):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        # Anyone may connect; only Din is answered (is_din).
        os.chmod(path, 0o666)
        listener.listen(16)
        log(f"listening on {path}")
        while True:
            conn, _ = listener.accept()
            threading.Thread(target=self.serve_one, args=(conn,), daemon=True).start()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--user", required=True, help="the user Din runs as")
    parser.add_argument("--unit", required=True, help="the unit whose main process's child is Din")
    parser.add_argument("--systemctl", default="systemctl")
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--socket", required=True)
    args = parser.parse_args()
    # Nothing running as this user may attach to it or read its memory.
    ctypes.CDLL(None, use_errno=True).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
    Daemon(args).serve(args.socket)


if __name__ == "__main__":
    main()
