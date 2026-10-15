//! X11 apps, through Xwayland.
//!
//! The compositor runs a rootless Xwayland and is its window manager
//! (Smithay's X11Wm). Every X window is a wl_surface of the Xwayland client,
//! so X apps take the same path as Wayland ones - including the GPU path,
//! where Xwayland renders with glamor and hands over dmabufs. Managed
//! windows become toplevels (Din windows); override-redirect ones (menus,
//! tooltips) become popups at their root position.
//!
//! X coordinates are Din's: a toplevel is configured at its Din window's
//! position, so the menus an app places from it land in the right spot, and
//! Xwayland, which hit-tests the pointer against its own window tree, sends
//! input to the right window.

use std::{io::Read, os::fd::OwnedFd, process::Stdio, sync::Arc};

use smithay::{
    desktop::Window,
    utils::{Logical, Rectangle},
    wayland::selection::SelectionTarget,
    xwayland::{
        X11Surface, X11Wm, XWayland, XWaylandEvent, XwmHandler,
        xwm::{Reorder, ResizeEdge, WmWindowType, X11Window, XwmId},
    },
};

use crate::{
    state::{MAX_CLIPBOARD_BYTES, Popup, PopupShell, State, Toplevel},
};

/// The EWMH window type suffix the shell speaks (as on its X server).
pub fn window_type_name(kind: WmWindowType) -> &'static str {
    match kind {
        WmWindowType::DropdownMenu => "DROPDOWN_MENU",
        WmWindowType::Dialog => "DIALOG",
        WmWindowType::Menu => "MENU",
        WmWindowType::Notification => "NOTIFICATION",
        WmWindowType::Normal => "NORMAL",
        WmWindowType::PopupMenu => "POPUP_MENU",
        WmWindowType::Splash => "SPLASH",
        WmWindowType::Toolbar => "TOOLBAR",
        WmWindowType::Tooltip => "TOOLTIP",
        WmWindowType::Utility => "UTILITY",
    }
}

/// The clipboard types offered to X apps: UTF8_STRING and TEXT (which the
/// window manager maps to these), and plain STRING for older clients.
const X11_TEXT_TYPES: [&str; 3] = ["text/plain;charset=utf-8", "text/plain", "STRING"];

fn is_menu(kind: WmWindowType) -> bool {
    matches!(kind, WmWindowType::DropdownMenu | WmWindowType::Menu | WmWindowType::PopupMenu)
}

/// Start Xwayland; returns its display number, or None if it can't run
/// (not installed). The window manager attaches once it's up.
pub fn start(state: &mut State) -> Option<u32> {
    let spawned = XWayland::spawn(
        &state.dh,
        None,
        std::iter::empty::<(String, String)>(),
        true,
        Stdio::null(),
        Stdio::null(),
        |_| (),
    );
    let (xwayland, client) = match spawned {
        Ok(spawned) => spawned,
        Err(error) => {
            eprintln!("din-compositor: no Xwayland ({error}); X11 apps stay on Din's X server");
            return None;
        }
    };
    let display = xwayland.display_number();
    let handle = state.handle.clone();
    state
        .handle
        .insert_source(xwayland, move |event, _, state| match event {
            XWaylandEvent::Ready { x11_socket, .. } => {
                match X11Wm::start_wm(handle.clone(), x11_socket, client.clone()) {
                    Ok(xwm) => state.xwm = Some(xwm),
                    Err(error) => eprintln!("din-compositor: X11 window manager failed: {error}"),
                }
            }
            XWaylandEvent::Error => eprintln!("din-compositor: Xwayland failed to start"),
        })
        .ok()?;
    Some(display)
}

impl State {
    fn x11_toplevel(&self, window: &X11Surface) -> Option<usize> {
        self.toplevels.iter().position(|t| t.x11() == Some(window))
    }

    fn x11_popup(&self, window: &X11Surface) -> Option<usize> {
        self.popups.iter().position(|p| matches!(&p.shell, PopupShell::X11(w) if w == window))
    }

    fn x11_request(&mut self, window: &X11Surface, message: serde_json::Value) {
        if let Some(id) = self.x11_toplevel(window).map(|index| self.toplevels[index].id) {
            self.window_request(id, message);
        }
    }

    fn forget_x11(&mut self, window: &X11Surface) {
        if let Some(index) = self.x11_toplevel(window) {
            self.remove_toplevel(index);
        }
        if let Some(index) = self.x11_popup(window) {
            self.remove_popup(index);
        }
    }

    /// Offer Din's clipboard text to X apps.
    pub fn set_x11_clipboard(&mut self, text: Arc<String>) {
        // The text an X app just copied, coming back from Din: the app
        // keeps the selection.
        if self.x11_clipboard.as_ref().is_some_and(|current| *current == text) {
            return;
        }
        self.x11_clipboard = Some(text);
        if let Some(xwm) = self.xwm.as_mut() {
            let mimes = X11_TEXT_TYPES.iter().map(|m| m.to_string()).collect();
            let _ = xwm.new_selection(SelectionTarget::Clipboard, Some(mimes));
            // The ownership request sits in the connection's buffer until
            // something flushes it, and X11Wm has no flush of its own: a
            // round trip does it, before an app's paste can miss it.
            let _ = xwm.get_randr_primary_output();
        }
    }
}

impl XwmHandler for State {
    fn xwm_state(&mut self, _xwm: XwmId) -> &mut X11Wm {
        self.xwm.as_mut().expect("X11 window manager")
    }

    fn new_window(&mut self, _xwm: XwmId, _window: X11Surface) {}

    fn new_override_redirect_window(&mut self, _xwm: XwmId, _window: X11Surface) {}

    fn map_window_request(&mut self, _xwm: XwmId, window: X11Surface) {
        if self.x11_toplevel(&window).is_some() {
            return;
        }
        // Cascade until the shell places it, at the size the app asked for.
        let offset = 40 * (self.toplevels.len() as i32 % 8);
        let pos = (80 + offset, 80 + offset).into();
        let _ = window.set_mapped(true);
        let _ = window.configure(Rectangle::new(pos, window.geometry().size));
        let id = self.allocate_id();
        self.toplevels.push(Toplevel::new(id, Window::new_x11_window(window), pos));
    }

    fn mapped_override_redirect_window(&mut self, _xwm: XwmId, window: X11Surface) {
        if self.x11_popup(&window).is_some() {
            return;
        }
        let id = self.allocate_id();
        let pos = window.geometry().loc;
        let grab = window.window_type().is_some_and(is_menu);
        self.popups.push(Popup::new(id, PopupShell::X11(window), pos, grab));
    }

    fn unmapped_window(&mut self, _xwm: XwmId, window: X11Surface) {
        self.forget_x11(&window);
        if !window.is_override_redirect() {
            let _ = window.set_mapped(false);
        }
    }

    fn destroyed_window(&mut self, _xwm: XwmId, window: X11Surface) {
        self.forget_x11(&window);
    }

    /// Sizes are granted (the shell then fits the Din window to the app);
    /// positions are Din's, except for a window that isn't mapped yet.
    fn configure_request(
        &mut self,
        _xwm: XwmId,
        window: X11Surface,
        x: Option<i32>,
        y: Option<i32>,
        w: Option<u32>,
        h: Option<u32>,
        _reorder: Option<Reorder>,
    ) {
        let mut geometry = window.geometry();
        if let Some(w) = w {
            geometry.size.w = (w as i32).max(1);
        }
        if let Some(h) = h {
            geometry.size.h = (h as i32).max(1);
        }
        if self.x11_toplevel(&window).is_none() {
            geometry.loc.x = x.unwrap_or(geometry.loc.x);
            geometry.loc.y = y.unwrap_or(geometry.loc.y);
        }
        // Configuring an unchanged window still sends the synthetic
        // ConfigureNotify the client waits for.
        let _ = window.configure(geometry);
    }

    /// Override-redirect windows move and resize themselves.
    fn configure_notify(
        &mut self,
        _xwm: XwmId,
        window: X11Surface,
        geometry: Rectangle<i32, Logical>,
        _above: Option<X11Window>,
    ) {
        let Some(index) = self.x11_popup(&window) else { return };
        let p = &mut self.popups[index];
        p.pos = geometry.loc;
        if p.announced {
            let message = serde_json::json!({
                "type": "configure", "id": p.id, "x": geometry.loc.x, "y": geometry.loc.y,
                "width": geometry.size.w, "height": geometry.size.h,
            });
            self.wire.json(message);
        }
    }

    // An app's own title bar asks Din to move, resize, maximize or minimize
    // its window (_NET_WM_MOVERESIZE, _NET_WM_STATE, WM_CHANGE_STATE).

    fn resize_request(&mut self, _xwm: XwmId, window: X11Surface, _button: u32, edge: ResizeEdge) {
        let edge = match edge {
            ResizeEdge::Top => "n",
            ResizeEdge::Bottom => "s",
            ResizeEdge::Left => "w",
            ResizeEdge::Right => "e",
            ResizeEdge::TopLeft => "nw",
            ResizeEdge::TopRight => "ne",
            ResizeEdge::BottomLeft => "sw",
            ResizeEdge::BottomRight => "se",
        };
        self.x11_request(&window, serde_json::json!({ "type": "resize", "edge": edge }));
    }

    fn move_request(&mut self, _xwm: XwmId, window: X11Surface, _button: u32) {
        self.x11_request(&window, serde_json::json!({ "type": "move" }));
    }

    fn maximize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        self.x11_request(&window, serde_json::json!({ "type": "maximize", "maximized": true }));
    }

    fn unmaximize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        self.x11_request(&window, serde_json::json!({ "type": "maximize", "maximized": false }));
    }

    fn minimize_request(&mut self, _xwm: XwmId, window: X11Surface) {
        self.x11_request(&window, serde_json::json!({ "type": "minimize" }));
    }

    fn allow_selection_access(&mut self, _xwm: XwmId, selection: SelectionTarget) -> bool {
        selection == SelectionTarget::Clipboard
    }

    /// An X app pastes Din's clipboard.
    fn send_selection(&mut self, _xwm: XwmId, _selection: SelectionTarget, mime_type: String, fd: OwnedFd) {
        let Some(text) = self.x11_clipboard.clone() else { return };
        std::thread::spawn(move || {
            use std::io::Write;
            // STRING is Latin-1 (ICCCM).
            let bytes = if mime_type == "STRING" {
                text.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect()
            } else {
                text.as_bytes().to_vec()
            };
            let _ = std::fs::File::from(fd).write_all(&bytes);
        });
    }

    /// An X app copied: read the text and hand it to Din.
    fn new_selection(&mut self, _xwm: XwmId, selection: SelectionTarget, mime_types: Vec<String>) {
        if selection != SelectionTarget::Clipboard {
            return;
        }
        let Some(mime) = X11_TEXT_TYPES[..2].iter().find(|m| mime_types.iter().any(|have| have == *m)) else {
            return;
        };
        let Ok((mut reader, writer)) = std::io::pipe() else { return };
        let Some(xwm) = self.xwm.as_mut() else { return };
        let handle = self.handle.clone();
        if xwm.send_selection(SelectionTarget::Clipboard, mime.to_string(), OwnedFd::from(writer), handle).is_err() {
            return;
        }
        let tx = self.clipboard_tx.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if reader.by_ref().take(MAX_CLIPBOARD_BYTES).read_to_end(&mut bytes).is_ok() {
                if let Ok(text) = String::from_utf8(bytes) {
                    let _ = tx.send((text, true));
                }
            }
        });
    }
}
