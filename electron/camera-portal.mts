// The camera, on a desktop that is Din.
//
// Chromium looks for cameras in /dev/video* by default, and finds only plain
// USB webcams there. A laptop's MIPI camera (Intel IPU6 and IPU7, for example)
// is a raw sensor that libcamera has to process, and PipeWire is where the
// result appears. WebRtcPipeWireCamera has Chromium ask PipeWire instead,
// which lists USB webcams too.
//
// PipeWire is reached through the desktop portal's Camera interface. The portal
// asks permission once, for the program as a whole, and keeps the answer in its
// permission store. Din asks the user site by site (hardenGuestSession) and
// app by app (din-apps.mts), so the portal has nothing to ask. Its own dialog
// also has no parent window here, and Chromium waits on enumerateDevices
// forever when the portal says no, leaving the camera broken with no error.
// So Din answers it: programs outside a sandbox (the portal knows them all as
// the app id "") may use the camera, as they can open /dev/video* already.
// Flatpaks have ids of their own and still get asked.

import { DBusConnection } from './dbus.mts';

export const PIPEWIRE_CAMERA_FEATURE = 'WebRtcPipeWireCamera';

export async function allowCameraThroughPortal(address: string | undefined): Promise<void> {
  const bus = await DBusConnection.connect(address);
  if (!bus) throw new Error('no session bus');
  try {
    await bus.call({
      destination: 'org.freedesktop.impl.portal.PermissionStore',
      path: '/org/freedesktop/impl/portal/PermissionStore',
      interface: 'org.freedesktop.impl.portal.PermissionStore',
      member: 'SetPermission',
      signature: 'sbssas',
      body: ['devices', true, 'camera', '', ['yes']],
    });
  } finally {
    bus.close();
  }
}
