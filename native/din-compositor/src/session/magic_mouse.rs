//! A Magic Mouse's surface, as on a Mac: one finger scrolls, in pixels and
//! with a finger's scroll's end, so a flick coasts the way a touchpad's does;
//! two fingers swiped sideways go Back or Forward, or to the workspace beside
//! (mouse.rs's Swipe setting).
//!
//! The kernel's driver (hid-magicmouse) turns a finger's slide into wheel
//! steps, and libinput sees only those; it also reports each finger on the
//! surface, which libinput ignores. So din-shell reads the fingers from the
//! mouse's event device itself, as the user (who is in the `input` group),
//! scrolls from them, and drops libinput's wheel steps from that mouse. Where
//! the device can't be read, the wheel steps stay.
//!
//! A finger only starts scrolling once it has slid a little and no other
//! finger has, so a finger resting beside it doesn't stop it and clicking
//! doesn't scroll; while a button is held, nothing scrolls.

use std::{
    fs::File,
    os::{
        fd::{AsFd, AsRawFd},
        unix::fs::OpenOptionsExt,
    },
    time::Duration,
};

use smithay::{
    backend::input::{Axis, AxisSource, ButtonState},
    input::pointer::{AxisFrame, ButtonEvent},
    reexports::{
        calloop::{Interest, Mode, PostAction, RegistrationToken, generic::Generic},
        input::Device,
    },
    utils::SERIAL_COUNTER,
};
use tracing::{info, warn};

use super::{
    mouse::{BTN_EXTRA, BTN_SIDE, Swipe},
    state::State,
};

const EV_SYN: u16 = 0;
const EV_ABS: u16 = 3;
const SYN_REPORT: u16 = 0;
const SYN_DROPPED: u16 = 3;
const ABS_MT_SLOT: u16 = 0x2f;
const ABS_MT_POSITION_X: u16 = 0x35;
const ABS_MT_POSITION_Y: u16 = 0x36;
const ABS_MT_TRACKING_ID: u16 = 0x39;
const SLOTS: usize = 16;
/// struct input_event on 64-bit Linux: a 16-byte timeval, then type, code and value.
const EVENT_SIZE: usize = 24;

/// How far a finger slides, in mm, before it scrolls.
const START_MM: f64 = 1.5;
/// How far two fingers go sideways, in mm, to be a swipe, and how quickly.
const SWIPE_MM: f64 = 10.0;
const SWIPE_WITHIN: Duration = Duration::from_millis(800);
/// Pixels a millimetre of slide scrolls, slowly; quicker slides go further,
/// up to ACCEL times as far at FAST mm/ms.
const PX_PER_MM: f64 = 9.0;
const ACCEL: f64 = 3.5;
const FAST: f64 = 0.6;

#[derive(Clone, Copy, Default)]
struct Touch {
    down: bool,
    x: i32,
    y: i32,
    /// Where it was at the last frame, and where it landed (or was last reset to).
    last: (i32, i32),
    from: (i32, i32),
    landed: Duration,
}

#[derive(Clone, Copy, PartialEq)]
enum Gesture {
    Idle,
    Scrolling(usize),
    /// Swiped, or more fingers than mean anything: nothing until they're all lifted.
    Done,
}

pub struct Reader {
    sysname: String,
    token: RegistrationToken,
    touches: [Touch; SLOTS],
    slot: usize,
    /// Device units per mm.
    res: (f64, f64),
    gesture: Gesture,
    buttons: usize,
    last_frame: Duration,
    pending: Vec<u8>,
}

/// struct input_absinfo: value, minimum, maximum, fuzz, flat, resolution.
#[repr(C)]
#[derive(Default)]
struct AbsInfo([i32; 6]);

fn resolution(file: &File, code: u16) -> Option<f64> {
    let mut info = AbsInfo::default();
    // EVIOCGABS(code) = _IOR('E', 0x40 + code, struct input_absinfo)
    let request = (2u64 << 30) | ((std::mem::size_of::<AbsInfo>() as u64) << 16) | ((b'E' as u64) << 8) | (0x40 + code as u64);
    // SAFETY: the kernel writes one input_absinfo into INFO.
    let ret = unsafe { libc::ioctl(file.as_raw_fd(), request as _, &mut info as *mut AbsInfo) };
    (ret == 0 && info.0[5] > 0).then(|| info.0[5] as f64)
}

/// Starts reading DEVICE's fingers.
pub fn open(state: &mut State, device: &Device) {
    let sysname = device.sysname().to_string();
    if state.mouse.magic.iter().any(|r| r.sysname == sysname) {
        return;
    }
    let path = format!("/dev/input/{sysname}");
    let file = match std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC).open(&path) {
        Ok(file) => file,
        Err(err) => {
            warn!("{}: can't read its touches, so it scrolls as a wheel: {err}", device.name());
            return;
        }
    };
    let res = (resolution(&file, ABS_MT_POSITION_X).unwrap_or(26.0), resolution(&file, ABS_MT_POSITION_Y).unwrap_or(70.0));
    let name = sysname.clone();
    let inserted = state.handle.insert_source(Generic::new(file, Interest::READ, Mode::Level), move |_, file, state| {
        Ok(state.read_magic_mouse(&name, file.as_fd().as_raw_fd()))
    });
    match inserted {
        Ok(token) => {
            info!("{}: reading its touches from {path}", device.name());
            state.mouse.magic.push(Reader {
                sysname,
                token,
                touches: [Touch::default(); SLOTS],
                slot: 0,
                res,
                gesture: Gesture::Idle,
                buttons: 0,
                last_frame: Duration::ZERO,
                pending: Vec::new(),
            });
        }
        Err(err) => warn!("{}: can't read its touches: {err}", device.name()),
    }
}

pub fn close(state: &mut State, sysname: &str) {
    if let Some(i) = state.mouse.magic.iter().position(|r| r.sysname == sysname) {
        let reader = state.mouse.magic.remove(i);
        state.handle.remove(reader.token);
    }
}

/// Whether DEVICE's scrolling comes from its fingers, so its wheel steps are dropped.
pub fn reads_touches(state: &State, device: &Device) -> bool {
    state.mouse.magic.iter().any(|r| r.sysname == device.sysname())
}

/// A button on the mouse SYSNAME went down or up.
pub fn button(state: &mut State, sysname: &str, pressed: bool) {
    let now: Duration = state.clock.now().into();
    let Some(i) = state.mouse.magic.iter().position(|r| r.sysname == sysname) else { return };
    let reader = &mut state.mouse.magic[i];
    reader.buttons = if pressed { reader.buttons + 1 } else { reader.buttons.saturating_sub(1) };
    // A click's press moves the finger a little; that's no scroll.
    for touch in reader.touches.iter_mut().filter(|t| t.down) {
        touch.from = (touch.x, touch.y);
        touch.landed = now;
    }
    if let Gesture::Scrolling(_) = reader.gesture {
        reader.gesture = Gesture::Idle;
        state.end_scroll();
    }
}

impl State {
    fn read_magic_mouse(&mut self, sysname: &str, fd: i32) -> PostAction {
        let mut buf = [0u8; EVENT_SIZE * 64];
        loop {
            // SAFETY: reading into a buffer of the size given.
            let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
            if n < 0 {
                let err = std::io::Error::last_os_error();
                if err.kind() == std::io::ErrorKind::WouldBlock {
                    return PostAction::Continue;
                }
                // Unplugged: libinput says so too, and that closes it.
                return PostAction::Disable;
            }
            if n == 0 {
                return PostAction::Disable;
            }
            let Some(i) = self.mouse.magic.iter().position(|r| r.sysname == sysname) else { return PostAction::Remove };
            let mut data = std::mem::take(&mut self.mouse.magic[i].pending);
            data.extend_from_slice(&buf[..n as usize]);
            let full = data.len() - data.len() % EVENT_SIZE;
            for event in data[..full].chunks_exact(EVENT_SIZE) {
                let kind = u16::from_ne_bytes([event[16], event[17]]);
                let code = u16::from_ne_bytes([event[18], event[19]]);
                let value = i32::from_ne_bytes([event[20], event[21], event[22], event[23]]);
                self.magic_event(i, kind, code, value);
            }
            self.mouse.magic[i].pending = data[full..].to_vec();
        }
    }

    fn magic_event(&mut self, i: usize, kind: u16, code: u16, value: i32) {
        let now: Duration = self.clock.now().into();
        let reader = &mut self.mouse.magic[i];
        match (kind, code) {
            (EV_ABS, ABS_MT_SLOT) => reader.slot = (value.max(0) as usize).min(SLOTS - 1),
            (EV_ABS, ABS_MT_TRACKING_ID) => {
                let touch = &mut reader.touches[reader.slot];
                touch.down = value >= 0;
                touch.landed = now;
                touch.from = (i32::MIN, i32::MIN);
            }
            (EV_ABS, ABS_MT_POSITION_X) => reader.touches[reader.slot].x = value,
            (EV_ABS, ABS_MT_POSITION_Y) => reader.touches[reader.slot].y = value,
            (EV_SYN, SYN_REPORT) => self.magic_frame(i, now),
            (EV_SYN, SYN_DROPPED) => {
                reader.touches = [Touch::default(); SLOTS];
                if let Gesture::Scrolling(_) = reader.gesture {
                    self.end_scroll();
                }
                self.mouse.magic[i].gesture = Gesture::Idle;
            }
            _ => {}
        }
    }

    fn magic_frame(&mut self, i: usize, now: Duration) {
        let swipe_setting = self.mouse.settings.swipe;
        let natural = self.mouse.settings.natural(true);
        let speed = self.mouse.settings.scroll_speed;
        let reader = &mut self.mouse.magic[i];
        let dt = (now - reader.last_frame).as_secs_f64() * 1000.0;
        reader.last_frame = now;
        for touch in reader.touches.iter_mut().filter(|t| t.down) {
            if touch.from.0 == i32::MIN {
                touch.from = (touch.x, touch.y);
                touch.last = touch.from;
            }
        }
        let res = reader.res;
        let mm = |t: &Touch, from: (i32, i32)| ((t.x - from.0) as f64 / res.0, (t.y - from.1) as f64 / res.1);
        let down: Vec<usize> = (0..SLOTS).filter(|&s| reader.touches[s].down).collect();

        let mut scroll = None;
        let mut swiped = None;
        let mut ended = false;
        match reader.gesture {
            Gesture::Done => {
                if down.is_empty() {
                    reader.gesture = Gesture::Idle;
                }
            }
            gesture => {
                // Two fingers or more sliding sideways together, lately landed.
                let sideways: Vec<f64> = down
                    .iter()
                    .map(|&s| &reader.touches[s])
                    .filter(|t| now - t.landed < SWIPE_WITHIN)
                    .map(|t| mm(t, t.from))
                    .filter(|(dx, dy)| dx.abs() > SWIPE_MM && dx.abs() > 2.0 * dy.abs())
                    .map(|(dx, _)| dx)
                    .collect();
                let moving: Vec<usize> = down
                    .iter()
                    .copied()
                    .filter(|&s| {
                        let (dx, dy) = mm(&reader.touches[s], reader.touches[s].from);
                        dx.hypot(dy) > START_MM
                    })
                    .collect();
                if down.len() > 3 {
                    ended = matches!(gesture, Gesture::Scrolling(_));
                    reader.gesture = Gesture::Done;
                } else if sideways.len() >= 2 && (sideways.iter().all(|&dx| dx > 0.0) || sideways.iter().all(|&dx| dx < 0.0)) {
                    ended = matches!(gesture, Gesture::Scrolling(_));
                    reader.gesture = Gesture::Done;
                    // Fingers going right go back, a page or a workspace to the left.
                    swiped = Some(sideways[0] > 0.0);
                } else if let Gesture::Scrolling(slot) = gesture {
                    if !reader.touches[slot].down || reader.buttons > 0 {
                        ended = true;
                        reader.gesture = Gesture::Idle;
                        // What's left resting starts afresh.
                        for touch in reader.touches.iter_mut().filter(|t| t.down) {
                            touch.from = (touch.x, touch.y);
                            touch.landed = now;
                        }
                    } else {
                        scroll = Some(slot);
                    }
                } else if reader.buttons == 0 {
                    // One finger sliding, with any others at rest, and not the
                    // start of a swipe (two going at once).
                    if moving.len() == 1 {
                        reader.gesture = Gesture::Scrolling(moving[0]);
                        scroll = Some(moving[0]);
                    }
                }
            }
        }

        let deltas = scroll.map(|slot| {
            let touch = &reader.touches[slot];
            mm(touch, touch.last)
        });
        for touch in reader.touches.iter_mut() {
            touch.last = (touch.x, touch.y);
        }

        if ended {
            self.end_scroll();
        }
        if let Some((dx, dy)) = deltas {
            let velocity = dx.hypot(dy) / dt.max(1.0);
            let gain = PX_PER_MM * speed * (1.0 + (ACCEL - 1.0) * (velocity / FAST).min(1.0));
            // The driver's y grows toward the back of the mouse: a finger
            // going forward goes up the page the way a wheel rolled forward
            // does, and natural scrolling moves the page with the finger.
            let sign = if natural { -1.0 } else { 1.0 };
            self.finger_scroll(sign * dx * gain, sign * dy * gain);
        }
        if let Some(back) = swiped {
            match swipe_setting {
                Swipe::Pages => self.side_click(back),
                Swipe::Workspaces => self.tell_din(if back { "workspace -1" } else { "workspace 1" }),
                Swipe::Off => {}
            }
        }
    }

    fn finger_scroll(&mut self, x: f64, y: f64) {
        let Some(pointer) = self.seat.get_pointer() else { return };
        let time = Duration::from(self.clock.now()).as_millis() as u32;
        let mut frame = AxisFrame::new(time).source(AxisSource::Finger);
        if x != 0.0 {
            frame = frame.value(Axis::Horizontal, x);
        }
        if y != 0.0 {
            frame = frame.value(Axis::Vertical, y);
        }
        pointer.axis(self, frame);
        pointer.frame(self);
    }

    /// The finger's lifted: a scroll's end, which lets the page coast.
    fn end_scroll(&mut self) {
        let Some(pointer) = self.seat.get_pointer() else { return };
        let time = Duration::from(self.clock.now()).as_millis() as u32;
        let frame = AxisFrame::new(time).source(AxisSource::Finger).stop(Axis::Horizontal).stop(Axis::Vertical);
        pointer.axis(self, frame);
        pointer.frame(self);
    }

    /// A click of the Back (or Forward) button, for whatever's under the pointer.
    fn side_click(&mut self, back: bool) {
        let button = if back { BTN_SIDE } else { BTN_EXTRA };
        self.tell_din(if back { "back" } else { "forward" });
        let Some(pointer) = self.seat.get_pointer() else { return };
        let time = Duration::from(self.clock.now()).as_millis() as u32;
        for state in [ButtonState::Pressed, ButtonState::Released] {
            pointer.button(self, &ButtonEvent { button, state, serial: SERIAL_COUNTER.next_serial(), time });
            pointer.frame(self);
        }
    }
}
