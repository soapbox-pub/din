//! Files dragged from the shell into X apps, by XDND.
//!
//! A drag from the shell is a Wayland one, started by the compositor itself
//! (logic.rs, drag_enter), and Xwayland passes Wayland drags on to nobody:
//! an X app under the pointer (Chromium, Steam, Wine, Electron apps on X)
//! would see nothing. So while files are dragged over an X window, the
//! compositor also plays an X drag source to it, on a connection of its own
//! (as the tray has, tray.rs):
//!
//!   - Its source window owns XdndSelection and offers text/uri-list, the
//!     same bytes a Wayland app reads (clipboard.rs).
//!   - The X window under the pointer, if it says it takes drops
//!     (XdndAware, or through XdndProxy), gets XdndEnter, then XdndPosition
//!     as the pointer moves, one at a time, each after the target's
//!     XdndStatus; leaving it, or a cancel, is XdndLeave.
//!   - A drop is XdndDrop where the target said it would take one, and
//!     XdndLeave where it said not.
//!
//! X coordinates are Din's (xwayland.rs), so a point the shell reports is
//! already the root position XdndPosition carries.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use smithay::reexports::x11rb::{
    connection::Connection,
    protocol::{
        Event,
        xproto::{
            AtomEnum, ClientMessageEvent, ConnectionExt as _, CreateWindowAux, EventMask, PropMode,
            SELECTION_NOTIFY_EVENT, SelectionNotifyEvent, SelectionRequestEvent, Window, WindowClass,
        },
    },
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
    CURRENT_TIME, NONE,
};

use crate::clipboard::{Contents, URI_LIST};

/// The XDND version spoken, at most (targets may speak less, down to 3).
const VERSION: u32 = 5;
/// The oldest version a target may speak and still get a drag.
const MIN_VERSION: u32 = 3;
/// How long a drop waits on a target that hasn't answered the last position.
const STATUS_TIMEOUT: Duration = Duration::from_secs(2);
/// Where the source window waits: well off every screen.
const PARKED: i16 = -10_000;

struct Atoms {
    aware: u32,
    proxy: u32,
    enter: u32,
    position: u32,
    status: u32,
    leave: u32,
    drop: u32,
    finished: u32,
    selection: u32,
    action_copy: u32,
    uri_list: u32,
    targets: u32,
}

/// The X window the drag is over.
struct Target {
    /// The window that takes the drop, named in every message.
    window: Window,
    /// Where messages go: the window, or the proxy it named.
    dest: Window,
    /// A position went out and its status hasn't come back.
    waiting: Option<Instant>,
    /// The latest position, held while waiting on the last one's status.
    pending: Option<(i16, i16)>,
    /// What the target's last status said: it would take a drop here.
    accepts: bool,
    /// Dropped while waiting on a status: settled when it comes.
    drop_pending: bool,
    /// XdndDrop went out: it's reading the files, and is never left.
    dropped: bool,
}

pub struct Xdnd {
    conn: RustConnection,
    source: Window,
    atoms: Atoms,
    /// What's being (or was last) dragged: a target reads it after the drop.
    contents: Option<Arc<Contents>>,
    target: Option<Target>,
}

impl Xdnd {
    /// Connect to Xwayland, with a source window to drag from.
    pub fn start(display: u32) -> Option<Self> {
        let (conn, screen) = RustConnection::connect(Some(&format!(":{display}"))).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        let atom = |name: &str| -> Option<u32> { Some(conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok()?.atom) };
        let atoms = Atoms {
            aware: atom("XdndAware")?,
            proxy: atom("XdndProxy")?,
            enter: atom("XdndEnter")?,
            position: atom("XdndPosition")?,
            status: atom("XdndStatus")?,
            leave: atom("XdndLeave")?,
            drop: atom("XdndDrop")?,
            finished: atom("XdndFinished")?,
            selection: atom("XdndSelection")?,
            action_copy: atom("XdndActionCopy")?,
            uri_list: atom(URI_LIST)?,
            targets: atom("TARGETS")?,
        };
        let source = conn.generate_id().ok()?;
        conn.create_window(
            0,
            source,
            root,
            PARKED,
            PARKED,
            1,
            1,
            0,
            WindowClass::INPUT_ONLY,
            0,
            &CreateWindowAux::new().override_redirect(1),
        )
        .ok()?;
        conn.flush().ok()?;
        Some(Self { conn, source, atoms, contents: None, target: None })
    }

    /// A drag of these files begins: they're what XdndSelection gives.
    pub fn begin(&mut self, contents: Arc<Contents>) {
        self.leave();
        self.contents = Some(contents);
        let _ = self.conn.set_selection_owner(self.source, self.atoms.selection, CURRENT_TIME);
        let _ = self.conn.flush();
    }

    /// The pointer is at a root point, over `window` (an X toplevel) or no X
    /// window at all (None).
    pub fn over(&mut self, window: Option<Window>, x: f64, y: f64) {
        if self.target.as_ref().map(|t| t.window) != window {
            self.leave();
            if let Some(window) = window {
                self.enter(window);
            }
        }
        let point = (x.round().clamp(0.0, f64::from(i16::MAX)) as i16, y.round().clamp(0.0, f64::from(i16::MAX)) as i16);
        let Some(target) = self.target.as_mut() else { return };
        if target.waiting.is_some() {
            target.pending = Some(point);
            return;
        }
        self.position(point);
    }

    /// The drag was dropped where it last was. Whether an X window takes it
    /// is up to its answer, which may still be on its way.
    pub fn drop(&mut self) {
        let Some(target) = self.target.as_mut() else { return };
        if target.waiting.is_some() {
            target.drop_pending = true;
            return;
        }
        self.settle_drop();
    }

    /// The drag ended without a drop.
    pub fn cancel(&mut self) {
        self.leave();
    }

    /// Take what's arrived: targets' answers and requests for the data.
    /// False once the connection is gone (Xwayland exited).
    pub fn poll(&mut self) -> bool {
        loop {
            match self.conn.poll_for_event() {
                Ok(Some(event)) => self.event(event),
                Ok(None) => break,
                Err(_) => return false,
            }
        }
        // A target that stopped answering doesn't hold a drop forever.
        if let Some(target) = &self.target
            && target.drop_pending
            && target.waiting.is_some_and(|since| since.elapsed() > STATUS_TIMEOUT)
        {
            self.leave();
        }
        self.conn.flush().is_ok()
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::ClientMessage(message) if message.format == 32 => {
                let data = message.data.as_data32();
                let Some(target) = self.target.as_mut() else { return };
                if data[0] != target.window {
                    return;
                }
                if message.type_ == self.atoms.status {
                    if target.dropped {
                        return;
                    }
                    target.waiting = None;
                    target.accepts = data[1] & 1 != 0;
                    let (drop_pending, pending) = (target.drop_pending, target.pending.take());
                    if drop_pending {
                        self.settle_drop();
                    } else if let Some(point) = pending {
                        self.position(point);
                    }
                } else if message.type_ == self.atoms.finished {
                    self.target = None;
                }
            }
            Event::SelectionRequest(request) if request.selection == self.atoms.selection => self.answer(&request),
            _ => {}
        }
    }

    /// Give a target the files, as text/uri-list, or the types they come in.
    fn answer(&self, request: &SelectionRequestEvent) {
        // An obsolete client names no property: the target is its name.
        let property = if request.property == NONE { request.target } else { request.property };
        let stored = if request.target == self.atoms.targets {
            let types = [self.atoms.targets, self.atoms.uri_list];
            self.conn.change_property32(PropMode::REPLACE, request.requestor, property, AtomEnum::ATOM, &types).is_ok()
        } else if request.target == self.atoms.uri_list {
            match self.contents.as_ref().and_then(|c| c.bytes(URI_LIST)) {
                Some(bytes) => self
                    .conn
                    .change_property8(PropMode::REPLACE, request.requestor, property, self.atoms.uri_list, &bytes)
                    .is_ok(),
                None => false,
            }
        } else {
            false
        };
        let notify = SelectionNotifyEvent {
            response_type: SELECTION_NOTIFY_EVENT,
            sequence: 0,
            time: request.time,
            requestor: request.requestor,
            selection: request.selection,
            target: request.target,
            property: if stored { property } else { NONE },
        };
        let _ = self.conn.send_event(false, request.requestor, EventMask::NO_EVENT, notify);
        let _ = self.conn.flush();
    }

    /// Start dragging over `window`, if it takes drops.
    fn enter(&mut self, window: Window) {
        let Some((dest, version)) = self.aware(window) else { return };
        let data = [self.source, version << 24, self.atoms.uri_list, NONE, NONE];
        self.send(dest, window, self.atoms.enter, data);
        self.target =
            Some(Target { window, dest, waiting: None, pending: None, accepts: false, drop_pending: false, dropped: false });
    }

    /// Where a window's drops go and the XDND version it speaks, if it takes
    /// them: on itself (XdndAware), or by way of the proxy it names, which
    /// must name itself as well.
    fn aware(&self, window: Window) -> Option<(Window, u32)> {
        let proxy = self
            .window_property(window, self.atoms.proxy, AtomEnum::WINDOW)
            .filter(|&proxy| self.window_property(proxy, self.atoms.proxy, AtomEnum::WINDOW) == Some(proxy));
        let dest = proxy.unwrap_or(window);
        let version = self.window_property(dest, self.atoms.aware, AtomEnum::ATOM)?;
        (version >= MIN_VERSION).then_some((dest, version.min(VERSION)))
    }

    /// A one-value property of a window: an atom, or a window.
    fn window_property(&self, window: Window, property: u32, kind: AtomEnum) -> Option<u32> {
        let reply = self.conn.get_property(false, window, property, kind, 0, 1).ok()?.reply().ok()?;
        reply.value32()?.next()
    }

    fn position(&mut self, (x, y): (i16, i16)) {
        let Some(target) = self.target.as_mut() else { return };
        target.waiting = Some(Instant::now());
        let (dest, window) = (target.dest, target.window);
        let at = (u32::from(x as u16) << 16) | u32::from(y as u16);
        self.send(dest, window, self.atoms.position, [self.source, 0, at, CURRENT_TIME, self.atoms.action_copy]);
    }

    /// Drop, now that the target has said whether it takes it here.
    fn settle_drop(&mut self) {
        let Some(target) = self.target.as_mut() else { return };
        if !target.accepts {
            self.leave();
            return;
        }
        target.drop_pending = false;
        target.dropped = true;
        let (dest, window) = (target.dest, target.window);
        // It stays the target until it says it's finished (or the next drag).
        self.send(dest, window, self.atoms.drop, [self.source, 0, CURRENT_TIME, 0, 0]);
    }

    /// Leave the target, unless it has the drop already (then it's only
    /// forgotten: what's left is its reading the data).
    fn leave(&mut self) {
        let Some(target) = self.target.take() else { return };
        if !target.dropped {
            self.send(target.dest, target.window, self.atoms.leave, [self.source, 0, 0, 0, 0]);
        }
    }

    fn send(&self, dest: Window, window: Window, kind: u32, data: [u32; 5]) {
        let message = ClientMessageEvent::new(32, window, kind, data);
        let _ = self.conn.send_event(false, dest, EventMask::NO_EVENT, message);
        let _ = self.conn.flush();
    }
}
