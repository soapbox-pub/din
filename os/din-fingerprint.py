"""Root-only fprintd client for DinOS's lock screen."""

import asyncio
import json
import os
from pathlib import Path
import sys

from dbus_next import Message, MessageType
from dbus_next.aio import MessageBus
from dbus_next.errors import DBusError


SERVICE = "net.reactivated.Fprint"
MANAGER = "/net/reactivated/Fprint/Manager"
DEVICE = f"{SERVICE}.Device"
PROPERTIES = "org.freedesktop.DBus.Properties"
# fprintd uses hyphens in property names. dbus-next rejects them when it
# parses introspection XML, so declare the methods and request properties by name.
DEVICE_API = f"""
<node>
  <interface name="{DEVICE}">
    <method name="ListEnrolledFingers"><arg type="s" direction="in"/><arg type="as" direction="out"/></method>
    <method name="Claim"><arg type="s" direction="in"/></method>
    <method name="EnrollStart"><arg type="s" direction="in"/></method>
    <method name="EnrollStop"/>
    <method name="VerifyStart"><arg type="s" direction="in"/></method>
    <method name="VerifyStop"/>
    <method name="DeleteEnrolledFinger"><arg type="s" direction="in"/></method>
    <signal name="EnrollStatus"><arg type="s"/><arg type="b"/></signal>
    <signal name="VerifyStatus"><arg type="s"/><arg type="b"/></signal>
  </interface>
  <interface name="{PROPERTIES}">
    <method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
  </interface>
</node>
"""
ACTIVE_TTY = Path("/sys/class/tty/tty0/active")
FINGERS = {
    f"{hand}-{finger}"
    for hand in ("left", "right")
    for finger in ("thumb", "index-finger", "middle-finger", "ring-finger", "little-finger")
}


async def enrolled(device, user):
    try:
        return await device.call_list_enrolled_fingers(user)
    except DBusError as error:
        if error.type != f"{SERVICE}.Error.NoEnrolledPrints":
            raise
        return []


def report(**data):
    print(json.dumps(data), flush=True)


async def enroll(device, props, finger):
    stages = max(1, (await props.call_get(DEVICE, "num-enroll-stages")).value)
    swipe = (await props.call_get(DEVICE, "scan-type")).value == "swipe"
    events = asyncio.Queue()
    device.on_enroll_status(lambda result, done: events.put_nowait((result, done)))
    await device.call_enroll_start(finger)
    passed = 0
    report(status="ready", passed=passed, stages=stages, swipe=swipe)
    while True:
        result, done = await events.get()
        if done:
            if result != "enroll-disconnected":
                await device.call_enroll_stop()
            if result == "enroll-completed":
                return
            raise RuntimeError({
                "enroll-duplicate": "That fingerprint is already saved. Try a different finger.",
                "enroll-data-full": "The reader has no room for another fingerprint.",
                "enroll-disconnected": "The fingerprint reader disconnected.",
            }.get(result, "The reader couldn’t save this fingerprint. Try again."))
        if result == "enroll-stage-passed":
            passed = min(passed + 1, stages - 1)
        report(status=result, passed=passed, stages=stages, swipe=swipe)


async def verify(device):
    events = asyncio.Queue()
    device.on_verify_status(lambda result, done: events.put_nowait((result, done)))
    for attempt in range(3):
        await asyncio.wait_for(device.call_verify_start("any"), 8)
        if attempt == 0:
            print("ready", flush=True)
        while True:
            result, done = await events.get()
            if done:
                break
        if result == "verify-match":
            return True
        if result != "verify-no-match":
            break
        await asyncio.wait_for(device.call_verify_stop(), 8)
    return False


async def operate(action, user, finger, enabled, timeout=None):
    # Each operation has a private connection. Closing it also cancels the
    # reader claim in fprintd (including if the locker or Electron exits).
    bus = MessageBus(bus_address="unix:path=/run/dbus/system_bus_socket")
    try:
        await bus.connect()
        node = await bus.introspect(SERVICE, MANAGER)
        manager = bus.get_proxy_object(SERVICE, MANAGER, node).get_interface(f"{SERVICE}.Manager")
        devices = await manager.call_get_devices()
        if not devices:
            if action == "status":
                report(reader=None, fingers=[], enabled=enabled.exists())
                return True
            raise RuntimeError("No supported fingerprint reader is connected.")
        path = await manager.call_get_default_device()
        owner = await bus.call(Message(
            destination="org.freedesktop.DBus", path="/org/freedesktop/DBus",
            interface="org.freedesktop.DBus", member="GetNameOwner",
            signature="s", body=[SERVICE],
        ))
        if owner.message_type != MessageType.METHOD_RETURN or owner.sender != "org.freedesktop.DBus":
            raise RuntimeError("Fingerprint service is unavailable.")
        # Verification signals must come from this connection, not whoever
        # takes the well-known name if the daemon restarts.
        obj = bus.get_proxy_object(owner.body[0], path, DEVICE_API)
        device = obj.get_interface(DEVICE)
        props = obj.get_interface(PROPERTIES)
        if action == "status":
            reader = (await props.call_get(DEVICE, "name")).value
            report(reader=reader, fingers=await enrolled(device, user), enabled=enabled.exists())
            return True
        await device.call_claim(user)
        if action == "verify":
            # The reader stays ready at the lock screen. Only setup and the
            # D-Bus calls time out, not waiting for someone to touch it.
            timeout.reschedule(None)
            return enabled.exists() and await verify(device) and enabled.exists()
        if action == "enroll":
            fingers = await enrolled(device, user)
            if finger in fingers:
                raise RuntimeError("That finger is already set up.")
            await enroll(device, props, finger)
            if not fingers:
                enabled.touch(mode=0o600, exist_ok=True)
        elif action == "remove":
            await device.call_delete_enrolled_finger(finger)
            if not await enrolled(device, user):
                enabled.unlink(missing_ok=True)
        elif action == "enable":
            if not await enrolled(device, user):
                raise RuntimeError("Add a fingerprint before turning on fingerprint unlock.")
            enabled.touch(mode=0o600, exist_ok=True)
        return True
    finally:
        bus.disconnect()


async def cancellable_enrollment(user, finger, enabled, lock_vt):
    loop = asyncio.get_running_loop()
    cancel = loop.create_future()
    fd = sys.stdin.fileno()

    def cancelled():
        loop.remove_reader(fd)
        cancel.set_result(None)

    async def watch_terminal():
        # Don't keep taking scans for Settings once the lock screen takes over.
        while ACTIVE_TTY.read_text().strip() != f"tty{lock_vt}":
            await asyncio.sleep(0.1)

    # Electron keeps stdin open after sending the password. EOF means Cancel,
    # a closed setup window, or an exited desktop.
    loop.add_reader(fd, cancelled)
    try:
        async with asyncio.TaskGroup() as group:
            work = group.create_task(operate("enroll", user, finger, enabled))
            locked = group.create_task(watch_terminal())
            await asyncio.wait((cancel, work, locked), return_when=asyncio.FIRST_COMPLETED)
            if cancel.done() or locked.done():
                work.cancel()
            locked.cancel()
    except ExceptionGroup as error:
        raise error.exceptions[0] from None
    finally:
        loop.remove_reader(fd)
    if cancel.done() or work.cancelled():
        raise RuntimeError("Fingerprint setup was canceled.")
    return work.result()


def run(action, user, finger, enabled, lock_vt):
    if action in ("enroll", "remove") and finger not in FINGERS:
        sys.exit("Choose a valid finger.")
    if action == "disable":
        enabled.unlink(missing_ok=True)
        return
    if action == "verify" and not enabled.exists():
        sys.exit(1)
    if action in ("enable", "enroll") and ACTIVE_TTY.read_text().strip() == f"tty{lock_vt}":
        sys.exit("Unlock the screen before setting up a fingerprint.")

    async def timed():
        async with asyncio.timeout(90 if action == "enroll" else 8) as timeout:
            if action == "enroll":
                return await cancellable_enrollment(user, finger, enabled, lock_vt)
            return await operate(action, user, finger, enabled, timeout)

    try:
        if not asyncio.run(timed()):
            sys.exit(1)
    except TimeoutError:
        sys.exit("The fingerprint reader took too long. Try again.")
    except DBusError as error:
        if error.type == f"{SERVICE}.Error.AlreadyInUse":
            sys.exit("The fingerprint reader is busy. Try again in a moment.")
        sys.exit("The fingerprint reader couldn’t complete the request.")
    except (OSError, RuntimeError) as error:
        sys.exit(str(error))
