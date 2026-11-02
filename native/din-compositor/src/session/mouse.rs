//! Settings → Mouse: what scrolling does, how fast the pointer goes, which
//! side is the secondary click, and the Magic Mouse's middle click and
//! two-finger swipe. Din says them in $XDG_RUNTIME_DIR/din-shell-mouse
//! (electron/mouse.mts), which is watched with the pointer's (cursor.rs), and
//! each mouse and touchpad is set up from them as it's plugged in and again
//! when they change.
//!
//! A Magic Mouse's scrolling is din-shell's own (magic_mouse.rs), and so is
//! its swipe, which goes Back or Forward, or to the next workspace. Back and
//! Forward, from a swipe or a mouse's own side buttons, are told to Din too,
//! over $XDG_RUNTIME_DIR/din-shell-events, since its pages are its to go
//! back in; a workspace is only Din's.

use std::{
    io::Write,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
};

use smithay::reexports::input::{Device, DeviceCapability};
use tracing::{info, warn};

use super::{magic_mouse, state::State};

/// The file Din tells the mouse's settings in, in XDG_RUNTIME_DIR.
pub const SETTINGS_FILE: &str = "din-shell-mouse";
/// The socket Din listens on for what only it can act on.
const EVENTS_SOCKET: &str = "din-shell-events";

pub const BTN_LEFT: u32 = 0x110;
pub const BTN_RIGHT: u32 = 0x111;
pub const BTN_MIDDLE: u32 = 0x112;
pub const BTN_SIDE: u32 = 0x113;
pub const BTN_EXTRA: u32 = 0x114;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ScrollDirection {
    /// Natural where a finger slides (a touchpad, a Magic Mouse), a wheel's way with a wheel.
    Auto,
    Natural,
    Traditional,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum SecondaryClick {
    Right,
    Left,
    Off,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Swipe {
    Pages,
    Workspaces,
    Off,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Settings {
    pub scroll_direction: ScrollDirection,
    /// libinput's pointer acceleration speed, -1 to 1.
    pub tracking_speed: f64,
    /// How far a scroll goes, 1 as it comes.
    pub scroll_speed: f64,
    pub secondary_click: SecondaryClick,
    /// A Magic Mouse's middle third clicks the middle button.
    pub middle_click: bool,
    pub swipe: Swipe,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            scroll_direction: ScrollDirection::Auto,
            tracking_speed: 0.0,
            scroll_speed: 1.0,
            secondary_click: SecondaryClick::Right,
            middle_click: false,
            swipe: Swipe::Pages,
        }
    }
}

impl Settings {
    fn parse(text: &str) -> Settings {
        let mut settings = Settings::default();
        for line in text.lines() {
            let Some((key, value)) = line.split_once('=') else { continue };
            match key {
                "scroll-direction" => {
                    settings.scroll_direction = match value {
                        "natural" => ScrollDirection::Natural,
                        "traditional" => ScrollDirection::Traditional,
                        _ => ScrollDirection::Auto,
                    }
                }
                "tracking-speed" => {
                    settings.tracking_speed = value.parse().ok().filter(|s: &f64| s.is_finite()).unwrap_or(0.0).clamp(-1.0, 1.0)
                }
                "scroll-speed" => {
                    settings.scroll_speed = value.parse().ok().filter(|s: &f64| s.is_finite()).unwrap_or(1.0).clamp(0.25, 4.0)
                }
                "secondary-click" => {
                    settings.secondary_click = match value {
                        "left" => SecondaryClick::Left,
                        "off" => SecondaryClick::Off,
                        _ => SecondaryClick::Right,
                    }
                }
                "middle-click" => settings.middle_click = value == "1",
                "swipe" => {
                    settings.swipe = match value {
                        "workspaces" => Swipe::Workspaces,
                        "off" => Swipe::Off,
                        _ => Swipe::Pages,
                    }
                }
                _ => {}
            }
        }
        settings
    }

    /// Whether a finger sliding on DEVICE scrolls the content along with it.
    pub fn natural(&self, finger: bool) -> bool {
        match self.scroll_direction {
            ScrollDirection::Auto => finger,
            ScrollDirection::Natural => true,
            ScrollDirection::Traditional => false,
        }
    }
}

#[derive(Default)]
pub struct Mouse {
    pub settings: Settings,
    devices: Vec<Device>,
    pub magic: Vec<magic_mouse::Reader>,
    events: Option<UnixStream>,
}

/// A touchpad: the device that can tap.
fn is_touchpad(device: &Device) -> bool {
    device.config_tap_finger_count() > 0
}

/// A Magic Mouse, over Bluetooth (Apple's Bluetooth vendor ID) or its cable.
pub fn is_magic_mouse(device: &Device) -> bool {
    matches!(
        (device.id_vendor(), device.id_product()),
        (0x004c | 0x05ac, 0x030d) | (0x004c | 0x05ac, 0x0269) | (0x004c | 0x05ac, 0x0323)
    )
}

impl State {
    /// DEVICE was plugged in: set it up, and read a Magic Mouse's touches.
    pub fn mouse_device_added(&mut self, device: &mut Device) {
        if !device.has_capability(DeviceCapability::Pointer) {
            return;
        }
        self.configure_device(device);
        if is_magic_mouse(device) {
            magic_mouse::open(self, device);
        }
        self.mouse.devices.push(device.clone());
    }

    pub fn mouse_device_removed(&mut self, device: &Device) {
        self.mouse.devices.retain(|d| d != device);
        magic_mouse::close(self, device.sysname());
    }

    fn configure_device(&self, device: &mut Device) {
        let settings = self.mouse.settings;
        let touchpad = is_touchpad(device);
        if touchpad && device.config_tap_set_enabled(true).is_err() {
            warn!("couldn't turn on tap-to-click for {}", device.name());
        }
        let natural = settings.natural(touchpad || is_magic_mouse(device));
        if device.config_scroll_has_natural_scroll() && device.config_scroll_set_natural_scroll_enabled(natural).is_err() {
            warn!("couldn't set the scrolling direction of {}", device.name());
        }
        if touchpad {
            return;
        }
        if device.config_accel_is_available() && device.config_accel_set_speed(settings.tracking_speed).is_err() {
            warn!("couldn't set the tracking speed of {}", device.name());
        }
        if device.config_left_handed_is_available() {
            let _ = device.config_left_handed_set(settings.secondary_click == SecondaryClick::Left);
        }
    }

    /// Takes the mouse's settings from FILE, and sets up every device again.
    pub fn read_mouse_settings(&mut self, file: &Path) {
        let Ok(text) = std::fs::read_to_string(file) else { return };
        let settings = Settings::parse(&text);
        if settings == self.mouse.settings {
            return;
        }
        info!("mouse: {settings:?}");
        self.mouse.settings = settings;
        let mut devices = std::mem::take(&mut self.mouse.devices);
        for device in &mut devices {
            self.configure_device(device);
        }
        self.mouse.devices = devices;
    }

    /// The button DEVICE's BUTTON stands for, with the secondary click
    /// turned off or a Magic Mouse's middle click: those click as the primary
    /// button. Back and Forward go to Din too.
    pub fn mouse_button(&mut self, device: &Device, button: u32, pressed: bool) -> u32 {
        let settings = self.mouse.settings;
        let magic = is_magic_mouse(device);
        if magic {
            magic_mouse::button(self, device.sysname(), pressed);
        }
        let button = match button {
            BTN_RIGHT if settings.secondary_click == SecondaryClick::Off && !is_touchpad(device) => BTN_LEFT,
            BTN_MIDDLE if magic && !settings.middle_click => BTN_LEFT,
            other => other,
        };
        if pressed && (button == BTN_SIDE || button == BTN_EXTRA) {
            self.tell_din(if button == BTN_SIDE { "back" } else { "forward" });
        }
        button
    }

    /// Tells Din MESSAGE, if it's listening.
    pub fn tell_din(&mut self, message: &str) {
        let line = format!("{message}\n");
        for _ in 0..2 {
            if self.mouse.events.is_none() {
                let Some(path) = std::env::var_os("XDG_RUNTIME_DIR").map(|d| PathBuf::from(d).join(EVENTS_SOCKET)) else { return };
                let Ok(stream) = UnixStream::connect(path) else { return };
                let _ = stream.set_nonblocking(true);
                self.mouse.events = Some(stream);
            }
            if self.mouse.events.as_mut().is_some_and(|s| s.write_all(line.as_bytes()).is_ok()) {
                return;
            }
            // Din started again since: connect afresh.
            self.mouse.events = None;
        }
    }
}
