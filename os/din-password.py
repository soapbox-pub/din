"""din-password: changes the computer's one password, everywhere it's kept.

DinOS has one password (os/din-install.sh sets it): it unlocks the disk at
boot, it's `din`'s for sudo and the lock screen, it protects the Nostr
account keys in nostrd, and it's the login keyring's. This changes all four,
after checking the old one itself, so Din can run it through sudo without a
password.

    din-password change    old and new password on stdin, one per line

Passwords never go on a command line, where other users could read them:
cryptsetup gets them through pipes, nostrd over its socket, din-keyring and
chpasswd on stdin. The disk goes first, since it's the one that can't be got around:
if a later step fails, the message says what still has the old password.
"""

import ctypes
import json
import os
import pwd
import socket
import subprocess
import sys

USER = "din"
NOSTRD_SOCKET = "/run/nostrd/signer.sock"


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def password_hash():
    with open("/etc/shadow") as shadow:
        for line in shadow:
            fields = line.rstrip("\n").split(":")
            if fields[0] == USER and len(fields) > 1:
                hashed = fields[1]
                return None if not hashed or hashed.startswith(("!", "*")) else hashed
    return None


def password_matches(password, hashed):
    libcrypt = ctypes.CDLL(os.environ.get("DIN_LIBCRYPT", "libcrypt.so.2"))
    libcrypt.crypt.restype = ctypes.c_char_p
    libcrypt.crypt.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    result = libcrypt.crypt(password.encode(), hashed.encode())
    return result is not None and result.decode() == hashed


def usable(password):
    """Printable ASCII, as the Installer asks for: it's typed at boot."""
    return 8 <= len(password) <= 512 and all(" " <= c <= "~" for c in password)


def luks_partition():
    """The partition under root's encryption, or None for a plain root."""
    root = subprocess.run(
        ["findmnt", "-nvo", "SOURCE", "/"], capture_output=True, text=True, check=True
    ).stdout.strip()
    chain = subprocess.run(
        ["lsblk", "-nsrpo", "NAME,TYPE", root], capture_output=True, text=True, check=True
    ).stdout.split("\n")
    devices = [line.split() for line in chain if line.strip()]
    for i, (_, kind) in enumerate(devices):
        if kind == "crypt" and i + 1 < len(devices):
            return devices[i + 1][0]
    return None


def change_disk(partition, old, new):
    old_read, old_write = os.pipe()
    new_read, new_write = os.pipe()
    os.write(old_write, old.encode())
    os.write(new_write, new.encode())
    os.close(old_write)
    os.close(new_write)
    try:
        result = subprocess.run(
            [
                "cryptsetup", "luksChangeKey", "--batch-mode",
                f"--key-file=/dev/fd/{old_read}", partition, f"/dev/fd/{new_read}",
            ],
            pass_fds=(old_read, new_read),
            capture_output=True,
            text=True,
        )
    finally:
        os.close(old_read)
        os.close(new_read)
    if result.returncode != 0:
        fail("The disk's password couldn't be changed; nothing was. " + result.stderr.strip())


def nostrd_call(method, params):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.connect(NOSTRD_SOCKET)
        stream = sock.makefile("rw", encoding="utf-8")
        stream.readline()
        stream.write(json.dumps({"id": "1", "method": method, "params": params}) + "\n")
        stream.flush()
        reply = json.loads(stream.readline())
    if reply.get("error"):
        raise RuntimeError(reply["error"].get("message", "error"))
    return reply.get("result")


def change_nostrd(old, new):
    if not os.path.exists(NOSTRD_SOCKET):
        return
    status = nostrd_call("status", [])
    if status.get("has_password"):
        nostrd_call("change_password", [old, new])
    else:
        nostrd_call("set_password", [new])


def change_keyring(old, new):
    """Only a running keyring: one that isn't picks the new one up at boot."""
    if not os.path.exists(f"/run/user/{pwd.getpwnam(USER).pw_uid}/keyring/control"):
        return
    result = subprocess.run(
        ["din-keyring", "change"], input=f"{old}\n{new}\n", text=True, capture_output=True
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())


def change():
    lines = sys.stdin.read().split("\n")
    if len(lines) < 2:
        fail("The old and new passwords are needed.")
    old, new = lines[0], lines[1]
    hashed = password_hash()
    if not hashed:
        fail("This computer has no password to change.")
    if not password_matches(old, hashed):
        fail("That isn't the current password.")
    if not usable(new):
        fail("The new password needs 8 or more letters, numbers or symbols, and no others.")

    partition = luks_partition()
    if partition:
        change_disk(partition, old, new)
    try:
        change_nostrd(old, new)
    except (OSError, RuntimeError) as error:
        fail(f"The disk has the new password, but the Nostr keys still have the old one ({error}).")
    try:
        change_keyring(old, new)
    except RuntimeError as error:
        fail("The disk and Nostr keys have the new password, but the keyring still has the "
             f"old one ({error}).")
    result = subprocess.run(["chpasswd"], input=f"{USER}:{new}\n", text=True, capture_output=True)
    if result.returncode != 0:
        fail("The disk, Nostr keys and keyring have the new password, but sudo and the lock "
             "screen still take the old one. " + result.stderr.strip())


def main():
    if sys.argv[1:] == ["change"]:
        change()
    else:
        fail("usage: din-password change")


if __name__ == "__main__":
    main()
