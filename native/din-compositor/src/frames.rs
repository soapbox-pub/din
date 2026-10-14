//! Frame stream: pixels go straight to the shell renderer over a localhost
//! WebSocket, bypassing Node entirely.
//!
//! Routing frames through Din's Node worker and an Electron MessagePort
//! capped a full-window repaint at ~130 MB/s: Node had to reassemble every
//! frame from pipe chunks, then the MessagePort deep-copied it again. A
//! WebSocket lands in the renderer as one ArrayBuffer, at 3-4x that rate.
//!
//! The socket is bound to 127.0.0.1 on a random port, and a connection is
//! only accepted on a path carrying a random per-session token, which Din
//! hands to the renderer over its private control channel. Other local
//! users can reach the port but can't guess the token.
//!
//! Each WebSocket message is one batch: a u32 patch count, then per patch
//! u32 id, i32 x, i32 y, u32 width, u32 height (little-endian) and the
//! RGBA bytes. The renderer acks each batch over the control channel.

use std::{
    io::Read,
    net::TcpListener,
    sync::mpsc,
    thread,
};

use smithay::reexports::calloop::channel::Sender;
use tungstenite::{
    Message, WebSocket,
    handshake::server::{ErrorResponse, Request, Response},
    http::StatusCode,
};

use crate::canvas::Patch;

enum Outgoing {
    Socket(WebSocket<std::net::TcpStream>),
    Batch(Vec<u8>),
}

pub struct FrameServer {
    tx: mpsc::Sender<Outgoing>,
    /// ws://127.0.0.1:<port>/<token>
    pub url: String,
    pending: Vec<u8>,
    count: u32,
}

fn random_token() -> String {
    let mut bytes = [0u8; 24];
    if let Ok(mut urandom) = std::fs::File::open("/dev/urandom") {
        let _ = urandom.read_exact(&mut bytes);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl FrameServer {
    /// Start listening. `connected` fires on the event loop each time a
    /// renderer connects (it knows nothing yet, so everything is resent).
    pub fn start(connected: Sender<()>) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let token = random_token();
        let url = format!("ws://127.0.0.1:{port}/{token}");
        let (tx, rx) = mpsc::channel::<Outgoing>();

        // Acceptor: one renderer at a time; a new one (a shell reload)
        // replaces the old.
        let accept_tx = tx.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = stream.set_nodelay(true);
                let expected = format!("/{token}");
                let check = |request: &Request, response: Response| {
                    if request.uri().path() == expected {
                        Ok(response)
                    } else {
                        let mut refusal = ErrorResponse::new(None);
                        *refusal.status_mut() = StatusCode::FORBIDDEN;
                        Err(refusal)
                    }
                };
                if let Ok(socket) = tungstenite::accept_hdr(stream, check) {
                    if accept_tx.send(Outgoing::Socket(socket)).is_err() {
                        return;
                    }
                    let _ = connected.send(());
                }
            }
        });

        // Writer: keeps the event loop from ever blocking on the socket.
        thread::spawn(move || {
            let mut socket: Option<WebSocket<std::net::TcpStream>> = None;
            for message in rx {
                match message {
                    Outgoing::Socket(next) => socket = Some(next),
                    Outgoing::Batch(bytes) => {
                        if let Some(ws) = socket.as_mut() {
                            if ws.send(Message::Binary(bytes.into())).is_err() {
                                socket = None;
                            }
                        }
                    }
                }
            }
        });

        Ok(Self { tx, url, pending: Vec::new(), count: 0 })
    }

    pub fn patch(&mut self, id: u32, patch: &Patch) {
        if self.pending.is_empty() {
            self.pending.extend_from_slice(&0u32.to_le_bytes());
        }
        self.pending.extend_from_slice(&id.to_le_bytes());
        self.pending.extend_from_slice(&patch.x.to_le_bytes());
        self.pending.extend_from_slice(&patch.y.to_le_bytes());
        self.pending.extend_from_slice(&(patch.width as u32).to_le_bytes());
        self.pending.extend_from_slice(&(patch.height as u32).to_le_bytes());
        self.pending.extend_from_slice(&patch.rgba);
        self.count += 1;
    }

    pub fn pending_bytes(&self) -> usize {
        self.pending.len()
    }

    /// Send the patches gathered since the last call as one message.
    /// Returns whether there were any.
    pub fn send_batch(&mut self) -> bool {
        if self.count == 0 {
            return false;
        }
        let mut batch = std::mem::take(&mut self.pending);
        batch[..4].copy_from_slice(&self.count.to_le_bytes());
        self.count = 0;
        let _ = self.tx.send(Outgoing::Batch(batch));
        true
    }
}
