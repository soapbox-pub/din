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
    din-lock woke     after waking from sleep: draw the whole lock screen again
"""

import ctypes
import fcntl
import glob
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


class DrmPlaneRes(ctypes.Structure):
    _fields_ = [("count_planes", ctypes.c_uint32), ("planes", ctypes.POINTER(ctypes.c_uint32))]


class DrmPlane(ctypes.Structure):
    _fields_ = [
        ("count_formats", ctypes.c_uint32),
        ("formats", ctypes.POINTER(ctypes.c_uint32)),
        ("plane_id", ctypes.c_uint32),
        ("crtc_id", ctypes.c_uint32),
        ("fb_id", ctypes.c_uint32),
    ]


class DrmObjectProperties(ctypes.Structure):
    _fields_ = [
        ("count_props", ctypes.c_uint32),
        ("props", ctypes.POINTER(ctypes.c_uint32)),
        ("prop_values", ctypes.POINTER(ctypes.c_uint64)),
    ]


class DrmProperty(ctypes.Structure):
    _fields_ = [("prop_id", ctypes.c_uint32), ("flags", ctypes.c_uint32), ("name", ctypes.c_char * 32)]


DRM_MODE_OBJECT_PLANE = 0xEEEEEEEE
DRM_CLIENT_CAP_UNIVERSAL_PLANES = 2
DRM_CLIENT_CAP_ATOMIC = 3
DRM_PLANE_TYPE_PRIMARY = 1


def libdrm():
    lib = ctypes.CDLL(os.environ.get("DIN_LIBDRM", "libdrm.so.2"))
    lib.drmModeGetPlaneResources.restype = ctypes.POINTER(DrmPlaneRes)
    lib.drmModeGetPlane.restype = ctypes.POINTER(DrmPlane)
    lib.drmModeGetPlane.argtypes = [ctypes.c_int, ctypes.c_uint32]
    lib.drmModeObjectGetProperties.restype = ctypes.POINTER(DrmObjectProperties)
    lib.drmModeObjectGetProperties.argtypes = [ctypes.c_int, ctypes.c_uint32, ctypes.c_uint32]
    lib.drmModeGetProperty.restype = ctypes.POINTER(DrmProperty)
    lib.drmModeGetProperty.argtypes = [ctypes.c_int, ctypes.c_uint32]
    lib.drmModeAtomicAlloc.restype = ctypes.c_void_p
    lib.drmModeAtomicAddProperty.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint64]
    lib.drmModeAtomicCommit.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p]
    lib.drmModeAtomicFree.argtypes = [ctypes.c_void_p]
    lib.drmSetClientCap.argtypes = [ctypes.c_int, ctypes.c_uint64, ctypes.c_uint64]
    return lib


def plane_properties(lib, fd, plane_id):
    """A plane's properties, by name: (id, value)."""
    found = {}
    props = lib.drmModeObjectGetProperties(fd, plane_id, DRM_MODE_OBJECT_PLANE)
    if not props:
        return found
    for i in range(props.contents.count_props):
        prop = lib.drmModeGetProperty(fd, props.contents.props[i])
        if prop:
            found[prop.contents.name.decode()] = (prop.contents.prop_id, props.contents.prop_values[i])
            lib.drmModeFreeProperty(prop)
    lib.drmModeFreeObjectProperties(props)
    return found


def clear_planes(timeout=5):
    """Turn off every plane but the screens' main ones, left as Din had them.

    Din's compositor shows windows on planes of their own (a full-screen
    overlay, the pointer), and when it loses the screen they stay as they
    were. Plymouth only replaces the main plane, beneath them, so the lock
    screen was hidden behind Din's last frame, frozen, while it took the
    password unseen. This waits for logind to take the screen from Din's
    session, the moment after the switch, then turns the others off.
    """
    try:
        lib = libdrm()
    except OSError:
        return
    for card in sorted(glob.glob("/dev/dri/card[0-9]*")):
        try:
            fd = os.open(card, os.O_RDWR | os.O_CLOEXEC)
        except OSError:
            continue
        try:
            deadline = time.monotonic() + timeout
            while lib.drmSetMaster(fd) != 0:
                if time.monotonic() > deadline:
                    break
                time.sleep(0.05)
            else:
                if (
                    lib.drmSetClientCap(fd, DRM_CLIENT_CAP_UNIVERSAL_PLANES, 1) == 0
                    and lib.drmSetClientCap(fd, DRM_CLIENT_CAP_ATOMIC, 1) == 0
                ):
                    clear_card_planes(lib, fd)
                lib.drmDropMaster(fd)
        finally:
            os.close(fd)


def clear_card_planes(lib, fd):
    res = lib.drmModeGetPlaneResources(fd)
    if not res:
        return
    req = lib.drmModeAtomicAlloc()
    count = 0
    for i in range(res.contents.count_planes):
        plane_id = res.contents.planes[i]
        plane = lib.drmModeGetPlane(fd, plane_id)
        if not plane:
            continue
        on = plane.contents.crtc_id != 0
        lib.drmModeFreePlane(plane)
        if not on:
            continue
        props = plane_properties(lib, fd, plane_id)
        if props.get("type", (0, DRM_PLANE_TYPE_PRIMARY))[1] == DRM_PLANE_TYPE_PRIMARY:
            continue
        if "CRTC_ID" in props and "FB_ID" in props:
            lib.drmModeAtomicAddProperty(req, plane_id, props["CRTC_ID"][0], 0)
            lib.drmModeAtomicAddProperty(req, plane_id, props["FB_ID"][0], 0)
            count += 1
    if count:
        lib.drmModeAtomicCommit(fd, req, 0, None)
    lib.drmModeAtomicFree(req)
    lib.drmModeFreePlaneResources(res)


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
    """Sends the time to the lock screen every minute, as at boot.

    It also redraws the whole screen when the computer wakes: Plymouth draws
    the screen once and then only what changes, and some computers lose
    what's on the screen while they sleep, which left it blank, though it
    still took the password. The theme redraws all of it on "din-redraw"
    (os/boot-screen/din.script), in the same Plymouth, so nothing is loaded
    again and what's being typed stays.
    """

    def __init__(self):
        super().__init__(daemon=True)
        self.format = clock_format()
        self.last = None
        self.again = threading.Event()
        self.redraw_screen = False

    def show(self):
        now = time.localtime()
        day = f"{time.strftime('%A, %B', now)} {now.tm_mday}"
        text = f"din-clock:{time.strftime(self.format, now)}|{day}"
        if self.last:
            plymouth("hide-message", f"--text={self.last}")
        plymouth("display-message", f"--text={text}")
        self.last = text

    def woke(self):
        """Redraw the screen, and the time, which moved on while asleep."""
        self.redraw_screen = True
        self.again.set()

    def restarted(self):
        """A new Plymouth has no clock yet."""
        self.last = None
        self.again.set()

    def run(self):
        while True:
            if self.redraw_screen:
                self.redraw_screen = False
                plymouth("display-message", "--text=din-redraw")
                plymouth("hide-message", "--text=din-redraw")
            self.show()
            # Not time.sleep, which stops counting while the computer sleeps.
            self.again.wait(60 - time.localtime().tm_sec)
            self.again.clear()


class Locker:
    def __init__(self):
        self.resumed = False
        self.asking = None
        self.clock = None

    def on_resumed(self, _signum, _frame):
        self.resumed = True
        if self.asking:
            self.asking.terminate()

    def on_woke(self, _signum, _frame):
        if self.clock:
            self.clock.woke()

    def restart_plymouth(self):
        """Plymouth again, when it has gone away; the screen stays locked."""
        try:
            self.start_plymouth()
        except (OSError, subprocess.CalledProcessError) as err:
            print(f"couldn't restart the lock screen: {err}", file=sys.stderr)
            time.sleep(1)
            return
        if self.clock:
            self.clock.restarted()

    def start_plymouth(self):
        plymouth("quit", stderr=subprocess.DEVNULL)
        subprocess.run(
            [
                "plymouthd",
                "--mode=boot",
                f"--tty=tty{LOCK_VT}",
                # Plymouth draws straight into the buffer on screen, and tells
                # the kernel with DirtyFB, which amdgpu refuses from programs;
                # with nothing asking for its frames, amdgpu's power saving
                # doesn't fetch them, and only Plymouth's first frame shows.
                # Setting the mode again on every redraw gets each to the screen.
                "--kernel-command-line=quiet splash plymouth.ignore-serial-consoles plymouth.set-mode-on-redraws",
            ],
            check=True,
        )
        plymouth("show-splash", check=True)

    def ask(self, hashed):
        """Ask until the right password comes, or the machine wakes from hibernation."""
        while not self.resumed:
            if plymouth("--ping").returncode != 0:
                self.restart_plymouth()
                continue
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
        signal.signal(signal.SIGUSR2, self.on_woke)
        # Stopped (or timed out) by systemd: still give the terminals back.
        signal.signal(signal.SIGTERM, lambda _signum, _frame: sys.exit(1))
        previous = active_vt()
        if previous == LOCK_VT:
            previous = 1
        prepare_images()
        switch_to(LOCK_VT)
        console_ioctl(VT_LOCKSWITCH)
        try:
            clear_planes()
            self.start_plymouth()
            self.clock = Clock()
            self.clock.start()
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
    elif command in ("resumed", "woke"):
        # Only while it's locked: with nothing to signal this does nothing.
        if subprocess.run(["systemctl", "is-active", "--quiet", UNIT]).returncode == 0:
            sig = "SIGUSR1" if command == "resumed" else "SIGUSR2"
            subprocess.run(
                ["systemctl", "kill", "--kill-whom=main", f"--signal={sig}", UNIT],
                stderr=subprocess.DEVNULL,
            )
    else:
        sys.exit("usage: din-lock run | start | status | resumed | woke")


if __name__ == "__main__":
    main()
