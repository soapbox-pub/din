//! The old X11 system tray (XEmbed's _NET_SYSTEM_TRAY), for Xwayland's apps.
//!
//! Windows programs put their notification-area icons there, through Wine,
//! which speaks nothing else, and so do some old Linux apps. Din's tray
//! (electron/tray.mts) shows StatusNotifierItems, so this hosts the X one
//! on Xwayland and hands each icon on as one more item:
//!
//!   - It owns the tray selection on a connection of its own, offering a
//!     32-bit visual, so icons come with their transparency.
//!   - A docked icon goes into a container window of its own, off any
//!     screen and under every other window, so nothing sees it or clicks
//!     it; the compositor never shows it (xwayland.rs leaves it out). The
//!     icon is redirected, so its pixels are in a pixmap of its own, which
//!     is read every half second and sent to Din when it's changed.
//!   - A click on Din's item comes back as the X button press and release
//!     an icon gets from a real tray. The container moves under the point
//!     clicked first, so the program's menu, which it opens where the
//!     pointer is, opens under Din's item.
//!
//! The icon windows are Wine's explorer's, not the program's, so they say
//! nothing of which program they're for; Din names them as Windows' own.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use data_encoding::BASE64;
use smithay::reexports::x11rb::{
    self,
    connection::{Connection, RequestConnection},
    properties::WmClass,
    protocol::{
        Event,
        composite::{self, Redirect},
        xproto::{
            AtomEnum, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ButtonPressEvent, ChangeWindowAttributesAux,
            ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, CreateWindowAux, EventMask, ImageFormat,
            KeyButMask, PropMode, StackMode, VisualClass, Window, WindowClass,
        },
    },
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
    CURRENT_TIME, NONE,
};

/// SYSTEM_TRAY_REQUEST_DOCK, the tray opcode a client docks an icon with.
const REQUEST_DOCK: u32 = 0;
/// XEMBED_EMBEDDED_NOTIFY: "you're in", to the icon.
const EMBEDDED_NOTIFY: u32 = 0;
/// How often icons are looked at for changes.
const POLL: Duration = Duration::from_millis(500);
/// Where containers wait: well off every screen.
const PARKED: i16 = -10_000;
/// Icons are drawn at most this big, and so read at most this big.
const MAX_SIDE: u16 = 128;
/// Icons per session: past this, it's abuse.
const MAX_ICONS: usize = 64;

struct Atoms {
    selection: u32,
    opcode: u32,
    manager: u32,
    xembed: u32,
    orientation: u32,
    visual: u32,
}

struct Icon {
    container: Window,
    /// Its WM_CLASS class: "explorer.exe" for every Windows program's.
    class: String,
    /// What was last sent of it, to send only what's changed.
    sent: Option<(u16, u16, u64)>,
}

pub struct Tray {
    conn: RustConnection,
    root: Window,
    atoms: Atoms,
    /// The 32-bit visual offered to icons, and its colormap.
    argb: Option<(u32, u32)>,
    icons: HashMap<Window, Icon>,
    last_poll: Instant,
}

/// What became of the tray since it was last looked at, for Din.
pub enum TrayEvent {
    Icon { id: Window, width: u16, height: u16, bgra: Vec<u8>, class: String },
    Gone { id: Window },
}

impl Tray {
    /// Connect to Xwayland and take the tray, unless another app has it.
    pub fn start(display: u32) -> Option<Self> {
        let (conn, screen) = RustConnection::connect(Some(&format!(":{display}"))).ok()?;
        conn.extension_information(composite::X11_EXTENSION_NAME).ok()??;
        composite::query_version(&conn, 0, 4).ok()?.reply().ok()?;
        let setup = conn.setup();
        let root = setup.roots.get(screen)?.root;
        let argb_visual = setup.roots[screen]
            .allowed_depths
            .iter()
            .filter(|depth| depth.depth == 32)
            .flat_map(|depth| depth.visuals.iter())
            .find(|visual| visual.class == VisualClass::TRUE_COLOR)
            .map(|visual| visual.visual_id);
        let atom = |name: &str| -> Option<u32> { Some(conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok()?.atom) };
        let atoms = Atoms {
            selection: atom(&format!("_NET_SYSTEM_TRAY_S{screen}"))?,
            opcode: atom("_NET_SYSTEM_TRAY_OPCODE")?,
            manager: atom("MANAGER")?,
            xembed: atom("_XEMBED")?,
            orientation: atom("_NET_SYSTEM_TRAY_ORIENTATION")?,
            visual: atom("_NET_SYSTEM_TRAY_VISUAL")?,
        };
        let owner = conn.get_selection_owner(atoms.selection).ok()?.reply().ok()?.owner;
        if owner != NONE {
            eprintln!("din-compositor: another app has the X tray");
            return None;
        }
        let argb = match argb_visual {
            Some(visual) => {
                let colormap = conn.generate_id().ok()?;
                conn.create_colormap(x11rb::protocol::xproto::ColormapAlloc::NONE, colormap, root, visual).ok()?;
                Some((visual, colormap))
            }
            None => None,
        };

        let window = conn.generate_id().ok()?;
        conn.create_window(
            0,
            window,
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
        conn.change_property32(PropMode::REPLACE, window, atoms.orientation, AtomEnum::CARDINAL, &[0]).ok()?;
        if let Some((visual, _)) = argb {
            conn.change_property32(PropMode::REPLACE, window, atoms.visual, AtomEnum::VISUALID, &[visual]).ok()?;
        }
        conn.set_selection_owner(window, atoms.selection, CURRENT_TIME).ok()?;
        // Tray icons that came up first wait for this to dock.
        let announce = ClientMessageEvent::new(32, root, atoms.manager, [CURRENT_TIME, atoms.selection, window, 0, 0]);
        conn.send_event(false, root, EventMask::STRUCTURE_NOTIFY, announce).ok()?;
        conn.flush().ok()?;
        Some(Self { conn, root, atoms, argb, icons: HashMap::new(), last_poll: Instant::now() })
    }

    /// Whether a window is one of the tray's own, which the compositor leaves alone.
    pub fn owns(&self, window: Window) -> bool {
        self.icons.values().any(|icon| icon.container == window)
    }

    /// Take what's arrived, and look at the icons when it's time to.
    /// Errors (Xwayland gone) end the tray: None.
    pub fn poll(&mut self) -> Option<Vec<TrayEvent>> {
        let mut events = Vec::new();
        loop {
            match self.conn.poll_for_event() {
                Ok(Some(event)) => self.event(event, &mut events),
                Ok(None) => break,
                Err(_) => return None,
            }
        }
        if self.last_poll.elapsed() >= POLL {
            self.last_poll = Instant::now();
            let ids: Vec<Window> = self.icons.keys().copied().collect();
            for id in ids {
                if let Some(event) = self.capture(id) {
                    events.push(event);
                }
            }
        }
        let _ = self.conn.flush();
        Some(events)
    }

    fn event(&mut self, event: Event, events: &mut Vec<TrayEvent>) {
        match event {
            Event::ClientMessage(message) if message.type_ == self.atoms.opcode && message.format == 32 => {
                let data = message.data.as_data32();
                if data[1] == REQUEST_DOCK {
                    self.dock(data[2]);
                }
            }
            Event::DestroyNotify(e) => self.forget(e.window, events),
            // An icon taken out of its container (undocked) is gone too.
            Event::ReparentNotify(e) if self.icons.get(&e.window).is_some_and(|icon| icon.container != e.parent) => {
                self.forget(e.window, events)
            }
            _ => {}
        }
    }

    fn dock(&mut self, icon: Window) {
        if self.icons.contains_key(&icon) || self.icons.len() >= MAX_ICONS {
            return;
        }
        let Some(geometry) = self.conn.get_geometry(icon).ok().and_then(|c| c.reply().ok()) else { return };
        let (width, height) = (geometry.width.clamp(1, MAX_SIDE), geometry.height.clamp(1, MAX_SIDE));
        let Ok(container) = self.conn.generate_id() else { return };
        // The container is the icon's depth, so a 32-bit icon's transparency
        // needs nothing of it.
        let aux = CreateWindowAux::new().override_redirect(1).border_pixel(0).background_pixel(0);
        let created = match (geometry.depth, self.argb) {
            (32, Some((visual, colormap))) => self.conn.create_window(
                32,
                container,
                self.root,
                PARKED,
                PARKED,
                width,
                height,
                0,
                WindowClass::INPUT_OUTPUT,
                visual,
                &aux.colormap(colormap),
            ),
            _ => self.conn.create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                container,
                self.root,
                PARKED,
                PARKED,
                width,
                height,
                0,
                WindowClass::INPUT_OUTPUT,
                x11rb::COPY_FROM_PARENT,
                &aux,
            ),
        };
        if created.is_err() {
            return;
        }
        let _ = self.conn.configure_window(container, &ConfigureWindowAux::new().stack_mode(StackMode::BELOW));
        let _ = self.conn.map_window(container);
        let _ = self
            .conn
            .change_window_attributes(icon, &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY));
        let _ = self.conn.reparent_window(icon, container, 0, 0);
        let _ = self.conn.configure_window(icon, &ConfigureWindowAux::new().width(u32::from(width)).height(u32::from(height)));
        let _ = self.conn.map_window(icon);
        let _ = composite::redirect_window(&self.conn, icon, Redirect::MANUAL);
        let embedded = ClientMessageEvent::new(32, icon, self.atoms.xembed, [CURRENT_TIME, EMBEDDED_NOTIFY, 0, container, 0]);
        let _ = self.conn.send_event(false, icon, EventMask::NO_EVENT, embedded);
        let _ = self.conn.flush();
        let class = WmClass::get(&self.conn, icon)
            .ok()
            .and_then(|cookie| cookie.reply().ok().flatten())
            .map(|class| String::from_utf8_lossy(class.class()).chars().take(128).collect())
            .unwrap_or_default();
        self.icons.insert(icon, Icon { container, class, sent: None });
    }

    fn forget(&mut self, icon: Window, events: &mut Vec<TrayEvent>) {
        let Some(gone) = self.icons.remove(&icon) else { return };
        let _ = self.conn.destroy_window(gone.container);
        events.push(TrayEvent::Gone { id: icon });
    }

    /// The icon's pixels, when they've changed since they were last sent.
    fn capture(&mut self, id: Window) -> Option<TrayEvent> {
        let geometry = self.conn.get_geometry(id).ok()?.reply().ok()?;
        let (width, height) = (geometry.width.clamp(1, MAX_SIDE), geometry.height.clamp(1, MAX_SIDE));
        let pixmap = self.conn.generate_id().ok()?;
        composite::name_window_pixmap(&self.conn, id, pixmap).ok()?;
        let image = self.conn.get_image(ImageFormat::Z_PIXMAP, pixmap, 0, 0, width, height, !0).ok()?.reply();
        let _ = self.conn.free_pixmap(pixmap);
        let image = image.ok()?;
        // 32 bits a pixel, BGRA in memory, which is what Din takes; a 24-bit
        // icon's unused byte is made opaque.
        if image.data.len() < usize::from(width) * usize::from(height) * 4 {
            return None;
        }
        let mut bgra = image.data;
        if geometry.depth != 32 {
            for pixel in bgra.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
        }
        // Wine draws an icon a moment after it docks: not before that.
        if bgra.chunks_exact(4).all(|pixel| pixel[3] == 0) {
            return None;
        }
        let hash = bgra.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x100_0000_01b3));
        let icon = self.icons.get_mut(&id)?;
        if icon.sent == Some((width, height, hash)) {
            return None;
        }
        icon.sent = Some((width, height, hash));
        Some(TrayEvent::Icon { id, width, height, bgra, class: icon.class.clone() })
    }

    /// A click on Din's item for an icon, at a point on the screen (Din's
    /// coordinates, which are X's): the press and release a real tray's
    /// icon would get there.
    pub fn click(&mut self, id: Window, button: u8, x: i16, y: i16) {
        let Some(icon) = self.icons.get(&id) else { return };
        let Some(geometry) = self.conn.get_geometry(id).ok().and_then(|c| c.reply().ok()) else { return };
        let (half_w, half_h) = ((geometry.width / 2) as i16, (geometry.height / 2) as i16);
        // Under the point, under every window: where the program's menu
        // goes, and where nothing can click it.
        let at = ConfigureWindowAux::new().x(i32::from(x - half_w)).y(i32::from(y - half_h)).stack_mode(StackMode::BELOW);
        let _ = self.conn.configure_window(icon.container, &at);
        let held = match button {
            1 => KeyButMask::BUTTON1,
            2 => KeyButMask::BUTTON2,
            _ => KeyButMask::BUTTON3,
        };
        for (kind, state, mask) in [
            (BUTTON_PRESS_EVENT, KeyButMask::default(), EventMask::BUTTON_PRESS),
            (BUTTON_RELEASE_EVENT, held, EventMask::BUTTON_RELEASE),
        ] {
            let event = ButtonPressEvent {
                response_type: kind,
                detail: button,
                sequence: 0,
                time: CURRENT_TIME,
                root: self.root,
                event: id,
                child: NONE,
                root_x: x,
                root_y: y,
                event_x: half_w,
                event_y: half_h,
                state,
                same_screen: true,
            };
            let _ = self.conn.send_event(false, id, mask, event);
        }
        let _ = self.conn.flush();
    }
}

impl TrayEvent {
    /// As the shell's tray takes it (electron/tray.mts).
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Icon { id, width, height, bgra, class } => serde_json::json!({
                "type": "tray-icon", "tray": id, "width": width, "height": height, "bgra": BASE64.encode(bgra), "class": class,
            }),
            Self::Gone { id } => serde_json::json!({ "type": "tray-gone", "tray": id }),
        }
    }
}
