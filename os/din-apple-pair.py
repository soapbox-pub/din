"""din-apple-pair: pair an Apple accessory over Bluetooth by plugging it in.

A Magic Mouse, Keyboard or Trackpad plugged in by USB is paired the way a
Mac pairs it, with no Bluetooth pairing at all: over USB, HID feature report
0x34 gives the accessory's Bluetooth address, class and name, and writing
report 0x35 (0x35 0x01 0x01, this computer's address, a link key) tells it
which computer to connect to and with what key. The same key goes into
BlueZ's bond for it, byte-reversed, and once bluetoothd has read that the
accessory is paired and trusted. An accessory already bonded gets its key
again, which needs nothing more; plugged into another computer since, it's
ours again. A new bond is only read when bluetoothd starts, so it restarts,
which drops other Bluetooth connections for a moment (Din connects the
headphones again, electron/bluetooth.mts).

The accessory waits to be called, so when it's unplugged it's connected.

    din-apple-pair pair hidrawN     from din-apple-pair@hidrawN.service, which
                                    udev starts for an Apple USB HID device
    din-apple-pair connect hidrawN  when that device goes (the unit's stop)
"""

import configparser
import fcntl
import json
import os
import secrets
import subprocess
import sys
import time

BLUEZ_DIR = "/var/lib/bluetooth"
RUN_DIR = "/run/din-apple-pair"
ADAPTER_WAIT_S = 30
CONNECT_WAIT_S = 30


def hid_ioctl(nr, length):
    return (3 << 30) | (length << 16) | (ord("H") << 8) | nr


def get_feature(fd, report_id):
    buf = bytearray(256)
    buf[0] = report_id
    n = fcntl.ioctl(fd, hid_ioctl(0x07, len(buf)), buf, True)
    return bytes(buf[:n])


def set_feature(fd, report):
    fcntl.ioctl(fd, hid_ioctl(0x06, len(report)), bytearray(report), True)


def bluez_objects():
    out = subprocess.run(
        ["busctl", "--json=short", "call", "org.bluez", "/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects"],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)["data"][0]


def adapter():
    """The first adapter's object path and address, once bluetoothd is up."""
    deadline = time.monotonic() + ADAPTER_WAIT_S
    while True:
        try:
            for path, ifaces in sorted(bluez_objects().items()):
                if "org.bluez.Adapter1" in ifaces:
                    return path, ifaces["org.bluez.Adapter1"]["Address"]["data"].upper()
        except (subprocess.CalledProcessError, KeyError, ValueError):
            pass
        if time.monotonic() > deadline:
            return None, None
        time.sleep(1)


def read_info(path):
    info = configparser.ConfigParser(interpolation=None)
    info.optionxform = str
    if os.path.exists(path):
        info.read(path)
    return info


def pair(node):
    try:
        fd = os.open(f"/dev/{node}", os.O_RDWR)
    except OSError as e:
        sys.exit(f"{node}: {e}")
    try:
        try:
            r34 = get_feature(fd, 0x34)
        except OSError:
            return  # Another of its interfaces.
        if len(r34) < 13 or r34[0] != 0x34:
            return
        address = ":".join("%02X" % b for b in r34[4:10])
        cls = "0x%02x%02x%02x" % tuple(r34[10:13])
        name = r34[13:].split(b"\0")[0].decode(errors="replace").strip() or "Apple accessory"

        _, ours = adapter()
        if not ours:
            sys.exit(f"{name}: no Bluetooth adapter")

        path = f"{BLUEZ_DIR}/{ours}/{address}/info"
        info = read_info(path)
        stored = info.get("LinkKey", "Key", fallback="")
        new = len(stored) != 32
        key = secrets.token_bytes(16) if new else bytes.fromhex(stored)[::-1]
        set_feature(fd, bytes([0x35, 0x01, 0x01]) + bytes.fromhex(ours.replace(":", "")) + key)
    finally:
        os.close(fd)

    os.makedirs(RUN_DIR, exist_ok=True)
    with open(f"{RUN_DIR}/{node}", "w") as f:
        f.write(address)

    if not new:
        print(f"{name} ({address}): paired with this computer again")
        return
    for section in ("General", "LinkKey"):
        if not info.has_section(section):
            info.add_section(section)
    info["General"].update({"Name": name, "Class": cls, "Trusted": "true", "Blocked": "false"})
    info["LinkKey"].update({"Key": key[::-1].hex().upper(), "Type": "4", "PINLength": "0"})
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        info.write(f, space_around_delimiters=False)
    os.replace(path + ".tmp", path)
    print(f"{name} ({address}): paired; restarting bluetoothd to load its key")
    # --no-block: this unit's start job is still running, and waiting on a
    # job ordered around it could wait forever.
    subprocess.run(["systemctl", "--no-block", "restart", "bluetooth.service"], check=True)


def connect(node):
    marker = f"{RUN_DIR}/{node}"
    # Still plugged in: stopped for another reason (shutting down).
    if os.path.exists(f"/dev/{node}") or not os.path.exists(marker):
        return
    with open(marker) as f:
        address = f.read().strip()
    os.remove(marker)
    adapter_path, _ = adapter()
    if not adapter_path:
        return
    device = f"{adapter_path}/dev_{address.replace(':', '_')}"
    deadline = time.monotonic() + CONNECT_WAIT_S
    while True:
        result = subprocess.run(
            ["busctl", "--timeout=15", "call", "org.bluez", device, "org.bluez.Device1", "Connect"],
            capture_output=True, text=True,
        )
        if result.returncode == 0 or "AlreadyConnected" in result.stderr:
            print(f"{address}: connected")
            return
        if time.monotonic() > deadline:
            print(f"{address}: couldn't connect: {result.stderr.strip()}")
            return
        time.sleep(2)


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("pair", "connect") or not sys.argv[2].startswith("hidraw"):
        sys.exit(__doc__)
    {"pair": pair, "connect": connect}[sys.argv[1]](sys.argv[2])
