#!/usr/bin/env python3
"""PTY host for Din's Terminal app.

Electron's renderer is sandboxed and its main process ships no native
modules, so instead of node-pty this tiny helper (Python stdlib only)
owns the pseudo-terminal:

    pty-host.py <shell> <rows> <cols>

  - fd 0 (stdin):  bytes from the terminal UI -> written to the pty
  - fd 1 (stdout): pty output -> streamed back to the terminal UI
  - fd 3:          control channel; newline-delimited "resize <rows> <cols>"
                   commands (TIOCSWINSZ needs an fd to the pty, which only
                   this process holds)

Exits when the shell exits or when stdin closes (terminal window closed),
taking the whole shell session down with it via SIGHUP.
"""

import fcntl
import os
import select
import signal
import struct
import sys
import termios

CONTROL_FD = 3
BUF_SIZE = 65536


def set_winsize(fd: int, rows: int, cols: int) -> None:
    """Set the pty window size (the kernel SIGWINCHes the foreground job)."""
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main() -> int:
    shell = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SHELL", "/bin/sh")
    rows = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 80

    import pty

    pid, master = pty.fork()
    if pid == 0:
        # Child: become the shell, attached to the pty slave.
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        try:
            os.execvp(shell, [shell])
        except OSError:
            os.execvp("/bin/sh", ["/bin/sh"])

    set_winsize(master, rows, cols)

    def shutdown(*_args: object) -> None:
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    control_buf = b""
    fds = [master, 0, CONTROL_FD]

    try:
        while True:
            try:
                ready, _, _ = select.select(fds, [], [])
            except InterruptedError:
                continue

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
