#!/usr/bin/env python3
"""PTY host for Din's Terminal app.

Electron's renderer is sandboxed and its main process ships no native
modules, so instead of node-pty this tiny helper (Python stdlib only)
owns the pseudo-terminal:

    pty-host.py <rows> <cols> shell <shell>
    pty-host.py <rows> <cols> app <program> [args...]

The second form runs a terminal app (htop) the apps menu opened in the
Terminal, in place of a shell.

  - fd 0 (stdin):  bytes from the terminal UI -> written to the pty
  - fd 1 (stdout): pty output -> streamed back to the terminal UI
  - fd 3:          control channel; newline-delimited "resize <rows> <cols>"
                   commands (TIOCSWINSZ needs an fd to the pty, which only
                   this process holds)
  - fd 4:          events; a JSON line {"type": "start", "command"} each time
                   a command takes the terminal (the Terminal names its tab
                   after it), and {"type": "done", "command", "seconds"} each
                   time the shell gets it back, so the Terminal can say when
                   a long one finishes

Commands are followed through the terminal's foreground process group:
whatever isn't the shell holds it while it runs. That works with any shell
and needs no prompt hooks, but can't see exit codes.

Exits when the shell exits or when stdin closes (terminal window closed),
taking the whole shell session down with it via SIGHUP.
"""

import fcntl
import json
import os
import re
import select
import shlex
import signal
import struct
import sys
import termios
import time

CONTROL_FD = 3
EVENTS_FD = 4
BUF_SIZE = 65536
# How often the foreground job is checked while the terminal is quiet, and
# for a moment after a keystroke (Enter may have just started a command).
JOB_POLL_SECONDS = 1.0
JOB_POLL_AFTER_INPUT_SECONDS = 0.05
INTERPRETERS = re.compile(r"^(python[\d.]*|node|perl|ruby|bash|sh|zsh|fish)$")


def set_winsize(fd: int, rows: int, cols: int) -> None:
    """Set the pty window size (the kernel SIGWINCHes the foreground job)."""
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def program_name(path: str) -> str:
    name = os.path.basename(path)
    # Nix wraps programs as .name-wrapped.
    if name.startswith(".") and name.endswith("-wrapped"):
        name = name[1 : -len("-wrapped")]
    return name


def command_line(pid: int) -> str:
    """A process's command line, as typed: program names without their paths."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            raw = f.read()
    except OSError:
        return ""
    args = [arg.decode("utf-8", "replace") for arg in raw.split(b"\0") if arg]
    if not args:
        return ""
    args[0] = program_name(args[0])
    # An interpreter running a script: the script is the command.
    if len(args) > 1 and INTERPRETERS.match(args[0]) and "/" in args[1]:
        args = [program_name(args[1])] + args[2:]
    return shlex.join(args)[:200]


def main() -> int:
    rows = int(sys.argv[1]) if len(sys.argv) > 1 else 24
    cols = int(sys.argv[2]) if len(sys.argv) > 2 else 80
    is_shell = len(sys.argv) < 5 or sys.argv[3] != "app"
    argv = sys.argv[4:] or [os.environ.get("SHELL", "/bin/sh")]

    import pty

    pid, master = pty.fork()
    if pid == 0:
        # Child: become the shell (or app), attached to the pty slave.
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        try:
            os.execvp(argv[0], argv)
        except OSError as error:
            if is_shell:
                os.execvp("/bin/sh", ["/bin/sh"])
            sys.stderr.write(f"{argv[0]}: {error.strerror}\r\n")
            os._exit(127)

    set_winsize(master, rows, cols)

    def shutdown(*_args: object) -> None:
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    events_open = True

    def emit(event: dict) -> None:
        nonlocal events_open
        if not events_open:
            return
        try:
            os.write(EVENTS_FD, (json.dumps(event) + "\n").encode())
        except OSError:  # nobody listening
            events_open = False

    # (started, command) while something other than the shell has the terminal.
    job = None

    def track_job() -> None:
        nonlocal job
        try:
            foreground = os.tcgetpgrp(master)
        except OSError:
            return
        if foreground > 0 and foreground != pid:
            if job is None:
                job = (time.monotonic(), command_line(foreground))
                emit({"type": "start", "command": job[1]})
        elif job is not None:
            started, command = job
            job = None
            emit({"type": "done", "command": command, "seconds": round(time.monotonic() - started, 1)})

    control_buf = b""
    fds = [master, 0, CONTROL_FD]
    last_input = 0.0

    try:
        while True:
            soon = job is None and time.monotonic() - last_input < 1
            try:
                ready, _, _ = select.select(
                    fds, [], [], JOB_POLL_AFTER_INPUT_SECONDS if soon else JOB_POLL_SECONDS
                )
            except InterruptedError:
                continue
            track_job()

            if master in ready:
                try:
                    data = os.read(master, BUF_SIZE)
                except OSError:  # EIO: shell exited, pty slave closed
                    break
                if not data:
                    break
                os.write(1, data)

            if 0 in ready:
                try:
                    data = os.read(0, BUF_SIZE)
                except OSError:
                    data = b""
                if not data:  # Electron closed our stdin: session abandoned
                    break
                os.write(master, data)
                last_input = time.monotonic()

            if CONTROL_FD in ready:
                try:
                    chunk = os.read(CONTROL_FD, BUF_SIZE)
                except OSError:
                    chunk = b""
                if chunk:
                    control_buf += chunk
                    while b"\n" in control_buf:
                        line, control_buf = control_buf.split(b"\n", 1)
                        parts = line.decode("ascii", "replace").split()
                        if len(parts) == 3 and parts[0] == "resize":
                            try:
                                set_winsize(master, int(parts[1]), int(parts[2]))
                            except (ValueError, OSError):
                                pass
                else:
                    fds = [fd for fd in fds if fd != CONTROL_FD]
    finally:
        shutdown()

    try:
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status) & 0xFF
    except OSError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
