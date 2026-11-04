"""din-polkit-agent: polkit's authentication agent for Din's session.

When a program asks polkit for something that needs the computer's password
(pkexec, systemctl, udisks…), polkitd hands the question to the
authentication agent registered for the user's session; without one it's
refused, and pkexec's own fallback, a prompt on its terminal, fails under
polkit 127's socket-activated helper (polkit-org/polkit#686). Din's main
process (electron/polkit-agent.mts) runs this as its child and asks the user
in Din.

Din's own processes aren't in a logind session of their own (they're in the
user's systemd manager), so this registers for the user's display session,
the one polkitd takes for a process outside any session.

It speaks JSON lines with Din over stdin and stdout:

  out {"type": "ready", "session": "c2"}
  out {"type": "request", "id": 1, "action": "...", "message": "...",
       "user": "din", "realName": "...", "self": true, "details": {...}}
  in  {"type": "answer", "id": 1, "password": "..."}   # or null to cancel
  out {"type": "result", "id": 1, "ok": false}          # wrong; ask again
  out {"type": "done", "id": 1}                         # answered or cancelled

The password goes to polkit's own helper (polkit-agent-helper-1, through
PolkitAgent.Session), which checks it with PAM and tells polkitd; it isn't
kept. A request polkitd cancels (the program went away) is "done" too.
"""

import json
import os
import pwd
import subprocess
import sys

import gi

gi.require_version("Polkit", "1.0")
gi.require_version("PolkitAgent", "1.0")
from gi.repository import Gio, GLib, Polkit, PolkitAgent  # noqa: E402

OBJECT_PATH = "/org/dinos/PolkitAgent"
MAX_LINE = 65536
POLKIT = "org.freedesktop.PolicyKit1"
AUTHORITY_PATH = "/org/freedesktop/PolicyKit1/Authority"
AUTHORITY = "org.freedesktop.PolicyKit1.Authority"
# PyGObject can't finish PolkitAgent.Listener's async vfunc (returning its
# GTask crashes), so this is the agent's D-Bus side itself, as
# libpolkit-agent's listener would export it.
AGENT_XML = """
<node>
  <interface name="org.freedesktop.PolicyKit1.AuthenticationAgent">
    <method name="BeginAuthentication">
      <arg type="s" name="action_id" direction="in"/>
      <arg type="s" name="message" direction="in"/>
      <arg type="s" name="icon_name" direction="in"/>
      <arg type="a{ss}" name="details" direction="in"/>
      <arg type="s" name="cookie" direction="in"/>
      <arg type="a(sa{sv})" name="identities" direction="in"/>
    </method>
    <method name="CancelAuthentication">
      <arg type="s" name="cookie" direction="in"/>
    </method>
  </interface>
</node>
"""


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def display_session():
    """The user's display session, as logind has it, or None."""
    try:
        out = subprocess.run(
            ["loginctl", "show-user", str(os.getuid()), "-p", "Display", "--value"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out or None


def pick_uid(identities):
    """This user, if polkit takes them, else the first user it names."""
    uids = [int(details["uid"]) for kind, details in identities if kind == "unix-user" and "uid" in details]
    if os.getuid() in uids:
        return os.getuid()
    return uids[0] if uids else None


class Request:
    def __init__(self, rid, invocation, cookie, uid):
        self.id = rid
        self.invocation = invocation
        self.cookie = cookie
        self.uid = uid
        self.session = None
        self.password = None


class Agent:
    def __init__(self):
        self.next_id = 1
        self.requests = {}

    def on_call(self, _connection, sender, _path, _interface, method, params, invocation):
        # Only polkitd, as the bus has it, asks.
        if sender != self.polkitd:
            invocation.return_dbus_error("org.freedesktop.PolicyKit1.Error.Failed", "Not polkitd")
            return
        if method == "BeginAuthentication":
            self.begin(invocation, *params.unpack())
        elif method == "CancelAuthentication":
            (cookie,) = params.unpack()
            for request in list(self.requests.values()):
                if request.cookie == cookie:
                    self.finish(request.id, False)
            invocation.return_value(None)

    def begin(self, invocation, action_id, message, _icon_name, details, cookie, identities):
        uid = pick_uid(identities)
        if uid is None:
            invocation.return_dbus_error("org.freedesktop.PolicyKit1.Error.Failed", "No user to authenticate as")
            return
        rid = self.next_id
        self.next_id += 1
        self.requests[rid] = Request(rid, invocation, cookie, uid)
        try:
            entry = pwd.getpwuid(uid)
            user, real_name = entry.pw_name, entry.pw_gecos.split(",")[0]
        except KeyError:
            user, real_name = str(uid), ""
        send({
            "type": "request",
            "id": rid,
            "action": action_id,
            "message": message,
            "user": user,
            "realName": real_name,
            "self": uid == os.getuid(),
            "details": dict(details),
        })

    def finish(self, rid, ok):
        request = self.requests.pop(rid, None)
        if request is None:
            return
        if request.session is not None:
            request.session.cancel()
            request.session = None
        if ok:
            request.invocation.return_value(None)
        else:
            request.invocation.return_dbus_error("org.freedesktop.PolicyKit1.Error.Cancelled", "Authentication was cancelled")
        send({"type": "done", "id": rid})

    def answer(self, rid, password):
        request = self.requests.get(rid)
        if request is None or request.session is not None:
            return
        if not isinstance(password, str):
            self.finish(rid, False)
            return
        request.password = password
        session = PolkitAgent.Session.new(Polkit.UnixUser.new(request.uid), request.cookie)
        request.session = session
        session.connect("request", self.on_request, rid)
        session.connect("completed", self.on_completed, rid)
        session.initiate()

    def on_request(self, session, _prompt, _echo_on, rid):
        request = self.requests.get(rid)
        if request is None or request.session is not session or request.password is None:
            # PAM asked a second question (a new password, a code): Din
            # has only the one answer.
            session.cancel()
            return
        password, request.password = request.password, None
        session.response(password)

    def on_completed(self, session, gained, rid):
        request = self.requests.get(rid)
        if request is None or request.session is not session:
            return
        request.session = None
        request.password = None
        if gained:
            self.finish(rid, True)
        else:
            send({"type": "result", "id": rid, "ok": False})


def read_commands(agent, loop):
    stdin = GLib.IOChannel.unix_new(sys.stdin.fileno())
    stdin.set_encoding(None)
    buffer = bytearray()

    def on_input(channel, condition):
        if condition & (GLib.IO_HUP | GLib.IO_ERR):
            loop.quit()
            return False
        try:
            chunk = os.read(sys.stdin.fileno(), 4096)
        except OSError:
            loop.quit()
            return False
        if not chunk:
            loop.quit()
            return False
        buffer.extend(chunk)
        while b"\n" in buffer:
            line, _, rest = bytes(buffer).partition(b"\n")
            buffer[:] = rest
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("type") == "answer" and isinstance(message.get("id"), int):
                agent.answer(message["id"], message.get("password"))
        if len(buffer) > MAX_LINE:
            buffer.clear()
        return True

    GLib.io_add_watch(stdin, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_input)


def main():
    session_id = display_session()
    if not session_id:
        send({"type": "error", "message": "No login session to register for"})
        sys.exit(1)
    agent = Agent()
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
        owner = bus.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner",
            GLib.Variant("(s)", (POLKIT,)), GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, -1, None,
        )
        agent.polkitd = owner.unpack()[0]
        info = Gio.DBusNodeInfo.new_for_xml(AGENT_XML).interfaces[0]
        bus.register_object_with_closures2(OBJECT_PATH, info, agent.on_call, None, None)
        subject = GLib.Variant("(sa{sv})", ("unix-session", {"session-id": GLib.Variant("s", session_id)}))
        bus.call_sync(
            POLKIT, AUTHORITY_PATH, AUTHORITY, "RegisterAuthenticationAgent",
            GLib.Variant.new_tuple(subject, GLib.Variant("s", os.environ.get("LANG", "C")), GLib.Variant("s", OBJECT_PATH)),
            None, Gio.DBusCallFlags.NONE, -1, None,
        )
    except GLib.Error as error:
        send({"type": "error", "message": error.message})
        sys.exit(1)
    send({"type": "ready", "session": session_id})
    loop = GLib.MainLoop()
    restarted = []

    # A polkitd that restarts forgets its agents: Din starts this again.
    def on_owner_changed(*_args):
        restarted.append(True)
        loop.quit()

    bus.signal_subscribe(
        "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged", "/org/freedesktop/DBus",
        POLKIT, Gio.DBusSignalFlags.NONE, on_owner_changed,
    )
    read_commands(agent, loop)
    loop.run()
    if restarted:
        sys.exit(1)


if __name__ == "__main__":
    main()
