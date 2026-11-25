//! The keys Din acts on that Chromium can't name, told to Din as they're
//! pressed.
//!
//! - The area-screenshot key (KEY_SELECTIVE_SCREENSHOT, the dashed box
//!   beside Print Screen on newer laptops): Screenshot's area mode.
//! - The mic-mute key (KEY_MICMUTE): the default microphone's mute.
//! - The display-switch key (KEY_SWITCHVIDEOMODE, F7 on ThinkPads): an
//!   AirPlay receiver between extending the desktop and mirroring it.
//! - The Copilot key, which keyboards send as Shift+Super+F23 (by
//!   Microsoft's design): the assistant's prompt, held to speak to it. XKB
//!   makes F23 XF86TouchpadOff, or XF86Assistant with Shift and Super. Its
//!   release is told too, since a hold ends there.
//!
//! Chromium gives their keysyms no DOM key, so Din sees each as key
//! "Unidentified" with no code, like any other key it can't name. Din used
//! to read the keyboards' event devices itself for these, which needed the
//! `input` group, and with it every process of the user's could read every
//! key typed, passwords included. The compositor already has every key, from
//! libinput, so it says when one of these is pressed instead.
//!
//! The socket is `din-shell-keys` in XDG_RUNTIME_DIR, told to Din as
//! DIN_SHELL_KEYS. Only Din's own process (the one the compositor started)
//! is kept; each press is a line: `screenshot-area`, `mic-mute`,
//! `display-switch` or `copilot`, and the Copilot key's release is
//! `copilot-released`. The keys still go on to whatever has the keyboard.
//! In the other direction, Din can move the pointer with two little-endian
//! i32 coordinates relative to its window.

use std::{
    io::{ErrorKind, Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
};

use smithay::reexports::calloop::{Interest, Mode, PostAction, generic::Generic};
use tracing::{info, warn};

use super::{direct::peer_pid, state::State};

const KEY_F23: u32 = 0xc1;
const KEY_SWITCHVIDEOMODE: u32 = 0xe3;
const KEY_MICMUTE: u32 = 0xf8;
const KEY_SELECTIVE_SCREENSHOT: u32 = 0x27a;

/// What Din is told for the evdev key CODE going down (PRESSED) or up, if
/// it's one of these.
fn name(code: u32, pressed: bool) -> Option<&'static str> {
    match (code, pressed) {
        (KEY_SELECTIVE_SCREENSHOT, true) => Some("screenshot-area"),
        (KEY_MICMUTE, true) => Some("mic-mute"),
        (KEY_SWITCHVIDEOMODE, true) => Some("display-switch"),
        (KEY_F23, true) => Some("copilot"),
        (KEY_F23, false) => Some("copilot-released"),
        _ => None,
    }
}

pub struct Hotkeys {
    pub listener: Option<UnixListener>,
    pub path: PathBuf,
    client: Option<UnixStream>,
}

impl Hotkeys {
    pub fn bind() -> Self {
        let dir = PathBuf::from(std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into()));
        let path = dir.join("din-shell-keys");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).and_then(|listener| {
            listener.set_nonblocking(true)?;
            Ok(listener)
        });
        let listener = listener.map_err(|err| warn!("hotkeys: {}: {err}", path.display())).ok();
        Self { listener, path, client: None }
    }
}

impl Drop for Hotkeys {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl State {
    /// A process connected: kept if it's Din itself, in place of any before.
    pub fn hotkeys_accept(&mut self) {
        while let Some(Ok((stream, _))) = self.hotkeys.listener.as_ref().map(UnixListener::accept) {
            match peer_pid(&stream) {
                Some(pid) if pid as u32 == self.din_pid => {
                    // Writes never wait on Din: a press it hasn't read yet
                    // behind a full socket is one it's too busy to act on.
                    if stream.set_nonblocking(true).is_err() {
                        continue;
                    }
                    let Ok(reader) = stream.try_clone() else { continue };
                    let mut point = [0; 8];
                    let mut used = 0;
                    let source = Generic::new(reader, Interest::READ, Mode::Level);
                    if let Err(err) = self.handle.insert_source(source, move |_, stream, state| {
                        match (&**stream).read(&mut point[used..]) {
                            Ok(0) => return Ok(PostAction::Remove),
                            Ok(n) => used += n,
                            Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                            Err(_) => return Ok(PostAction::Remove),
                        }
                        if used == point.len() {
                            let x = i32::from_le_bytes([point[0], point[1], point[2], point[3]]);
                            let y = i32::from_le_bytes([point[4], point[5], point[6], point[7]]);
                            state.jump_pointer(x, y);
                            used = 0;
                        }
                        Ok(PostAction::Continue)
                    }) {
                        warn!("hotkeys: listening to Din: {err}");
                    }
                    info!("hotkeys: Din ({pid}) connected");
                    self.hotkeys.client = Some(stream);
                }
                pid => warn!("hotkeys: refusing process {pid:?}, which isn't Din"),
            }
        }
    }

    /// The evdev key CODE went down (PRESSED) or up: tell Din, if it's one of its.
    pub fn hotkey(&mut self, code: u32, pressed: bool) {
        let Some(name) = name(code, pressed) else { return };
        let Some(client) = self.hotkeys.client.as_mut() else { return };
        if let Err(err) = client.write_all(format!("{name}\n").as_bytes()) {
            if err.kind() != std::io::ErrorKind::WouldBlock {
                info!("hotkeys: Din's connection closed: {err}");
                self.hotkeys.client = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_only_its_keys() {
        assert_eq!(name(0x27a, true), Some("screenshot-area"));
        assert_eq!(name(0xf8, true), Some("mic-mute"));
        assert_eq!(name(0xe3, true), Some("display-switch"));
        assert_eq!(name(0xc1, true), Some("copilot"));
        assert_eq!(name(0xc1, false), Some("copilot-released"));
        assert_eq!(name(0x27a, false), None);
        assert_eq!(name(30, true), None);
    }
}
