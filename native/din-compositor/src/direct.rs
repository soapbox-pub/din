//! The window in full screen goes straight to the screen.
//!
//! In Din's session the screen's compositor takes a full-screen window's
//! frames from here and draws them over Din's window itself
//! (session/direct.rs), instead of their going through Din: no canvas, no
//! Chromium composite, and the app paced by the display's refresh rather than
//! by Din's frames. Din says which window is in full screen and where ("direct"
//! messages); its frames go here while it's a lone GPU buffer of that window's
//! size and nothing of the app's is open over it (a menu, a tooltip). Anything
//! else, or the screen's compositor refusing a buffer, and the window goes to
//! Din as usual.

use std::{
    collections::HashMap,
    io::{self, Write},
    os::{fd::AsRawFd, unix::net::UnixStream},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use smithay::{
    backend::allocator::{Buffer, dmabuf::Dmabuf},
    reexports::wayland_server::{Resource, backend::ObjectId, protocol::wl_buffer::WlBuffer},
    utils::{Logical, Rectangle},
};

use crate::gpu::send_with_fds;

/// How long a frame may take to reach the screen before the window goes
/// back to Din: a frozen picture is worse than a slower one.
const STALL: Duration = Duration::from_millis(250);

/// What the screen's compositor said about a buffer.
pub enum Reply {
    /// In the frame for the next refresh: the app may draw its next one.
    Latched,
    /// On screen since the last refresh: the ones shown before it are free.
    Presented(u32),
    /// Can't be shown there: Din shows the window instead.
    Rejected(u32),
    /// Mouse-look, straight from the mouse while Din holds the pointer
    /// locked (session/direct.rs): movement, a button, a wheel's turn.
    Motion(f64, f64),
    Button(u32, bool),
    Axis { h: f64, h120: Option<f64>, v: f64, v120: Option<f64> },
}

pub struct DirectChannel {
    stream: UnixStream,
    input: Vec<u8>,
    /// The buffers the screen's compositor has imported, by their wl_buffer.
    known: HashMap<ObjectId, u32>,
    /// A buffer was shown that isn't in a frame yet.
    pub in_flight: bool,
    /// When the last buffer was shown.
    pub shown_at: Instant,
}

impl DirectChannel {
    /// Connect to the screen's compositor, where Din runs as the session
    /// (DIN_DIRECT_SOCKET).
    pub fn connect() -> Option<Self> {
        let path = std::env::var_os("DIN_DIRECT_SOCKET")?;
        let stream = UnixStream::connect(path).ok()?;
        Some(Self { stream, input: Vec::new(), known: HashMap::new(), in_flight: false, shown_at: Instant::now() })
    }

    pub fn stream(&self) -> io::Result<UnixStream> {
        self.stream.try_clone()
    }

    fn send(&mut self, message: &Value, fds: &[i32]) {
        let body = serde_json::to_vec(message).unwrap_or_default();
        let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(&body);
        let _ = if fds.is_empty() { (&self.stream).write_all(&bytes).is_ok() } else { send_with_fds(&self.stream, &bytes, fds) };
    }

    /// The id the screen's compositor knows BUFFER by, announcing it first
    /// if it's new; NEXT_ID gives a new buffer its id.
    pub fn buffer_id(&mut self, buffer: &WlBuffer, dmabuf: &Dmabuf, next_id: impl FnOnce() -> u32) -> u32 {
        if let Some(&id) = self.known.get(&buffer.id()) {
            return id;
        }
        let id = next_id();
        let size = dmabuf.size();
        let modifier: u64 = dmabuf.format().modifier.into();
        let planes: Vec<Value> = dmabuf
            .offsets()
            .zip(dmabuf.strides())
            .map(|(offset, stride)| json!({ "offset": offset, "stride": stride }))
            .collect();
        let fds: Vec<i32> = dmabuf.handles().map(|fd| fd.as_raw_fd()).collect();
        let message = json!({
            "type": "buffer",
            "buffer": id,
            "width": size.w,
            "height": size.h,
            "fourcc": dmabuf.format().code as u32,
            "modifier": modifier.to_string(),
            "planes": planes,
        });
        self.send(&message, &fds);
        self.known.insert(buffer.id(), id);
        id
    }

    /// Show buffer ID at RECT, in Din's window's logical pixels.
    pub fn show(&mut self, id: u32, rect: Rectangle<i32, Logical>) {
        self.send(
            &json!({
                "type": "show",
                "buffer": id,
                "x": rect.loc.x,
                "y": rect.loc.y,
                "width": rect.size.w,
                "height": rect.size.h,
            }),
            &[],
        );
        self.in_flight = true;
        self.shown_at = Instant::now();
    }

    /// The last buffer shown should have reached the screen long ago.
    pub fn stalled(&self) -> bool {
        self.in_flight && self.shown_at.elapsed() > STALL
    }

    pub fn hide(&mut self) {
        self.send(&json!({ "type": "hide" }), &[]);
        self.in_flight = false;
    }

    /// An app destroyed a buffer: the screen's compositor lets go of it.
    pub fn destroyed(&mut self, buffer: &WlBuffer) {
        if let Some(id) = self.known.remove(&buffer.id()) {
            self.send(&json!({ "type": "drop", "buffer": id }), &[]);
        }
    }

    /// A buffer that was refused is forgotten, so it isn't shown again.
    pub fn forget(&mut self, id: u32) {
        self.known.retain(|_, known| *known != id);
    }

    /// What the screen's compositor has said since last asked. None once
    /// it's gone.
    pub fn replies(&mut self) -> Option<Vec<Reply>> {
        let mut chunk = [0u8; 4096];
        loop {
            // SAFETY: recv into a buffer that outlives the call.
            let read = unsafe {
                libc::recv(self.stream.as_raw_fd(), chunk.as_mut_ptr().cast(), chunk.len(), libc::MSG_DONTWAIT)
            };
            match read {
                0 => return None,
                n if n > 0 => self.input.extend_from_slice(&chunk[..n as usize]),
                _ => match io::Error::last_os_error().kind() {
                    io::ErrorKind::WouldBlock => break,
                    io::ErrorKind::Interrupted => continue,
                    _ => return None,
                },
            }
        }
        let mut replies = Vec::new();
        while let Some(end) = self.input.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.input.drain(..=end).collect();
            let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
            let id = message["buffer"].as_u64().and_then(|id| u32::try_from(id).ok()).unwrap_or(0);
            match message["type"].as_str() {
                Some("latched") => replies.push(Reply::Latched),
                Some("presented") => replies.push(Reply::Presented(id)),
                Some("rejected") => replies.push(Reply::Rejected(id)),
                Some("motion") => {
                    let n = |key: &str| message[key].as_f64().filter(|v| v.is_finite()).unwrap_or(0.0);
                    replies.push(Reply::Motion(n("dx"), n("dy")));
                }
                Some("button") => {
                    let button = message["button"].as_u64().and_then(|b| u32::try_from(b).ok()).unwrap_or(0);
                    replies.push(Reply::Button(button, message["down"] == true));
                }
                Some("axis") => {
                    let n = |key: &str| message[key].as_f64().filter(|v| v.is_finite());
                    replies.push(Reply::Axis { h: n("h").unwrap_or(0.0), h120: n("h120"), v: n("v").unwrap_or(0.0), v120: n("v120") });
                }
                _ => {}
            }
        }
        Some(replies)
    }
}
