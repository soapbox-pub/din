"""din-keyring: unlocks and re-keys `din`'s login keyring with the computer's password.

The login keyring's password is the computer's, as on any desktop: the boot
screen's password unlocks it (din-keyring-unlock in configuration.nix), and
din-password changes it with the others. Both go through gnome-keyring's
control socket, the way pam_gnome_keyring does at login and on passwd.

    din-keyring unlock    password on stdin; creates the keyring if missing
    din-keyring change    old and new password on stdin, one per line

Run as root, it does its work as `din`: the daemon only answers its own user.
"""

import os
import socket
import struct
import subprocess
import sys
import time

USER = "din"
UID = 1000
RUNTIME_DIR = f"/run/user/{UID}"

OP_UNLOCK = 1
OP_CHANGE = 2
OP_QUIT = 3
RESULTS = {0: "ok", 1: "denied", 2: "failed", 3: "no daemon"}


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def as_din():
    """Re-run this command as `din`, in its session's environment."""
    os.execvp("setpriv", [
        "setpriv", f"--reuid={USER}", "--regid=users", "--init-groups",
        "--inh-caps=-all", "--ambient-caps=-all", "--",
        "env", "-i", f"PATH={os.environ.get('PATH', '')}", f"HOME=/home/{USER}",
        f"XDG_RUNTIME_DIR={RUNTIME_DIR}",
        f"DBUS_SESSION_BUS_ADDRESS=unix:path={RUNTIME_DIR}/bus",
        sys.executable, os.path.abspath(__file__), *sys.argv[1:],
    ])


def start_daemon():
    """D-Bus-activate the daemon, so it runs in the user manager, not here."""
    subprocess.run(
        ["busctl", "--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus",
         "org.freedesktop.DBus", "StartServiceByName", "su", "org.freedesktop.secrets", "0"],
        check=True, stdout=subprocess.DEVNULL,
    )


def bus_name_owned():
    result = subprocess.run(
        ["busctl", "--user", "call", "org.freedesktop.DBus", "/org/freedesktop/DBus",
         "org.freedesktop.DBus", "NameHasOwner", "s", "org.freedesktop.secrets"],
        check=True, capture_output=True, text=True,
    )
    return result.stdout.strip() == "b true"


def unlock(password):
    keyring = os.path.join(
        os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")),
        "keyrings", "login.keyring",
    )
    created = not os.path.exists(keyring)
    result = control(OP_UNLOCK, password)
    if result != 0 or not created:
        return result
    # A login keyring the running daemon just created isn't on the bus until
    # it starts again (it is when PAM has the daemon create it at startup).
    # Restart it, and unlock what's now on disk.
    control(OP_QUIT)
    for _ in range(50):
        if not bus_name_owned():
            break
        time.sleep(0.1)
    start_daemon()
    return control(OP_UNLOCK, password)


def control(op, *args):
    path = os.path.join(os.environ.get("XDG_RUNTIME_DIR", RUNTIME_DIR), "keyring", "control")
    packet = struct.pack(">I", op)
    for arg in args:
        packet += struct.pack(">I", len(arg)) + arg
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(path)
        # The daemon checks the peer's uid; this byte is what it reads first.
        sock.sendall(b"\0")
        sock.sendall(struct.pack(">I", len(packet) + 4) + packet)
        reply = b""
        while len(reply) < 8:
            chunk = sock.recv(8 - len(reply))
            if not chunk:
                break
            reply += chunk
    if len(reply) != 8:
        return 2
    return struct.unpack(">II", reply)[1]


def main():
    command = sys.argv[1:]
    if command not in (["unlock"], ["change"]):
        fail("usage: din-keyring unlock|change")
    if os.geteuid() == 0:
        as_din()

    # The cached disk passphrase is every one typed at the boot screen, oldest
    # first and NUL-separated; the disk opened on the last. Trying the typos
    # too would be worse than useless: after a failed unlock, gnome-keyring
    # re-keys the keyring with that password the next time it's unlocked.
    lines = sys.stdin.buffer.read().rstrip(b"\0").split(b"\0")[-1].split(b"\n")
    try:
        start_daemon()
        if command == ["unlock"]:
            result = unlock(lines[0])
        else:
            if len(lines) < 2:
                fail("The old and new passwords are needed.")
            result = control(OP_CHANGE, lines[0], lines[1])
    except (OSError, subprocess.CalledProcessError) as error:
        fail(f"The keyring isn't running: {error}")
    if result != 0:
        fail(f"The keyring said: {RESULTS.get(result, result)}")


if __name__ == "__main__":
    main()
