"""din-gpg: unlocks and re-keys `din`'s GPG keys with the computer's password.

A GPG key whose passphrase is the computer's password is unlocked at boot for
the whole session (din-gpg-unlock in configuration.nix), with the passphrase
typed at the boot screen, so signing a commit asks for nothing; din-password
changes its passphrase with the others. Keys with another passphrase are left
alone, and gpg-agent asks for theirs when they're used. Only keys that can
sign count: a signature is how a passphrase is checked.

    din-gpg unlock    password on stdin
    din-gpg change    old and new password on stdin, one per line

Run as root, it does its work as `din`, through `din`'s gpg-agent.
"""

import os
import subprocess
import sys

USER = "din"
UID = 1000
RUNTIME_DIR = f"/run/user/{UID}"


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
        sys.executable, os.path.abspath(__file__), *sys.argv[1:],
    ])


def gpg(*args, data=None):
    # --no-autostart: an agent started here would die with this process, and
    # the passphrases with it; the one systemd starts for `din` stays.
    return subprocess.run(
        ["gpg", "--batch", "--no-autostart", "--pinentry-mode", "loopback", *args],
        input=data, text=True, capture_output=True,
    )


def signing_keys():
    """(fingerprint, keygrips) of each secret key that can sign."""
    listing = gpg("--with-colons", "--with-keygrip", "--list-secret-keys").stdout
    keys = []
    for line in listing.split("\n"):
        fields = line.split(":")
        if fields[0] == "sec":
            keys.append({"sign": len(fields) > 11 and "S" in fields[11], "fpr": None, "grips": []})
        elif not keys:
            continue
        elif fields[0] == "fpr" and keys[-1]["fpr"] is None:
            keys[-1]["fpr"] = fields[9]
        elif fields[0] == "grp":
            keys[-1]["grips"].append(fields[9])
    return [(key["fpr"], key["grips"]) for key in keys if key["sign"] and key["fpr"]]


def forget_passphrases():
    """Empty the agent's cache, so a check can't pass on a passphrase it holds."""
    subprocess.run(["gpgconf", "--reload", "gpg-agent"], capture_output=True)


def opens(fpr, password):
    return gpg("--passphrase-fd", "0", "--local-user", fpr, "--sign", "--yes",
               "--output", "/dev/null", "/dev/null", data=password + "\n").returncode == 0


def preset(grips, password):
    for grip in grips:
        subprocess.run(["gpg-preset-passphrase", "--preset", grip],
                       input=password, text=True, capture_output=True)


def unlock(password):
    forget_passphrases()
    for fpr, grips in signing_keys():
        if opens(fpr, password):
            preset(grips, password)


def change(old, new):
    forget_passphrases()
    changed = []
    for fpr, grips in signing_keys():
        # It checks the old passphrase, and fails on any other.
        if gpg("--command-fd", "0", "--passwd", fpr, data=f"{old}\n{new}\n").returncode == 0:
            changed += grips
        # Changing one leaves its old passphrase cached, which would let the
        # next key's check pass on it.
        forget_passphrases()
    preset(changed, new)


def main():
    command = sys.argv[1:]
    if command not in (["unlock"], ["change"]):
        fail("usage: din-gpg unlock|change")
    if os.geteuid() == 0:
        as_din()
    socket = subprocess.run(["gpgconf", "--list-dirs", "agent-socket"],
                            capture_output=True, text=True).stdout.strip()
    if not os.path.exists(socket):
        fail("gpg-agent isn't running.")

    # A cached disk passphrase can be several, NUL-separated; the first is it.
    lines = sys.stdin.read().split("\0")[0].split("\n")
    if command == ["unlock"]:
        unlock(lines[0])
    else:
        if len(lines) < 2:
            fail("The old and new passwords are needed.")
        change(lines[0], lines[1])


if __name__ == "__main__":
    main()
