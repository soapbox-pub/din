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
//! RGBA bytes. On the GPU path no pixels travel here: the windows' buffers
//! go to Din's main process (gpu.rs), and this stream carries only the
//! presents, as text ("window W is in buffer B"), so they reach the
//! renderer without waiting on the main process. Either way the renderer
//! acks each batch on the stream, with a text "ack".

use std::{
    io::Read,
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
};

use smithay::reexports::calloop::channel::Sender;
use tungstenite::{
    Message, WebSocket,
    handshake::server::{ErrorResponse, Request, Response},
    http::StatusCode,
    protocol::Role,
};

use crate::canvas::Patch;

enum Outgoing {
    Socket(WebSocket<std::net::TcpStream>),
    Batch(Vec<u8>),
    Text(String),
}

/// What the stream reports to the event loop.
pub enum StreamEvent {
    /// A renderer connected (it knows nothing yet, so everything is resent).
    Connected,
    /// The renderer put a batch on screen.
    Ack,
}

pub struct FrameServer {
    tx: mpsc::Sender<Outgoing>,
    /// ws://127.0.0.1:<port>/<token>
    pub url: String,
    /// Whether a renderer is connected right now.
    live: Arc<AtomicBool>,
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
    /// Start listening; `events` hears of connections and acks.
    pub fn start(events: Sender<StreamEvent>) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let token = random_token();
        let url = format!("ws://127.0.0.1:{port}/{token}");
        let (tx, rx) = mpsc::channel::<Outgoing>();
        let live = Arc::new(AtomicBool::new(false));
        // Which connection is current: a replaced one's late acks are
        // ignored, and its end doesn't mark the stream down.
        let generation = Arc::new(AtomicU64::new(0));

        // Acceptor: one renderer at a time; a new one (a shell reload)
        // replaces the old.
        let accept_tx = tx.clone();
        let accept_live = live.clone();
        let writer_live = live.clone();
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
                let Ok(socket) = tungstenite::accept_hdr(stream, check) else { continue };
                let Ok(read_half) = socket.get_ref().try_clone() else { continue };
                let current = generation.fetch_add(1, Ordering::SeqCst) + 1;
                if accept_tx.send(Outgoing::Socket(socket)).is_err() {
                    return;
                }
                let _ = events.send(StreamEvent::Connected);
                // Reader: the renderer's acks, straight to the event loop
                // (the handshake is done, so the raw stream reads as frames).
                let events = events.clone();
                let generation = generation.clone();
                let live = accept_live.clone();
                thread::spawn(move || {
                    let mut reader = WebSocket::from_raw_socket(read_half, Role::Server, None);
                    let is_current = || generation.load(Ordering::SeqCst) == current;
                    loop {
                        match reader.read() {
                            Ok(Message::Text(text)) if text.as_str() == "ack" => {
                                if is_current() && events.send(StreamEvent::Ack).is_err() {
                                    return;
                                }
                            }
                            Ok(Message::Close(_)) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                    if is_current() {
                        live.store(false, Ordering::SeqCst);
                    }
                });
            }
        });

        // Writer: keeps the event loop from ever blocking on the socket.
        thread::spawn(move || {
            let mut socket: Option<WebSocket<std::net::TcpStream>> = None;
            for message in rx {
                match message {
                    Outgoing::Socket(next) => {
                        socket = Some(next);
                        writer_live.store(true, Ordering::SeqCst);
                    }
                    Outgoing::Batch(bytes) => {
                        if let Some(ws) = socket.as_mut() {
                            if ws.send(Message::Binary(bytes.into())).is_err() {
                                socket = None;
                                writer_live.store(false, Ordering::SeqCst);
                            }
                        }
                    }
                    Outgoing::Text(text) => {
                        if let Some(ws) = socket.as_mut() {
                            if ws.send(Message::Text(text.into())).is_err() {
                                socket = None;
                                writer_live.store(false, Ordering::SeqCst);
                            }
                        }
                    }
                }
            }
        });

        Ok(Self { tx, url, live, pending: Vec::new(), count: 0 })
    }

    /// Whether a renderer is connected to the stream.
    pub fn live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    /// Send a JSON message (a GPU present) as text.
    pub fn send_json(&self, message: &serde_json::Value) {
        let _ = self.tx.send(Outgoing::Text(message.to_string()));
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
