//! A game's frames straight to the screen.
//!
//! A native app is shown like any Din window: its frames go from Din's
//! embedded compositor into a canvas, Chromium draws the desktop around it,
//! and this compositor puts that on the screen. Per frame that's three
//! processes, two composites of the whole screen, and pacing by Din's own
//! frames, which a busy desktop delays. While a window is in full screen,
//! Din's embedded compositor hands its frames here instead, and they're drawn
//! over Din's window on their monitor: one composite, paced by the display's
//! refresh. Input still goes through Din, whose window stays underneath, with
//! the window in full screen in it; the pointer is drawn over the frames.
//!
//! The socket is `din-direct` in XDG_RUNTIME_DIR, told to Din as
//! DIN_DIRECT_SOCKET. Only the compositor binary this is, run by Din (not
//! anything Din launched under another name), may connect: whatever does can
//! cover the screen. Messages are as on the embedded compositor's buffer
//! socket (gpu.rs): a u32 length (little-endian) and JSON, with a buffer's
//! descriptors on its first byte.
//!
//!   buffer {buffer, width, height, fourcc, modifier, planes: [{offset, stride}]}
//!   drop {buffer}
//!   show {buffer, x, y, width, height}   where, in Din's window's logical pixels
//!   hide
//!
//! and back, one line of JSON each:
//!
//!   latched {buffer}     in the frame for the next refresh: the app may draw its next
//!   presented {buffer}   on screen since the last refresh: those before it are free
//!   rejected {buffer}    can't be shown here: Din shows the window itself
//!   motion {dx, dy}      mouse-look, straight from the mouse (direct_takes_pointer)
//!   button {button, down}            a Linux input code
//!   axis {h, h120, v, v120}          a wheel's turn
//!
//! The app draws its next frame while this one waits for the refresh, as
//! with any compositor; told only once it's on screen, its frame times swing
//! between one refresh and two.

use std::{
    collections::{HashMap, VecDeque},
    io::{self, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::net::{UnixListener, UnixStream},
    },
    path::PathBuf,
};

use serde_json::{Value, json};
use smithay::{
    backend::{
        allocator::{
            Fourcc, Modifier,
            dmabuf::{Dmabuf, DmabufFlags},
        },
        renderer::{
            ImportDma,
            element::texture::TextureBuffer,
            gles::GlesTexture,
        },
    },
    output::Output,
    reexports::calloop::{Interest, Mode, PostAction, RegistrationToken, generic::Generic},
    utils::{Logical, Point, Rectangle, Transform},
};
use tracing::{info, warn};

use super::state::State;

/// A message longer than this is a broken client.
const MAX_MESSAGE: usize = 64 << 10;
/// Descriptors a buffer may have (DRM's limit on planes).
const MAX_PLANES: usize = 4;

pub struct Direct {
    /// None where the socket couldn't be made: games are shown by Din.
    listener: Option<UnixListener>,
    pub path: PathBuf,
    client: Option<Client>,
    buffers: HashMap<u32, TextureBuffer<GlesTexture>>,
    /// The buffer being shown, and where on the layout.
    shown: Option<(u32, Rectangle<i32, Logical>)>,
    /// The buffer in a frame that's waiting for its refresh.
    awaiting: Option<u32>,
    /// The buffer last shown, once the client's been told it's in a frame:
    /// each show is told once, however many frames it's drawn in.
    latched: Option<u32>,
}

struct Client {
    stream: UnixStream,
    token: RegistrationToken,
    input: Vec<u8>,
    fds: VecDeque<OwnedFd>,
}

impl Direct {
    /// On unless DIN_DIRECT=0, which leaves full-screen windows to Din (to
    /// tell whether something wrong with a game is this path's doing).
    pub fn bind() -> Self {
        let dir = PathBuf::from(std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into()));
        let path = dir.join("din-direct");
        let _ = std::fs::remove_file(&path);
        let listener = if std::env::var("DIN_DIRECT").as_deref() == Ok("0") {
            None
        } else {
            let listener = UnixListener::bind(&path).and_then(|listener| {
                listener.set_nonblocking(true)?;
                Ok(listener)
            });
            listener.map_err(|err| warn!("direct: {}: {err}", path.display())).ok()
        };
        Self {
            listener,
            path,
            client: None,
            buffers: HashMap::new(),
            shown: None,
            awaiting: None,
            latched: None,
        }
    }

    pub fn listener(&self) -> io::Result<UnixListener> {
        match &self.listener {
            Some(listener) => listener.try_clone(),
            None => Err(io::ErrorKind::NotConnected.into()),
        }
    }

    /// What to draw over Din's window: a buffer and where, on the layout.
    pub fn element(&self) -> Option<(&TextureBuffer<GlesTexture>, Rectangle<i32, Logical>)> {
        let (id, rect) = self.shown?;
        Some((self.buffers.get(&id)?, rect))
    }

    fn send(&mut self, message: &Value) {
        let Some(client) = self.client.as_mut() else { return };
        let mut line = message.to_string();
        line.push('\n');
        // A few dozen bytes into an empty socket; one that's full has a
        // client that stopped reading, which loses nothing but its pacing.
        let _ = client.stream.write_all(line.as_bytes());
    }
}

impl Drop for Direct {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl State {
    /// A client connected: kept if it's Din's embedded compositor, in place
    /// of whichever was before (one that restarted).
    pub fn direct_accept(&mut self) {
        while let Some(Ok((stream, _))) = self.direct.listener.as_ref().map(UnixListener::accept) {
            let Some(pid) = peer_pid(&stream) else { continue };
            if !self.is_dins_compositor(pid) {
                warn!("direct: refusing process {pid}, which isn't Din's compositor");
                continue;
            }
            if stream.set_nonblocking(true).is_err() {
                continue;
            }
            let Ok(source) = stream.try_clone() else { continue };
            let token = self
                .handle
                .insert_source(Generic::new(source, Interest::READ, Mode::Level), |_, _, state| {
                    state.direct_read();
                    Ok(PostAction::Continue)
                });
            let Ok(token) = token else { continue };
            self.direct_disconnect();
            info!("direct: Din's compositor ({pid}) connected");
            self.direct.client = Some(Client { stream, token, input: Vec::new(), fds: VecDeque::new() });
        }
    }

    /// Whether PID runs this very binary and descends from Din.
    fn is_dins_compositor(&self, pid: i32) -> bool {
        let ours = std::env::current_exe().ok();
        let theirs = std::fs::read_link(format!("/proc/{pid}/exe")).ok();
        if ours.is_none() || ours != theirs {
            return false;
        }
        let mut current = pid;
        for _ in 0..64 {
            if current as u32 == self.din_pid {
                return true;
            }
            match parent_pid(current) {
                Some(parent) if parent > 1 => current = parent,
                _ => return false,
            }
        }
        false
    }

    fn direct_disconnect(&mut self) {
        if let Some(client) = self.direct.client.take() {
            self.handle.remove(client.token);
        }
        self.direct.buffers.clear();
        self.direct.awaiting = None;
        self.direct.latched = None;
        if let Some((_, rect)) = self.direct.shown.take() {
            self.queue_redraw_rect(rect);
        }
    }

    fn direct_read(&mut self) {
        let Some(client) = self.direct.client.as_mut() else { return };
        let mut chunk = vec![0u8; 16 << 10];
        loop {
            match recv_with_fds(&client.stream, &mut chunk) {
                Ok((0, _)) => return self.direct_disconnect(),
                Ok((read, fds)) => {
                    client.input.extend_from_slice(&chunk[..read]);
                    client.fds.extend(fds);
                    if client.fds.len() > 64 {
                        return self.direct_disconnect();
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return self.direct_disconnect(),
            }
        }
        loop {
            let Some(client) = self.direct.client.as_mut() else { return };
            if client.input.len() < 4 {
                return;
            }
            let length = u32::from_le_bytes(client.input[..4].try_into().unwrap()) as usize;
            if length > MAX_MESSAGE {
                return self.direct_disconnect();
            }
            if client.input.len() < 4 + length {
                return;
            }
            let body: Vec<u8> = client.input.drain(..4 + length).skip(4).collect();
            let Ok(message) = serde_json::from_slice::<Value>(&body) else {
                return self.direct_disconnect();
            };
            self.direct_message(&message);
        }
    }

    fn direct_message(&mut self, message: &Value) {
        let id = message["buffer"].as_u64().and_then(|id| u32::try_from(id).ok()).unwrap_or(0);
        match message["type"].as_str() {
            Some("buffer") => {
                let planes = message["planes"].as_array().map(Vec::len).unwrap_or(0);
                let Some(client) = self.direct.client.as_mut() else { return };
                if planes == 0 || planes > MAX_PLANES || client.fds.len() < planes {
                    return self.direct_disconnect();
                }
                let fds: Vec<OwnedFd> = client.fds.drain(..planes).collect();
                match self.import_direct(message, fds) {
                    Some(buffer) => _ = self.direct.buffers.insert(id, buffer),
                    None => self.direct.send(&json!({ "type": "rejected", "buffer": id })),
                }
            }
            Some("drop") => {
                self.direct.buffers.remove(&id);
                if self.direct.shown.is_some_and(|(shown, _)| shown == id) {
                    self.direct_hide();
                }
            }
            Some("show") => {
                let n = |key: &str| message[key].as_f64().filter(|v| v.is_finite()).map(|v| v.round() as i32);
                let (Some(x), Some(y), Some(w), Some(h)) = (n("x"), n("y"), n("width"), n("height")) else { return };
                if !self.direct.buffers.contains_key(&id) || !(1..=16384).contains(&w) || !(1..=16384).contains(&h) {
                    self.direct.send(&json!({ "type": "rejected", "buffer": id }));
                    return;
                }
                let origin = self.din().and_then(|din| self.space.element_location(din)).unwrap_or_default();
                let rect = Rectangle::new(origin + Point::from((x, y)), (w, h).into());
                // The same buffer shown again (a game re-committing a still
                // frame, or its window placed again) is told it's latched
                // again too: the client waits for that before showing another,
                // and calls a wait of 250ms a stall, which sends the game back
                // through Din's window for good.
                self.direct.latched = None;
                match self.direct.shown.replace((id, rect)) {
                    None => info!("direct: showing a game at {rect:?}"),
                    Some((_, before)) if before != rect => self.queue_redraw_rect(before),
                    Some(_) => {}
                }
                self.queue_redraw_rect(rect);
            }
            Some("hide") => self.direct_hide(),
            _ => {}
        }
    }

    fn direct_hide(&mut self) {
        self.direct.awaiting = None;
        self.direct.latched = None;
        if let Some((_, rect)) = self.direct.shown.take() {
            info!("direct: back to Din's window");
            self.queue_redraw_rect(rect);
        }
    }

    fn import_direct(&mut self, message: &Value, fds: Vec<OwnedFd>) -> Option<TextureBuffer<GlesTexture>> {
        let n = |key: &str| message[key].as_u64();
        let (width, height) = (i32::try_from(n("width")?).ok()?, i32::try_from(n("height")?).ok()?);
        let fourcc = Fourcc::try_from(u32::try_from(n("fourcc")?).ok()?).ok()?;
        let modifier = Modifier::from(message["modifier"].as_str()?.parse::<u64>().ok()?);
        let mut builder = Dmabuf::builder((width, height), fourcc, modifier, DmabufFlags::empty());
        for (index, (plane, fd)) in message["planes"].as_array()?.iter().zip(fds).enumerate() {
            let offset = u32::try_from(plane["offset"].as_u64()?).ok()?;
            let stride = u32::try_from(plane["stride"].as_u64()?).ok()?;
            builder.add_plane(fd, index as u32, offset, stride);
        }
        let dmabuf = builder.build()?;
        let renderer = &mut self.backend.renderer;
        let texture = match renderer.import_dmabuf(&dmabuf, None) {
            Ok(texture) => texture,
            Err(err) => {
                warn!("direct: importing a {width}x{height} {fourcc:?} buffer: {err}");
                return None;
            }
        };
        // A game in full screen: nothing of Din's shows through it.
        let opaque = vec![Rectangle::from_size((width, height).into())];
        Some(TextureBuffer::from_texture(renderer, texture, 1, Transform::Normal, Some(opaque)))
    }

    /// The frame just drawn for a display covering AREA of the layout holds
    /// the shown buffer if it overlaps: it's on screen at the next refresh.
    pub fn direct_rendered(&mut self, area: Rectangle<i32, Logical>) {
        let Some((id, rect)) = self.direct.shown else { return };
        if !rect.overlaps(area) {
            return;
        }
        self.direct.awaiting = Some(id);
        if self.direct.latched != Some(id) {
            self.direct.latched = Some(id);
            self.direct.send(&json!({ "type": "latched", "buffer": id }));
        }
    }

    /// OUTPUT refreshed: the buffer drawn for it is on screen.
    pub fn direct_refreshed(&mut self, output: &Output) {
        let Some((_, rect)) = self.direct.shown else { return };
        if !self.space.output_geometry(output).is_some_and(|area| area.overlaps(rect)) {
            return;
        }
        if let Some(id) = self.direct.awaiting.take() {
            self.direct.send(&json!({ "type": "presented", "buffer": id }));
        }
    }

    /// Whether the pointer goes straight to the game: it's shown, and Din
    /// holds the pointer locked for it (mouse-look), so the mouse's thousand
    /// events a second skip Chromium. The keyboard still goes through Din,
    /// for its shortcuts and Escape.
    pub fn direct_takes_pointer(&self) -> bool {
        self.direct.client.is_some() && self.direct.shown.is_some() && self.pointer_locked()
    }

    /// Mouse-look movement, unaccelerated (as a lock with unadjustedMovement).
    pub fn direct_motion(&mut self, dx: f64, dy: f64) {
        self.direct.send(&json!({ "type": "motion", "dx": dx, "dy": dy }));
    }

    /// A button (a Linux input code) pressed or let go.
    pub fn direct_button(&mut self, button: u32, down: bool) {
        self.direct.send(&json!({ "type": "button", "button": button, "down": down }));
    }

    /// A wheel's turn: per axis, an amount and its 120ths of a notch.
    pub fn direct_axis(&mut self, horizontal: (f64, Option<f64>), vertical: (f64, Option<f64>)) {
        self.direct.send(&json!({
            "type": "axis",
            "h": horizontal.0, "h120": horizontal.1,
            "v": vertical.0, "v120": vertical.1,
        }));
    }

    /// Whether the game shown covers every display, so nothing of Din's
    /// window can be seen.
    pub fn direct_covers_everything(&self) -> bool {
        let Some((_, rect)) = self.direct.shown else { return false };
        let mut outputs = self.space.outputs().filter_map(|o| self.space.output_geometry(o)).peekable();
        outputs.peek().is_some() && outputs.all(|area| rect.contains_rect(area))
    }

    /// Redraws every display RECT is on.
    fn queue_redraw_rect(&mut self, rect: Rectangle<i32, Logical>) {
        let ids: Vec<u64> = self
            .backend
            .heads
            .iter()
            .filter(|h| h.enabled() && self.space.output_geometry(&h.output).is_some_and(|g| g.overlaps(rect)))
            .map(|h| h.id)
            .collect();
        for id in ids {
            self.queue_redraw(id);
        }
    }
}

fn peer_pid(stream: &UnixStream) -> Option<i32> {
    let mut credentials = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut length = size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: SO_PEERCRED fills a ucred of the length given.
    let ok = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&raw mut credentials).cast(),
            &mut length,
        )
    } == 0;
    (ok && credentials.pid > 0).then_some(credentials.pid)
}

/// The parent of PID, from /proc (after the command name, which may hold
/// spaces and parentheses of its own).
fn parent_pid(pid: i32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// Read into BUFFER, with any descriptors that came along.
fn recv_with_fds(stream: &UnixStream, buffer: &mut [u8]) -> io::Result<(usize, Vec<OwnedFd>)> {
    let space = unsafe { libc::CMSG_SPACE((MAX_PLANES * 4 * size_of::<i32>()) as u32) } as usize;
    let mut control = vec![0u8; space];
    // SAFETY: a standard recvmsg into buffers that outlive it; the
    // descriptors it hands over are ours to own.
    unsafe {
        let mut iov = libc::iovec { iov_base: buffer.as_mut_ptr().cast(), iov_len: buffer.len() };
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = control.as_mut_ptr().cast();
        msg.msg_controllen = space as _;
        let read = libc::recvmsg(stream.as_raw_fd(), &mut msg, libc::MSG_CMSG_CLOEXEC);
        if read < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut fds = Vec::new();
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                let data = libc::CMSG_DATA(cmsg).cast::<i32>();
                let count = ((*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize) / size_of::<i32>();
                for index in 0..count {
                    fds.push(OwnedFd::from_raw_fd(data.add(index).read_unaligned()));
                }
            }
            cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
        }
        Ok((read as usize, fds))
    }
}
