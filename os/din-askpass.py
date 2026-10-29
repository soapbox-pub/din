"""din-askpass: sudo's askpass helper, which asks for the password in Din.

sudo runs it (sudo.conf's `Path askpass`) when it needs the password and has
no terminal to read it from, as for the Assistant's commands. It asks Din over
$XDG_RUNTIME_DIR/din-askpass.sock (electron/askpass.mts) with its parent's
pid, which is sudo's, and Din shows who's asking and for what. Din tries the
password before answering, so only the right one comes back, and it's printed
for sudo to read. Cancel, or no Din to ask, prints nothing and sudo fails as if
nothing was typed.
"""

import json
import os
import socket
import sys


def main():
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.connect(os.path.join(runtime, "din-askpass.sock"))
            sock.sendall((json.dumps({"pid": os.getppid()}) + "\n").encode())
            reply = sock.makefile("r", encoding="utf-8").readline()
        password = json.loads(reply).get("password")
    except (OSError, ValueError, AttributeError):
        sys.exit(1)
    if not isinstance(password, str):
        sys.exit(1)
    sys.stdout.write(password + "\n")


if __name__ == "__main__":
    main()
