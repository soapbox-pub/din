"""din-password: changes the computer's one password, everywhere it's kept.

DinOS has one password (os/din-install.sh sets it): it unlocks the disk at
boot, it's `din`'s for sudo and the lock screen, it protects the Nostr
account keys in nostrd, and it's the login keyring's and the passphrase of any
GPG key that had it. This changes all five, after checking the old one itself,
so Din can run it through sudo without a password.

    din-password change    old and new password on stdin, one per line
    din-password sudo status|approve|password|skip
                           what sudo asks for: the user's approval in Din,
                           the password, or nothing. `approve` and `skip`
                           take the password on stdin (`approve` doesn't from
                           `skip`), so nothing `din` runs can loosen it
    din-password sudo grant
                           the password and a sudo's pid on stdin: sudo stops
                           asking in the Assistant conversation that sudo runs
                           in, for as long as its OpenCode server runs
    din-password sudo revoke
                           a conversation's id on stdin, or nothing for all
    din-password sudo check
                           sudo's PAM stack (pam_exec, as root): succeeds when
                           the sudo above it runs in a granted conversation,
                           or Din approves it

Passwords never go on a command line, where other users could read them:
cryptsetup gets them through pipes, nostrd over its socket, din-keyring,
din-gpg and chpasswd on stdin. The disk goes first, since it's the one that can't be got around:
if a later step fails, the message says what still has the old password.

sudo skips the password with a rule in /var/lib/din/sudoers.d, which sudoers
includes (os/configuration.nix); /etc/sudoers.d stays the owner's own.

A conversation's grant is a file in /run/din/sudo-grants, root's alone,
naming the OpenCode server whose commands it covers by pid and start time
(so a reused pid doesn't match). A sudo is let through when its
OPENCODE_SESSION_ID has a grant and that server is one of its ancestors:
commands from the Terminal, other programs or other servers still ask.

Unless /var/lib/din/sudo-password says to ask for the password instead, a
sudo that isn't granted asks Din to approve it before the password, over
Din's askpass socket (electron/askpass.mts): Allow lets it through, and
anything else - Deny, no answer, no Din - leaves it to the password. Only
Din's main process can answer: the socket's other end has to be the one
process din-shell's compositor starts, which nothing else `din` runs can
become, and whose Electron takes no debugger (os/configuration.nix). Its
`allow-session` answer grants the conversation, as `grant` does.

A sudo typed at the prompt of a Din Terminal tab is asked about too, and Din
opens its dialog at once for one with a terminal. Nothing in /proc tells one
the user typed from one a program they ran went on to exec, and anything
writing to the tab could fake any mark the shell left.
"""

import ctypes
import json
import os
import pwd
import socket
import struct
import subprocess
import sys
import time

USER = "din"
NOSTRD_SOCKET = "/run/nostrd/signer.sock"
SKIP_RULE = "/var/lib/din/sudoers.d/no-password"
ASK_PASSWORD = "/var/lib/din/sudo-password"
GRANTS = "/run/din/sudo-grants"
SHELL_SERVICE = "din-shell.service"
APPROVAL_TIMEOUT = 10 * 60


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


def change_gpg(old, new):
    """Only with gpg-agent up, as it is whenever `din` is logged in."""
    if not os.path.exists(f"/run/user/{pwd.getpwnam(USER).pw_uid}/gnupg/S.gpg-agent"):
        return
    result = subprocess.run(
        ["din-gpg", "change"], input=f"{old}\n{new}\n", text=True, capture_output=True
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
    try:
        change_gpg(old, new)
    except RuntimeError as error:
        fail("The disk, Nostr keys and keyring have the new password, but the GPG keys still "
             f"have the old one ({error}).")
    result = subprocess.run(["chpasswd"], input=f"{USER}:{new}\n", text=True, capture_output=True)
    if result.returncode != 0:
        fail("The disk, Nostr keys, keyring and GPG keys have the new password, but sudo and "
             "the lock screen still take the old one. " + result.stderr.strip())


def check_stdin_password():
    password = sys.stdin.read().split("\n")[0]
    hashed = password_hash()
    if not hashed:
        fail("This computer has no password.")
    if not password_matches(password, hashed):
        fail("That isn't the password.")


def remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def sudo_status():
    if os.path.exists(SKIP_RULE):
        return "skip"
    return "password" if os.path.exists(ASK_PASSWORD) else "approve"


def sudo_skip():
    check_stdin_password()
    os.makedirs(os.path.dirname(SKIP_RULE), mode=0o750, exist_ok=True)
    temporary = SKIP_RULE + ".tmp"
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o440), "w") as rule:
        rule.write(f"{USER} ALL=(ALL:ALL) NOPASSWD: ALL\n")
    os.rename(temporary, SKIP_RULE)


def sudo_approve():
    if sudo_status() == "password":
        check_stdin_password()
    remove(ASK_PASSWORD)
    remove(SKIP_RULE)


def sudo_password():
    os.makedirs(os.path.dirname(ASK_PASSWORD), mode=0o755, exist_ok=True)
    with open(os.open(ASK_PASSWORD, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644), "w"):
        pass
    remove(SKIP_RULE)


def proc(pid, name):
    with open(f"/proc/{pid}/{name}", "rb") as f:
        return f.read()


def stat(pid):
    """Parent pid and start time."""
    fields = proc(pid, "stat").decode().rsplit(")", 1)[1].split()
    return int(fields[1]), fields[19]


def session_of(pid):
    for entry in proc(pid, "environ").split(b"\0"):
        if entry.startswith(b"OPENCODE_SESSION_ID="):
            session = entry.split(b"=", 1)[1].decode("ascii", "replace")
            if session.startswith("ses_") and session[4:].isalnum() and len(session) <= 68:
                return session
    return None


def ancestors(pid):
    """Each process above pid: its pid, start time and name."""
    seen = 0
    pid = stat(pid)[0]
    while pid > 1 and seen < 64:
        parent, started = stat(pid)
        yield pid, started, proc(pid, "comm").decode().strip()
        pid, seen = parent, seen + 1


def sudo_grant():
    lines = sys.stdin.read().split("\n")
    if len(lines) < 2 or not lines[1].isdigit():
        fail("The password and sudo's pid are needed.")
    password, sudo = lines[0], int(lines[1])
    hashed = password_hash()
    if not hashed or not password_matches(password, hashed):
        fail("That isn't the password.")
    try:
        if proc(sudo, "comm").decode().strip() != "sudo":
            fail("That isn't sudo.")
        session = session_of(sudo)
        server = opencode_server(sudo)
    except OSError:
        fail("That sudo is gone.")
    if not session or not server:
        fail("That sudo isn't the Assistant's.")
    write_grant(session, server)


def opencode_server(sudo):
    """The OpenCode server above sudo: its pid and start time, or None."""
    return next(((pid, started) for pid, started, name in ancestors(sudo) if name == "opencode"), None)


def write_grant(session, server):
    os.makedirs(GRANTS, mode=0o700, exist_ok=True)
    temporary = os.path.join(GRANTS, f".{session}")
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as grant:
        grant.write(f"{server[0]} {server[1]}\n")
    os.rename(temporary, os.path.join(GRANTS, session))


def sudo_revoke():
    session = sys.stdin.read().strip()
    if session and not (session.startswith("ses_") and session[4:].isalnum()):
        fail("That isn't a conversation.")
    if not os.path.isdir(GRANTS):
        return
    for name in os.listdir(GRANTS):
        if not session or name == session:
            os.remove(os.path.join(GRANTS, name))


def granted(sudo, session):
    if not session:
        return False
    try:
        with open(os.path.join(GRANTS, session)) as grant:
            pid, started = grant.read().split()
    except (OSError, ValueError):
        return False
    return any(str(p) == pid and s == started for p, s, _ in ancestors(sudo))


def has_terminal(pid):
    return int(proc(pid, "stat").decode().rsplit(")", 1)[1].split()[4]) != 0


def din_shell():
    """The compositor din-shell.service runs, whose one child is Din's main process."""
    shown = subprocess.run(
        ["systemctl", "show", "--property=MainPID", "--value", SHELL_SERVICE],
        capture_output=True, text=True, timeout=10,
    )
    return int(shown.stdout.strip() or 0)


def ask_din(sudo, session):
    """Din's answer to approving sudo: allow, allow-session, deny, or None for none."""
    compositor = din_shell()
    # Din tries passwords with a sudo of its own.
    if compositor <= 1 or stat(stat(sudo)[0])[0] == compositor:
        return None
    uid = pwd.getpwnam(USER).pw_uid
    tty = has_terminal(sudo)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(5)
        sock.connect(f"/run/user/{uid}/din-askpass.sock")
        peer, peer_uid, _ = struct.unpack(
            "3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        )
        if peer_uid != uid or stat(peer)[0] != compositor:
            return None
        request = {"approve": True, "pid": sudo, "session": session, "tty": tty}
        sock.sendall((json.dumps(request) + "\n").encode())
        if tty:
            print("Waiting for you to allow this in Din...", flush=True)
        reply = b""
        deadline = time.monotonic() + APPROVAL_TIMEOUT
        sock.settimeout(1)
        while b"\n" not in reply:
            # sudo was stopped: nobody's waiting for the answer.
            if time.monotonic() > deadline or os.getppid() != sudo:
                return None
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                continue
            if not chunk or len(reply) > 4096:
                return None
            reply += chunk
    answer = json.loads(reply.split(b"\n", 1)[0])
    answer = answer.get("answer") if isinstance(answer, dict) else None
    if answer == "deny" and tty:
        print("Denied in Din.", flush=True)
    return answer


def sudo_check():
    if os.environ.get("PAM_SERVICE") != "sudo" or os.environ.get("PAM_USER") != USER:
        sys.exit(1)
    try:
        sudo = os.getppid()
        if proc(sudo, "comm").decode().strip() != "sudo":
            sys.exit(1)
        session = session_of(sudo)
        if granted(sudo, session):
            return
        if sudo_status() != "approve":
            sys.exit(1)
        answer = ask_din(sudo, session)
        if answer == "allow-session" and session:
            server = opencode_server(sudo)
            if server:
                write_grant(session, server)
    except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt):
        sys.exit(1)
    if answer not in ("allow", "allow-session"):
        sys.exit(1)


def main():
    args = sys.argv[1:]
    if args == ["change"]:
        change()
    elif args == ["sudo", "status"]:
        print(sudo_status())
    elif args == ["sudo", "approve"]:
        sudo_approve()
    elif args == ["sudo", "password"]:
        sudo_password()
    elif args == ["sudo", "skip"]:
        sudo_skip()
    elif args == ["sudo", "grant"]:
        sudo_grant()
    elif args == ["sudo", "revoke"]:
        sudo_revoke()
    elif args == ["sudo", "check"]:
        sudo_check()
    else:
        fail("usage: din-password change | sudo status|approve|password|skip|grant|revoke|check")


if __name__ == "__main__":
    main()
