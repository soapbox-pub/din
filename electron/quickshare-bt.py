#!/usr/bin/env python3
"""Quick Share's Bluetooth half, for electron/quickshare.mts.

Android phones find a Quick Share receiver by its Bluetooth LE advertisement
and connect to it over Bluetooth Classic (RFCOMM), then move to Wi-Fi. BlueZ
hands each RFCOMM connection over as a file descriptor on D-Bus, which Node
can't receive, so this helper (dbus-python and PyGObject) takes them:

  - It registers Nearby Connections' RFCOMM service with BlueZ, with an SDP
    record naming its channel (phones look the channel up, and BlueZ's
    generated record doesn't satisfy them).
  - While Din says so, it advertises the bytes Din gives it as service data
    0xFEF3 in an extended LE advertisement (Din builds them: they're Quick
    Share's, not Bluetooth's).
  - Each connection is passed through, unchanged, to Din's Unix socket: a
    line with Din's token, then a JSON line saying who's on the other end -
    its address, whether BlueZ has it paired, and whether the link is
    authenticated and encrypted (so it has the pairing's key, which a device
    claiming a paired phone's address doesn't) - then the bytes both ways.

    quickshare-bt.py

  - stdin:  JSON lines from Din. First {"socket", "token"}, then
            {"advertise": "<hex>"} to advertise those bytes, or
            {"advertise": null} to stop.
  - stdout: JSON lines to Din: {"ready": {"address"}} once the service is
            registered (the address goes in the advertisement), then
            {"advertising": true|false}.
  - stderr: what went wrong, in a line Din logs.

Exits when stdin closes, taking its connections with it.
"""

import fcntl
import json
import socket
import struct
import sys
import threading

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BLUEZ = 'org.bluez'
ADAPTER = 'org.bluez.Adapter1'
DEVICE = 'org.bluez.Device1'
PROPERTIES = 'org.freedesktop.DBus.Properties'
# Nearby Connections' RFCOMM service: a name-based UUID of "NearbySharing".
SERVICE_UUID = 'a82efa21-ae5c-3dde-9bbc-f16da7b16c5a'
# Channels to try, in order, until one is free.
CHANNELS = (23, 24, 25, 26, 27)
PROFILE_PATH = '/pub/din/quickshare/profile'
ADVERT_PATH = '/pub/din/quickshare/advertisement'

AF_BLUETOOTH = 31
BTPROTO_HCI = 1
# _IOR('H', 213, int): a connection's state, by address and link type.
HCIGETCONNINFO = 0x800448D5
ACL_LINK = 1
HCI_LM_AUTH = 0x0002
HCI_LM_ENCRYPT = 0x0004

out_lock = threading.Lock()


def send(message):
    with out_lock:
        sys.stdout.write(json.dumps(message) + '\n')
        sys.stdout.flush()


def fail(why):
    sys.stderr.write(f'{why}\n')
    sys.stderr.flush()
    sys.exit(1)


def link_secured(hci, address):
    """Whether the link to address is authenticated and encrypted."""
    try:
        s = socket.socket(AF_BLUETOOTH, socket.SOCK_RAW, BTPROTO_HCI)
        try:
            s.bind((hci,))
            bdaddr = bytes(reversed([int(x, 16) for x in address.split(':')]))
            # struct hci_conn_info_req (8 bytes, padded) then one hci_conn_info.
            request = bytearray(bdaddr + bytes([ACL_LINK, 0]) + bytes(16))
            fcntl.ioctl(s.fileno(), HCIGETCONNINFO, request, True)
            link_mode = struct.unpack_from('<I', request, 8 + 12)[0]
            return bool(link_mode & HCI_LM_AUTH) and bool(link_mode & HCI_LM_ENCRYPT)
        finally:
            s.close()
    except OSError:
        return False


def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    for s in (src, dst):
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def bridge(fd, header, din_socket, token):
    bt = socket.socket(fileno=fd)
    # BlueZ hands the descriptor over non-blocking.
    bt.setblocking(True)
    try:
        din = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        din.connect(din_socket)
        din.sendall(token.encode() + b'\n' + json.dumps(header).encode() + b'\n')
    except OSError as e:
        sys.stderr.write(f'Couldn’t reach Din for {header["address"]}: {e}\n')
        bt.close()
        return
    back = threading.Thread(target=pump, args=(din, bt), daemon=True)
    back.start()
    pump(bt, din)
    back.join(5)
    bt.close()
    din.close()


def main():
    first = sys.stdin.readline()
    if not first:
        return
    config = json.loads(first)
    din_socket, token = config['socket'], config['token']

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    manager = dbus.Interface(bus.get_object(BLUEZ, '/'), 'org.freedesktop.DBus.ObjectManager')
    adapter_path = None
    address = None
    for path, interfaces in manager.GetManagedObjects().items():
        adapter = interfaces.get(ADAPTER)
        if adapter and adapter.get('Powered'):
            adapter_path, address = str(path), str(adapter['Address'])
            break
    if not adapter_path:
        fail('Bluetooth is off.')
    hci = int(adapter_path.rsplit('hci', 1)[-1])

    class Profile(dbus.service.Object):
        @dbus.service.method('org.bluez.Profile1', in_signature='oha{sv}')
        def NewConnection(self, device, fd, _properties):
            fd = fd.take()
            props = dbus.Interface(bus.get_object(BLUEZ, device), PROPERTIES)
            try:
                peer = str(props.Get(DEVICE, 'Address'))
                paired = bool(props.Get(DEVICE, 'Paired'))
            except dbus.DBusException:
                socket.socket(fileno=fd).close()
                return
            header = {'address': peer, 'paired': paired, 'secured': link_secured(hci, peer)}
            threading.Thread(target=bridge, args=(fd, header, din_socket, token), daemon=True).start()

        @dbus.service.method('org.bluez.Profile1', in_signature='o')
        def RequestDisconnection(self, _device):
            pass

        @dbus.service.method('org.bluez.Profile1')
        def Release(self):
            pass

    class Advertisement(dbus.service.Object):
        data = b''

        @dbus.service.method(PROPERTIES, in_signature='s', out_signature='a{sv}')
        def GetAll(self, _interface):
            return {
                'Type': 'peripheral',
                # On a secondary channel, so an extended advertisement: the
                # bytes don't fit a legacy one.
                'SecondaryChannel': '1M',
                'ServiceData': dbus.Dictionary({'FEF3': dbus.Array(self.data, signature='y')}, signature='sv'),
            }

        @dbus.service.method('org.bluez.LEAdvertisement1')
        def Release(self):
            pass

    profile = Profile(bus, PROFILE_PATH)
    profiles = dbus.Interface(bus.get_object(BLUEZ, '/org/bluez'), 'org.bluez.ProfileManager1')
    registered = None
    for channel in CHANNELS:
        record = f"""<?xml version="1.0" encoding="UTF-8" ?>
<record>
  <attribute id="0x0001"><sequence><uuid value="{SERVICE_UUID}" /></sequence></attribute>
  <attribute id="0x0004"><sequence>
    <sequence><uuid value="0x0100" /></sequence>
    <sequence><uuid value="0x0003" /><uint8 value="0x{channel:02x}" /></sequence>
  </sequence></attribute>
  <attribute id="0x0005"><sequence><uuid value="0x1002" /></sequence></attribute>
  <attribute id="0x0100"><text value="NearbySharing" /></attribute>
</record>"""
        try:
            profiles.RegisterProfile(profile, SERVICE_UUID, {
                'Name': 'NearbySharing',
                'Role': 'server',
                'Channel': dbus.UInt16(channel),
                'ServiceRecord': record,
                # Unpaired phones may share too (Din asks the user, with a code);
                # `secured` says which links have a pairing's key.
                'RequireAuthentication': False,
                'RequireAuthorization': False,
                'AutoConnect': False,
            })
            registered = channel
            break
        except dbus.DBusException as e:
            last = e
    if registered is None:
        fail(f'Couldn’t register Quick Share with Bluetooth: {last.get_dbus_message()}')

    advertisement = Advertisement(bus, ADVERT_PATH)
    advertising = dbus.Interface(bus.get_object(BLUEZ, adapter_path), 'org.bluez.LEAdvertisingManager1')
    state = {'on': False}
    loop = GLib.MainLoop()

    # Asynchronously: BlueZ reads the advertisement from this process before
    # it answers, which a blocking call would keep it from doing.
    def stop_advertising():
        if state['on']:
            state['on'] = False
            advertising.UnregisterAdvertisement(advertisement, reply_handler=lambda: None, error_handler=lambda _e: None)

    def advertise(data):
        stop_advertising()
        if data is None:
            send({'advertising': False})
            return
        advertisement.data = bytes.fromhex(data)
        state['on'] = True

        def failed(e):
            state['on'] = False
            sys.stderr.write(f'Couldn’t advertise over Bluetooth: {e.get_dbus_message()}\n')
            send({'advertising': False})

        advertising.RegisterAdvertisement(advertisement, {}, reply_handler=lambda: send({'advertising': True}), error_handler=failed)

    # BlueZ drops the advertisement and the service with this process's connection.
    def quit_loop():
        loop.quit()

    def read_commands():
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except ValueError:
                continue
            if 'advertise' in command:
                GLib.idle_add(advertise, command['advertise'])
        GLib.idle_add(quit_loop)

    def bluez_gone(name, _old, new):
        if name == BLUEZ and not new:
            sys.stderr.write('BlueZ stopped.\n')
            GLib.idle_add(quit_loop)

    bus.add_signal_receiver(bluez_gone, signal_name='NameOwnerChanged', dbus_interface='org.freedesktop.DBus', arg0=BLUEZ)
    threading.Thread(target=read_commands, daemon=True).start()
    send({'ready': {'address': address}})
    loop.run()


if __name__ == '__main__':
    main()
