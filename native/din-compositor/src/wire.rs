//! The pipe protocol between this compositor and Din's display worker
//! (electron/wayland-bridge.mts), over stdout and stdin.
//!
//! Every record is a little-endian u32 length, then that many bytes: a kind
//! byte and a payload. Din sends JSON only; this side also sends cursor
//! images in binary. Window pixels don't come this way at all - they stream
//! straight to the renderer (frames.rs).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{self, Write};

pub const KIND_JSON: u8 = 0;
/// Cursor image: u32 width, u32 height, i32 xhot, i32 yhot, RGBA.
pub const KIND_CURSOR: u8 = 3;

pub struct Wire {
    out: io::BufWriter<io::Stdout>,
    /// The cursor image Din has, hashed, while it's an image and not a name.
    cursor: Option<u64>,
}

impl Wire {
    pub fn new() -> Self {
        Self { out: io::BufWriter::with_capacity(1 << 20, io::stdout()), cursor: None }
    }

    fn record(&mut self, kind: u8, header: &[u8], body: &[u8]) {
        let len = (1 + header.len() + body.len()) as u32;
        // A broken pipe means Din is gone; the stdin EOF that comes with it
        // shuts the compositor down, so write errors are ignored here.
        let _ = self.out.write_all(&len.to_le_bytes());
        let _ = self.out.write_all(&[kind]);
        let _ = self.out.write_all(header);
        let _ = self.out.write_all(body);
    }

    pub fn json(&mut self, value: serde_json::Value) {
        let body = serde_json::to_vec(&value).unwrap_or_default();
        self.record(KIND_JSON, &[], &body);
    }

    /// A named cursor (cursor-shape-v1 names are CSS names), or "none".
    pub fn cursor_name(&mut self, name: &str) {
        self.cursor = None;
        self.json(serde_json::json!({ "type": "cursor-name", "name": name }));
    }

    /// A cursor image, sent only when it differs from the one Din has: apps
    /// recommit their cursor surfaces unchanged (Xwayland on every set), and
    /// each image Din gets is a new CSS cursor it has to load.
    pub fn cursor(&mut self, width: i32, height: i32, xhot: i32, yhot: i32, rgba: &[u8]) {
        let mut header = Vec::with_capacity(16);
        header.extend_from_slice(&(width as u32).to_le_bytes());
        header.extend_from_slice(&(height as u32).to_le_bytes());
        header.extend_from_slice(&xhot.to_le_bytes());
        header.extend_from_slice(&yhot.to_le_bytes());
        let mut hasher = DefaultHasher::new();
        header.hash(&mut hasher);
        rgba.hash(&mut hasher);
        let hash = hasher.finish();
        if self.cursor == Some(hash) {
            return;
        }
        self.cursor = Some(hash);
        self.record(KIND_CURSOR, &header, rgba);
    }

    pub fn flush(&mut self) {
        let _ = self.out.flush();
    }
}

/// Incremental decoder for Din's records on stdin.
#[derive(Default)]
pub struct Reader {
    buf: Vec<u8>,
}

impl Reader {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next complete JSON message, if one has fully arrived.
    pub fn next(&mut self) -> Option<serde_json::Value> {
        loop {
            if self.buf.len() < 4 {
                return None;
            }
            let len = u32::from_le_bytes(self.buf[..4].try_into().ok()?) as usize;
            if self.buf.len() < 4 + len {
                return None;
            }
            let record: Vec<u8> = self.buf.drain(..4 + len).skip(4).collect();
            if record.first() == Some(&KIND_JSON) {
                if let Ok(value) = serde_json::from_slice(&record[1..]) {
                    return Some(value);
                }
            }
        }
    }
}
