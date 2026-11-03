//! Windows: Din's, which covers the whole layout, and its popups.
//!
//! The first window to show is Din, the whole desktop, and the only one ever
//! shown. Any other (Chromium's detached DevTools, a native dialog) would
//! cover it fullscreen and take the input with no way back, so it's asked to
//! close instead. Once Din's window is gone, the next one can take its place.

use smithay::{
    delegate_compositor, delegate_xdg_decoration, delegate_xdg_shell,
    desktop::{
        PopupKeyboardGrab, PopupKind, PopupPointerGrab, PopupUngrabStrategy, Window, find_popup_root_surface,
        get_popup_toplevel_coords,
    },
    input::{Seat, pointer::Focus},
    reexports::{
        wayland_protocols::xdg::{
            decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as DecorationMode,
            shell::server::xdg_toplevel,
        },
        wayland_server::{
            Client,
            protocol::{wl_output, wl_seat, wl_surface::WlSurface},
        },
    },
    utils::{Rectangle, SERIAL_COUNTER, Serial},
    wayland::{
        compositor::{CompositorClientState, CompositorHandler, CompositorState, get_parent, is_sync_subsurface},
        shell::xdg::{
            PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState,
            decoration::XdgDecorationHandler,
        },
    },
    backend::renderer::utils::{import_surface_tree, on_commit_buffer_handler, with_renderer_surface_state},
};
use tracing::info;

use super::state::{ClientState, State};

/// What a toplevel has been told so far.
#[derive(Default)]
pub struct Pending {
    pub windows: Vec<Window>,
    /// Din asked to be fullscreen (it does, once it's shown).
    pub fullscreen: bool,
}

impl State {
    /// Din's window, once it's shown.
    pub fn din(&self) -> Option<&Window> {
        self.space.elements().next()
    }

    /// The layout changed: Din's window moves and resizes to cover it, the
    /// pointer stays on a display, and output management hears.
    pub fn layout_changed(&mut self) {
        let layout = self.layout_box();
        if let Some(window) = self.din().cloned() {
            self.space.map_element(window.clone(), layout.loc, false);
            if let Some(toplevel) = window.toplevel() {
                self.configure_din(toplevel);
                toplevel.send_pending_configure();
            }
        }
        if let Some(pointer) = self.seat.get_pointer() {
            let location = pointer.current_location();
            let clamped = self.clamp_to_layout(location);
            if clamped != location {
                pointer.set_location(clamped);
            }
        }
        self.output_management_changed();
        self.queue_redraw_all();
    }

    fn configure_din(&self, toplevel: &ToplevelSurface) {
        let layout = self.layout_box();
        let fullscreen = self.pending.fullscreen;
        toplevel.with_pending_state(|state| {
            state.size = Some(layout.size);
            state.bounds = Some(layout.size);
            state.states.set(xdg_toplevel::State::Activated);
            state.states.set(xdg_toplevel::State::Maximized);
            state.states.set(xdg_toplevel::State::TiledLeft);
            state.states.set(xdg_toplevel::State::TiledRight);
            state.states.set(xdg_toplevel::State::TiledTop);
            state.states.set(xdg_toplevel::State::TiledBottom);
            if fullscreen {
                state.states.set(xdg_toplevel::State::Fullscreen);
            } else {
                state.states.unset(xdg_toplevel::State::Fullscreen);
            }
        });
    }

    /// Shows a toplevel that has its first buffer: as Din if there's no Din
    /// yet, else it's asked to close.
    fn map_toplevel(&mut self, window: Window) {
        let Some(toplevel) = window.toplevel().cloned() else { return };
        if self.din().is_some() {
            let title = smithay::wayland::compositor::with_states(toplevel.wl_surface(), |states| {
                states
                    .data_map
                    .get::<smithay::wayland::shell::xdg::XdgToplevelSurfaceData>()
                    .and_then(|data| data.lock().unwrap().title.clone())
            });
            info!("refusing a second window ({:?})", title.unwrap_or_default());
            toplevel.send_close();
            return;
        }
        info!("Din's window is up");
        self.space.map_element(window, self.layout_box().loc, true);
        let serial = SERIAL_COUNTER.next_serial();
        if let Some(keyboard) = self.seat.get_keyboard() {
            keyboard.set_focus(self, Some(toplevel.wl_surface().clone()), serial);
        }
        // The pointer starts in the middle of the first display.
        if let Some(pointer) = self.seat.get_pointer() {
            if let Some(geometry) = self.space.outputs().next().and_then(|o| self.space.output_geometry(o)) {
                let center = geometry.loc.to_f64() + geometry.size.to_f64().downscale(2.0);
                pointer.set_location(center);
            }
        }
        self.queue_redraw_all();
    }

    fn unconstrain_popup(&self, popup: &PopupSurface) {
        let Ok(root) = find_popup_root_surface(&PopupKind::Xdg(popup.clone())) else { return };
        let Some(window) = self.din().filter(|w| w.toplevel().is_some_and(|t| t.wl_surface() == &root)) else {
            return;
        };
        let Some(window_loc) = self.space.element_location(window) else { return };
        // Where the popup is anchored, on the layout; it's kept on that display.
        let parent = get_popup_toplevel_coords(&PopupKind::Xdg(popup.clone()));
        let anchor = popup.with_pending_state(|state| state.positioner.anchor_rect);
        let point = (window_loc + parent + anchor.loc).to_f64() + anchor.size.to_f64().downscale(2.0);
        let target = self
            .space
            .output_under(point)
            .next()
            .or_else(|| self.space.outputs().next())
            .and_then(|o| self.space.output_geometry(o))
            .unwrap_or_else(|| self.layout_box());
        let target = Rectangle::new(target.loc - window_loc - parent, target.size);
        popup.with_pending_state(|state| {
            state.geometry = state.positioner.get_unconstrained_geometry(target);
        });
    }

    /// Upload the pointer's image (the cursor, a drag's icon) as soon as
    /// it's committed: a cursor resized twice between frames had smithay
    /// write damage past its texture (GL_INVALID_VALUE), leaving the old one.
    pub fn import_pointer_image(&mut self, surface: &WlSurface) {
        let _ = import_surface_tree(&mut self.backend.renderer, surface);
    }

    /// Which displays SURFACE (of Din's) is on, to redraw them.
    fn redraw_for_surface(&mut self, surface: &WlSurface) {
        let mut root = surface.clone();
        while let Some(parent) = get_parent(&root) {
            root = parent;
        }
        let cursor = matches!(&self.cursor_status, smithay::input::pointer::CursorImageStatus::Surface(s) if *s == root);
        let icon = self.dnd_icon.as_ref().is_some_and(|i| i.surface == root);
        if cursor || icon {
            self.import_pointer_image(&root);
            self.queue_redraw_pointer();
        } else {
            // Din covers every display; each only renders what changed on it.
            self.queue_redraw_all();
        }
    }
}

impl CompositorHandler for State {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor_state
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        &client.get_data::<ClientState>().expect("client state").compositor_state
    }

    fn commit(&mut self, surface: &WlSurface) {
        on_commit_buffer_handler::<Self>(surface);
        if !is_sync_subsurface(surface) {
            let mut root = surface.clone();
            while let Some(parent) = get_parent(&root) {
                root = parent;
            }
            if let Some(window) = self.space.elements().find(|w| w.toplevel().is_some_and(|t| t.wl_surface() == &root)) {
                window.on_commit();
            } else if let Some(index) = self
                .pending
                .windows
                .iter()
                .position(|w| w.toplevel().is_some_and(|t| t.wl_surface() == &root))
            {
                let window = self.pending.windows[index].clone();
                let toplevel = window.toplevel().unwrap().clone();
                if !toplevel.is_initial_configure_sent() {
                    self.configure_din(&toplevel);
                    toplevel.send_configure();
                } else if with_renderer_surface_state(&root, |s| s.buffer().is_some()).unwrap_or(false) {
                    self.pending.windows.remove(index);
                    window.on_commit();
                    self.map_toplevel(window);
                }
            }
        }
        self.popups.commit(surface);
        if let Some(PopupKind::Xdg(popup)) = self.popups.find_popup(surface) {
            if !popup.is_initial_configure_sent() {
                let _ = popup.send_configure();
            }
        }
        self.redraw_for_surface(surface);
    }
}

impl XdgShellHandler for State {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        self.pending.windows.push(Window::new_wayland_window(surface));
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        self.pending.windows.retain(|w| w.toplevel() != Some(&surface));
        let window = self.space.elements().find(|w| w.toplevel() == Some(&surface)).cloned();
        if let Some(window) = window {
            info!("Din's window is gone");
            self.space.unmap_elem(&window);
            self.pending.fullscreen = false;
            self.queue_redraw_all();
        }
    }

    fn new_popup(&mut self, surface: PopupSurface, _positioner: PositionerState) {
        self.unconstrain_popup(&surface);
        let _ = self.popups.track_popup(PopupKind::Xdg(surface));
    }

    fn reposition_request(&mut self, surface: PopupSurface, positioner: PositionerState, token: u32) {
        surface.with_pending_state(|state| state.positioner = positioner);
        self.unconstrain_popup(&surface);
        surface.send_repositioned(token);
        let _ = surface.send_configure();
    }

    fn popup_destroyed(&mut self, _surface: PopupSurface) {
        self.queue_redraw_all();
    }

    fn grab(&mut self, surface: PopupSurface, seat: wl_seat::WlSeat, serial: Serial) {
        let Some(seat) = Seat::<State>::from_resource(&seat) else { return };
        let kind = PopupKind::Xdg(surface);
        let Ok(root) = find_popup_root_surface(&kind) else { return };
        let Ok(mut grab) = self.popups.grab_popup::<State>(root, kind, &seat, serial) else { return };
        if let Some(keyboard) = seat.get_keyboard() {
            if keyboard.is_grabbed()
                && !(keyboard.has_grab(serial) || keyboard.has_grab(grab.previous_serial().unwrap_or(serial)))
            {
                grab.ungrab(PopupUngrabStrategy::All);
                return;
            }
            keyboard.set_focus(self, grab.current_grab(), serial);
            keyboard.set_grab(self, PopupKeyboardGrab::new(&grab), serial);
        }
        if let Some(pointer) = seat.get_pointer() {
            if pointer.is_grabbed()
                && !(pointer.has_grab(serial) || pointer.has_grab(grab.previous_serial().unwrap_or_else(|| grab.serial())))
            {
                grab.ungrab(PopupUngrabStrategy::All);
                return;
            }
            pointer.set_grab(self, PopupPointerGrab::new(&grab), serial, Focus::Keep);
        }
    }

    fn fullscreen_request(&mut self, surface: ToplevelSurface, _output: Option<wl_output::WlOutput>) {
        self.pending.fullscreen = true;
        self.configure_din(&surface);
        if surface.is_initial_configure_sent() {
            surface.send_pending_configure();
        }
    }

    fn unfullscreen_request(&mut self, surface: ToplevelSurface) {
        self.pending.fullscreen = false;
        self.configure_din(&surface);
        if surface.is_initial_configure_sent() {
            surface.send_pending_configure();
        }
    }

    fn maximize_request(&mut self, surface: ToplevelSurface) {
        if surface.is_initial_configure_sent() {
            surface.send_configure();
        }
    }

    fn unmaximize_request(&mut self, surface: ToplevelSurface) {
        if surface.is_initial_configure_sent() {
            surface.send_configure();
        }
    }
}

impl XdgDecorationHandler for State {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        toplevel.with_pending_state(|state| state.decoration_mode = Some(DecorationMode::ServerSide));
    }

    fn request_mode(&mut self, toplevel: ToplevelSurface, _mode: DecorationMode) {
        toplevel.with_pending_state(|state| state.decoration_mode = Some(DecorationMode::ServerSide));
        if toplevel.is_initial_configure_sent() {
            toplevel.send_pending_configure();
        }
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        toplevel.with_pending_state(|state| state.decoration_mode = Some(DecorationMode::ServerSide));
        if toplevel.is_initial_configure_sent() {
            toplevel.send_pending_configure();
        }
    }
}

delegate_compositor!(State);
delegate_xdg_shell!(State);
delegate_xdg_decoration!(State);
