"""din-lock: DinOS's lock screen.

The lock screen is the boot screen (os/boot-screen/din.script), drawn by a
Plymouth of its own on another virtual terminal, run as root. Nothing Din or
its apps do can get past it: they run as `din`, can't touch this process,
and can't switch back to Din's terminal, since switching terminals is turned
off (VT_LOCKSWITCH) until the password is typed. While Din's terminal isn't
the active one its session has no keyboard or screen, so nothing typed here
reaches it.

The password is `din`'s, the computer's one password, checked against
/etc/shadow. Where `din` has none (the live stick, an install without
encryption) there's nothing to lock with, and nothing locks.

    din-lock run      the lock screen itself; din-lock.service runs it
    din-lock start    lock now (Din's Lock menu item, through sudo)
    din-lock status   "available" when the computer can be locked
    din-lock resumed  after waking from hibernation: the disk's password
                      was just typed at boot, so let the user straight in
"""

import ctypes
import fcntl
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

USER = "din"
LOCK_VT = 8
UNIT = "din-lock.service"
BOOT_DIR = "/run/din-boot"
ESP_DIR = "/boot/din"
THEME_DIR = "/etc/plymouth/themes/din"

VT_ACTIVATE = 0x5606
VT_LOCKSWITCH = 0x560B
VT_UNLOCKSWITCH = 0x560C


def password_hash():
    """din's hash from /etc/shadow, or None when din has no password."""
    with open("/etc/shadow") as shadow:
        for line in shadow:
            fields = line.rstrip("\n").split(":")
            if fields[0] == USER:
                hashed = fields[1] if len(fields) > 1 else ""
                if hashed and not hashed.startswith(("!", "*")):
                    return hashed
                return None
    return None


def password_matches(password, hashed):
    libcrypt = ctypes.CDLL(os.environ.get("DIN_LIBCRYPT", "libcrypt.so.2"))
    libcrypt.crypt.restype = ctypes.c_char_p
    libcrypt.crypt.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    result = libcrypt.crypt(password.encode(), hashed.encode())
    return result is not None and result.decode() == hashed


def console_ioctl(request, arg=0):
    fd = os.open("/dev/tty0", os.O_RDWR | os.O_NOCTTY)
    try:
        fcntl.ioctl(fd, request, arg)
    finally:
        os.close(fd)


def active_vt():
    with open("/sys/class/tty/tty0/active") as active:
        return int(active.read().strip().removeprefix("tty"))


def switch_to(vt):
    """Switch terminals, or fail if it doesn't happen within a few seconds."""
    console_ioctl(VT_ACTIVATE, vt)
    for _ in range(50):
        if active_vt() == vt:
            return
        time.sleep(0.1)
    raise RuntimeError(f"couldn't switch to terminal {vt}")


def plymouth(*args, **kwargs):
    return subprocess.run(["plymouth", *args], **kwargs)


def notify(state):
    path = os.environ.get("NOTIFY_SOCKET")
    if not path:
        return
    if path.startswith("@"):
        path = "\0" + path[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
        sock.connect(path)
        sock.sendall(state.encode())


def prepare_images():
    """The theme's images, and the wallpaper as it is now, where Plymouth looks."""
    os.makedirs(BOOT_DIR, exist_ok=True)
    for name in os.listdir(THEME_DIR):
        if name.endswith(".png"):
            shutil.copyfile(os.path.join(THEME_DIR, name), os.path.join(BOOT_DIR, name))
    wallpaper = os.path.join(ESP_DIR, "wallpaper.png")
    target = os.path.join(BOOT_DIR, "wallpaper.png")
    if os.path.isfile(wallpaper):
        shutil.copyfile(wallpaper, target)
    elif os.path.exists(target):
        os.remove(target)


def clock_format():
    try:
        with open(os.path.join(ESP_DIR, "clock")) as clock:
            if clock.read(2) == "12":
                return "%I:%M %p"
    except OSError:
        pass
    return "%H:%M"


class Clock(threading.Thread):
    """Sends the time to the lock screen every minute, as at boot."""

    def __init__(self):
        super().__init__(daemon=True)
        self.format = clock_format()
        self.last = None

    def show(self):
        now = time.localtime()
        day = f"{time.strftime('%A, %B', now)} {now.tm_mday}"
        text = f"din-clock:{time.strftime(self.format, now)}|{day}"
        if self.last:
            plymouth("hide-message", f"--text={self.last}")
        plymouth("display-message", f"--text={text}")
        self.last = text

    def run(self):
        while True:
            self.show()
            time.sleep(60 - time.localtime().tm_sec)


class Locker:
    def __init__(self):
        self.resumed = False
        self.asking = None

    def on_resumed(self, _signum, _frame):
        self.resumed = True
        if self.asking:
            self.asking.terminate()

    def start_plymouth(self):
        plymouth("quit", stderr=subprocess.DEVNULL)
        subprocess.run(
            [
                "plymouthd",
                "--mode=boot",
                f"--tty=tty{LOCK_VT}",
                "--kernel-command-line=quiet splash plymouth.ignore-serial-consoles",
            ],
            check=True,
        )
        plymouth("show-splash", check=True)

    def ask(self, hashed):
        """Ask until the right password comes, or the machine wakes from hibernation."""
        while not self.resumed:
            if plymouth("--ping").returncode != 0:
                self.start_plymouth()
            self.asking = subprocess.Popen(
                ["plymouth", "ask-for-password", "--prompt=Password"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            answer, _ = self.asking.communicate()
            self.asking = None
            if self.resumed:
                return
            password = answer.decode(errors="replace").rstrip("\n")
            if password and password_matches(password, hashed):
                return

    def run(self):
        hashed = password_hash()
        if not hashed:
            notify("READY=1")
            return
        signal.signal(signal.SIGUSR1, self.on_resumed)
        # Stopped (or timed out) by systemd: still give the terminals back.
        signal.signal(signal.SIGTERM, lambda _signum, _frame: sys.exit(1))
        previous = active_vt()
        if previous == LOCK_VT:
            previous = 1
        prepare_images()
        switch_to(LOCK_VT)
        console_ioctl(VT_LOCKSWITCH)
        try:
            self.start_plymouth()
            Clock().start()
            notify("READY=1")
            self.ask(hashed)
        finally:
            plymouth("quit", stderr=subprocess.DEVNULL)
            console_ioctl(VT_UNLOCKSWITCH)
            switch_to(previous)


def main():
    command = sys.argv[1] if len(sys.argv) == 2 else ""
    if command == "run":
        Locker().run()
    elif command == "start":
        if not password_hash():
            sys.exit("This computer has no password to lock with.")
        subprocess.run(["systemctl", "start", "--no-block", UNIT], check=True)
    elif command == "status":
        print("available" if password_hash() else "unavailable")
    elif command == "resumed":
        subprocess.run(
            ["systemctl", "kill", "--kill-whom=main", "--signal=SIGUSR1", UNIT],
            stderr=subprocess.DEVNULL,
        )
    else:
        sys.exit("usage: din-lock run | start | status | resumed")


if __name__ == "__main__":
    main()
