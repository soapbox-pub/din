//! What the compositor does between protocol events: announcing windows to
//! the shell, rendering what changed, pacing apps by the shell's acks, and
//! applying the shell's input and window-management messages.

use std::time::Duration;

use serde_json::{Value, json};
use smithay::{
    output::{Mode, Output, PhysicalProperties, Scale, Subpixel},
    backend::{
        input::{Axis, AxisSource, ButtonState, KeyState},
        renderer::utils::{import_surface_tree, with_renderer_surface_state},
    },
    desktop::{
        WindowSurfaceType, find_popup_root_surface,
        utils::{bbox_from_surface_tree, send_frames_surface_tree, under_from_surface_tree, with_surfaces_surface_tree},
    },
    input::{
        keyboard::{FilterResult, XkbConfig},
        pointer::{AxisFrame, ButtonEvent, CursorImageSurfaceData, GrabStartData, MotionEvent},
    },
    reexports::{
        calloop::timer::{TimeoutAction, Timer},
        wayland_protocols::xdg::shell::server::xdg_toplevel,
        wayland_server::{
            Resource,
            protocol::{wl_data_device_manager::DndAction, wl_surface::WlSurface},
        },
    },
    utils::{Logical, Point, Rectangle, SERIAL_COUNTER, Size, Transform},
    wayland::{
        compositor::with_states,
        selection::data_device::{SourceMetadata, set_data_device_selection, start_dnd},
        shell::xdg::XdgToplevelSurfaceData,
    },
};

use crate::{
    canvas::{Canvas, Patch},
    clipboard::{Contents, URI_LIST},
    state::{KeyboardFocus, Popup, PopupShell, State, Toplevel},
    xwayland::window_type_name,
};

/// What the shell is told about a toplevel.
struct Description {
    title: String,
    class: Vec<String>,
    pid: Option<i32>,
    /// EWMH window type suffix: NORMAL, DIALOG, ...
    kind: &'static str,
    /// Whether the app has caught up with the shell's last configure.
    acked: bool,
    /// Whether the app draws its own title bar.
    csd: bool,
}

/// Batches in flight before rendering pauses; damage accumulates meanwhile.
/// The CPU path overlaps two, since producing a batch takes a while. On the
/// GPU, rendering takes about a millisecond, and one batch per display frame
/// is the goal: a second would only show the same frame twice, while apps
/// whose surfaces commit separately (Firefox's video subsurface) would be
/// paced at double the refresh rate.
const MAX_IN_FLIGHT_CPU: u32 = 2;
const MAX_IN_FLIGHT_GPU: u32 = 1;

/// Outputs past this many are left off (a hostile or broken message).
const MAX_MONITORS: usize = 16;

/// Linux input button codes, by X button number (1 left, 2 middle, 3 right,
/// 8 back, 9 forward) - the numbering the shell speaks for both servers.
fn linux_button(button: u32) -> Option<u32> {
    match button {
        1 => Some(0x110),
        2 => Some(0x112),
        3 => Some(0x111),
        8 => Some(0x113),
        9 => Some(0x114),
        _ => None,
    }
}

fn has_buffer(surface: &WlSurface) -> bool {
    with_renderer_surface_state(surface, |state| state.buffer().is_some()).unwrap_or(false)
}

/// Render `surface` into `canvas` (replaced when the size changed), returning
/// its changed rectangles.
fn render(
    renderer: &mut smithay::backend::renderer::pixman::PixmanRenderer,
    canvas: &mut Option<Canvas>,
    surface: &WlSurface,
    geometry: Rectangle<i32, Logical>,
) -> Vec<Patch> {
    let size = (geometry.size.w, geometry.size.h).into();
    if canvas.as_ref().is_none_or(|c| c.size() != size) {
        *canvas = Canvas::new(renderer, size);
    }
    let Some(canvas) = canvas.as_mut() else { return Vec::new() };
    let _ = import_surface_tree(renderer, surface);
    canvas.render(renderer, surface, (geometry.loc.x, geometry.loc.y).into())
}

impl State {
    pub fn frame_done(&self, surface: &WlSurface) {
        let output = self.output.clone();
        send_frames_surface_tree(surface, &self.output, self.start.elapsed(), None, |_, _| {
            Some(output.clone())
        });
    }

    fn enter_output(&self, surface: &WlSurface) {
        with_surfaces_surface_tree(surface, |surface, _| self.output.enter(surface));
    }

    fn pid_of(&self, surface: &WlSurface) -> Option<i32> {
        let client = self.dh.get_client(surface.id()).ok()?;
        client.get_credentials(&self.dh).ok().map(|credentials| credentials.pid)
    }

    /// Title, class names, pid, kind, acked-ness and decorations of a
    /// toplevel. X11 windows report their own pid: Xwayland is the client of
    /// all of them.
    fn describe(&self, t: &Toplevel, surface: &WlSurface) -> Description {
        if let Some(x11) = t.x11() {
            let kind = match x11.window_type() {
                Some(kind) => window_type_name(kind),
                None if x11.is_transient_for().is_some() => "DIALOG",
                None => "NORMAL",
            };
            return Description {
                title: x11.title(),
                class: [x11.instance(), x11.class()].into_iter().filter(|c| !c.is_empty()).collect(),
                pid: x11.pid().map(|pid| pid as i32),
                kind,
                acked: true,
                // Motif hints asking for no decorations (Chrome, Steam):
                // the app has its own.
                csd: x11.is_decorated(),
            };
        }
        let (title, app_id) = with_states(surface, |states| {
            let data = states.data_map.get::<XdgToplevelSurfaceData>();
            let data = data.map(|d| d.lock().unwrap());
            (
                data.as_ref().and_then(|d| d.title.clone()).unwrap_or_default(),
                data.as_ref().and_then(|d| d.app_id.clone()).unwrap_or_default(),
            )
        });
        let toplevel = t.window.toplevel().expect("wayland window");
        Description {
            title,
            class: if app_id.is_empty() { vec![] } else { vec![app_id] },
            pid: self.pid_of(surface),
            kind: if toplevel.parent().is_some() { "DIALOG" } else { "NORMAL" },
            // Only once the app has acked the shell's last configure, so a
            // stale commit never fights a live resize.
            acked: toplevel.with_pending_state(|s| s.size) == toplevel.current_state().size,
            csd: t.client_side,
        }
    }

    /// Announce newly mapped windows and report title/size changes.
    fn announce(&mut self) {
        let mut messages = Vec::new();
        for index in 0..self.toplevels.len() {
            let Some(surface) = self.toplevels[index].wl_surface() else { continue };
            if !has_buffer(&surface) {
                continue;
            }
            let Description { title, class, pid, kind, acked, csd } = self.describe(&self.toplevels[index], &surface);
            let geometry = self.toplevels[index].window.geometry();
            let t = &mut self.toplevels[index];
            if !t.announced {
                t.announced = true;
                t.title = title.clone();
                t.csd = csd;
                t.opaque = crate::gpu::fully_opaque(&surface);
                t.known_size = Some(geometry.size);
                t.dirty = true;
                t.canvas = None;
                messages.push(json!({
                    "type": "open",
                    "id": t.id,
                    "x": t.pos.x,
                    "y": t.pos.y,
                    "width": geometry.size.w,
                    "height": geometry.size.h,
                    "title": title,
                    "wmClass": class,
                    "pid": pid,
                    "kind": kind,
                    "transientFor": Value::Null,
                    "csd": csd,
                    "opaque": t.opaque,
                }));
                self.enter_output(&surface);
                continue;
            }
            if title != t.title {
                t.title = title.clone();
                messages.push(json!({ "type": "title", "id": t.id, "title": title }));
            }
            if csd != t.csd {
                t.csd = csd;
                messages.push(json!({ "type": "decoration", "id": t.id, "csd": csd }));
            }
            // The app sized itself (an initial size, a minimum it insists
            // on): the Din window follows.
            if acked && t.known_size != Some(geometry.size) && geometry.size.w > 0 {
                t.known_size = Some(geometry.size);
                messages.push(json!({
                    "type": "configure",
                    "id": t.id,
                    "x": t.pos.x,
                    "y": t.pos.y,
                    "width": geometry.size.w,
                    "height": geometry.size.h,
                }));
            }
        }
        for index in 0..self.popups.len() {
            let Some(surface) = self.popups[index].wl_surface() else { continue };
            if self.popups[index].announced || !has_buffer(&surface) {
                continue;
            }
            let geometry = self.popups[index].geometry();
            let p = &mut self.popups[index];
            p.announced = true;
            p.dirty = true;
            p.canvas = None;
            let kind = match &p.shell {
                PopupShell::X11(x11) => x11.window_type().map(window_type_name).unwrap_or("NORMAL"),
                // Menus grab; the shell shields the desktop for those.
                PopupShell::Xdg { .. } if p.grab => "POPUP_MENU",
                PopupShell::Xdg { .. } => "NORMAL",
            };
            messages.push(json!({
                "type": "popup",
                "id": p.id,
                "x": p.pos.x,
                "y": p.pos.y,
                "width": geometry.size.w,
                "height": geometry.size.h,
                "title": "",
                "wmClass": [],
                "pid": Value::Null,
                "kind": kind,
                "transientFor": Value::Null,
            }));
            self.enter_output(&surface);
        }
        for message in messages {
            self.wire.json(message);
        }
    }

    /// Announce, then render and send whatever changed.
    pub fn flush(&mut self) {
        self.announce();
        self.report_pointer_lock();
        // With no renderer to draw for, damage just accumulates; apps wait
        // on their frame callbacks meanwhile, which is right for an unseen
        // window.
        // The GPU path draws for Din's main process, the CPU path for the
        // renderer's frame stream.
        let connected = match &self.buffers {
            Some(buffers) => buffers.connected(),
            None => self.streaming,
        };
        let max_in_flight = if self.gpu.is_some() { MAX_IN_FLIGHT_GPU } else { MAX_IN_FLIGHT_CPU };
        if !connected || self.in_flight >= max_in_flight {
            self.wire.flush();
            return;
        }
        if self.gpu.is_some() {
            self.flush_gpu();
            return;
        }

        let started = self.stats.as_ref().map(|_| std::time::Instant::now());
        let mut sent = false;
        let mut idle = Vec::new();
        let mut waiting = Vec::new();
        let State { toplevels, popups, renderer, frames, .. } = self;
        for t in toplevels.iter_mut().filter(|t| t.announced && t.dirty) {
            t.dirty = false;
            let Some(surface) = t.wl_surface() else { continue };
            let patches = render(renderer, &mut t.canvas, &surface, t.window.geometry());
            for patch in &patches {
                frames.patch(t.id, patch);
            }
            sent |= !patches.is_empty();
            if patches.is_empty() { idle.push(surface) } else { waiting.push(surface) }
        }
        for p in popups.iter_mut().filter(|p| p.announced && p.dirty) {
            p.dirty = false;
            let Some(surface) = p.wl_surface() else { continue };
            let geometry = p.geometry();
            let patches = render(renderer, &mut p.canvas, &surface, geometry);
            for patch in &patches {
                frames.patch(p.id, patch);
            }
            sent |= !patches.is_empty();
            if patches.is_empty() { idle.push(surface) } else { waiting.push(surface) }
        }
        let bytes = self.frames.pending_bytes();
        if sent && self.frames.send_batch() {
            self.in_flight += 1;
            if let (Some(stats), Some(started)) = (self.stats.as_mut(), started) {
                stats.record(bytes, started.elapsed());
            }
        }
        // Nothing visible changed: the app may draw again right away.
        for surface in &idle {
            self.frame_done(surface);
        }
        self.awaiting_frame.extend(waiting);
        self.wire.flush();
    }

    /// The GPU path: render dirty windows into their shared buffers and tell
    /// Din which buffer each is now in.
    fn flush_gpu(&mut self) {
        let started = self.stats.as_ref().map(|_| std::time::Instant::now());
        let mut presents = Vec::new();
        let mut idle = Vec::new();
        let mut waiting = Vec::new();
        let mut pixels = 0usize;
        let State { toplevels, popups, gpu, buffers, frames, passthrough, .. } = self;
        let (Some(gpu), Some(buffers)) = (gpu.as_mut(), buffers.as_mut()) else { return };
        let windows = toplevels
            .iter_mut()
            .filter(|t| t.announced && t.dirty)
            .map(|t| {
                let geometry = t.window.geometry();
                (t.id, t.wl_surface(), geometry, t.opaque, &mut t.dirty, &mut t.target, &mut t.shown)
            })
            .chain(popups.iter_mut().filter(|p| p.announced && p.dirty).map(|p| {
                let geometry = p.geometry();
                (p.id, p.wl_surface(), geometry, false, &mut p.dirty, &mut p.target, &mut p.shown)
            }));
        for (id, surface, geometry, opaque, dirty, target, shown) in windows {
            *dirty = false;
            let Some(surface) = surface else { continue };
            // The app's own buffer, if it can go as it is.
            if let Some(buffer) = passthrough.show(gpu, buffers, shown, &surface, geometry, opaque) {
                if let Some(ring) = target.take() {
                    ring.release(buffers);
                }
                presents.push(json!({ "id": id, "buffer": buffer }));
                waiting.push(surface);
                continue;
            }
            passthrough.stop(shown);
            match gpu.render(target, &surface, geometry, buffers) {
                Some(buffer) => {
                    pixels += (geometry.size.w * geometry.size.h) as usize;
                    presents.push(json!({ "id": id, "buffer": buffer }));
                    waiting.push(surface);
                }
                None => idle.push(surface),
            }
        }
        if !presents.is_empty() {
            // On the stream the present reaches the renderer directly; the
            // buffer socket would relay it through Din's main process.
            let present = json!({ "type": "present", "windows": presents });
            if frames.live() {
                frames.send_json(&present);
            } else {
                buffers.send(&present, &[]);
            }
            self.in_flight += 1;
            if let (Some(stats), Some(started)) = (self.stats.as_mut(), started) {
                stats.record(pixels * 4, started.elapsed());
            }
        }
        for surface in &idle {
            self.frame_done(surface);
        }
        self.awaiting_frame.extend(waiting);
        self.wire.flush();
    }

    /// Drop every window's GPU buffers; they're reallocated (and announced
    /// to Din afresh) on the next render.
    fn release_all_targets(&mut self) {
        // Din's imports of the apps' own buffers go too.
        self.passthrough.forget();
        let mut targets: Vec<_> = self.toplevels.iter_mut().map(|t| t.target.take()).collect();
        targets.extend(self.popups.iter_mut().map(|p| p.target.take()));
        for mut target in targets {
            self.release_target(&mut target);
        }
    }

    /// The shell put a batch on screen: apps that drew into it may draw again.
    pub fn ack(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
        self.passthrough.acked();
        for surface in std::mem::take(&mut self.awaiting_frame) {
            if surface.is_alive() {
                self.frame_done(&surface);
            }
        }
    }

    /// A new shell renderer (a reload): forget what was in flight and tell it
    /// everything again.
    fn reset(&mut self) {
        self.in_flight = 0;
        self.ack();
        for t in &mut self.toplevels {
            t.announced = false;
        }
        for p in &mut self.popups {
            p.announced = false;
        }
        // A fresh page holds no imported buffers.
        self.release_all_targets();
    }

    /// A renderer connected to the frame stream. On the GPU it only carries
    /// presents, and the buffers the renderer has stay valid (a reload resets
    /// them separately): whatever was in flight on the old stream won't be
    /// acked.
    pub fn frames_connected(&mut self) {
        if self.gpu.is_some() {
            self.in_flight = 0;
            self.ack();
        } else {
            self.stream_connected();
        }
    }

    /// A renderer connected to the frame stream: it has no pixels yet, so
    /// every window is redrawn in full.
    pub fn stream_connected(&mut self) {
        self.streaming = true;
        self.in_flight = 0;
        self.ack();
        self.release_all_targets();
        for t in &mut self.toplevels {
            t.canvas = None;
            t.dirty = true;
        }
        for p in &mut self.popups {
            p.canvas = None;
            p.dirty = true;
        }
    }

    /// Recompute popup root positions after a parent moved or repositioned.
    pub fn relayout_popups(&mut self) {
        // Popups are kept in creation order, so parents come first. X11 ones
        // place themselves.
        for index in 0..self.popups.len() {
            let PopupShell::Xdg { parent, .. } = &self.popups[index].shell else { continue };
            let origin = self.geometry_origin(&parent.clone());
            let p = &mut self.popups[index];
            let pos = origin + p.rel;
            if pos != p.pos {
                p.pos = pos;
                if p.announced {
                    let geometry = p.geometry();
                    let message = json!({
                        "type": "configure", "id": p.id, "x": pos.x, "y": pos.y,
                        "width": geometry.size.w, "height": geometry.size.h,
                    });
                    self.wire.json(message);
                }
            }
        }
    }

    pub fn render_cursor(&mut self) {
        let Some(surface) = self.cursor_surface.clone() else { return };
        let hotspot = with_states(&surface, |states| {
            states
                .data_map
                .get::<CursorImageSurfaceData>()
                .map(|data| data.lock().unwrap().hotspot)
                .unwrap_or_default()
        });
        let bbox = bbox_from_surface_tree(&surface, (0, 0));
        let mut canvas = None;
        let patches = render(&mut self.renderer, &mut canvas, &surface, bbox);
        if let Some(patch) = patches.first() {
            self.wire.cursor(patch.width, patch.height, hotspot.x - bbox.loc.x, hotspot.y - bbox.loc.y, &patch.rgba);
        }
        self.frame_done(&surface);
    }

    pub fn restore_keyboard_focus(&mut self) {
        let focus = self.toplevels.iter().find(|t| t.id == self.focused).and_then(|t| match t.x11() {
            Some(x11) => Some(KeyboardFocus::X11(x11.clone())),
            None => t.wl_surface().map(KeyboardFocus::Wayland),
        });
        if let Some(keyboard) = self.seat.get_keyboard() {
            keyboard.set_focus(self, focus, SERIAL_COUNTER.next_serial());
        }
    }

    fn set_focus(&mut self, id: u32) {
        let previous = self.focused;
        self.focused = if self.toplevels.iter().any(|t| t.id == id) { id } else { 0 };
        for t in &self.toplevels {
            if t.id != previous && t.id != self.focused {
                continue;
            }
            let active = t.id == self.focused;
            if let Some(x11) = t.x11() {
                let _ = x11.set_activated(active);
                // X routes input by its own stacking order, so the focused
                // window goes on top there too.
                if let (true, Some(xwm)) = (active, self.xwm.as_mut()) {
                    let _ = xwm.raise_window(x11);
                }
                continue;
            }
            let toplevel = t.window.toplevel().expect("wayland window");
            toplevel.with_pending_state(|state| {
                if active {
                    state.states.set(xdg_toplevel::State::Activated);
                } else {
                    state.states.unset(xdg_toplevel::State::Activated);
                }
            });
            if toplevel.is_initial_configure_sent() {
                toplevel.send_pending_configure();
            }
        }
        self.restore_keyboard_focus();
    }

    fn set_geometry(&mut self, id: u32, x: i32, y: i32, width: i32, height: i32) {
        let Some(t) = self.toplevels.iter_mut().find(|t| t.id == id) else { return };
        let pos: Point<i32, Logical> = (x, y).into();
        let size: Size<i32, Logical> = (width.max(1), height.max(1)).into();
        if let Some(x11) = t.x11() {
            // X windows live at their Din window's position: apps place their
            // menus from it, and Xwayland routes the pointer by it.
            if t.pos != pos || t.known_size != Some(size) {
                let _ = x11.configure(Rectangle::new(pos, size));
            }
            t.pos = pos;
            t.known_size = Some(size);
            return;
        }
        t.pos = pos;
        if t.known_size != Some(size) {
            t.known_size = Some(size);
            let toplevel = t.window.toplevel().expect("wayland window");
            toplevel.with_pending_state(|state| state.size = Some(size));
            if toplevel.is_initial_configure_sent() {
                toplevel.send_pending_configure();
            }
        }
        self.relayout_popups();
    }

    /// The shell maximized or restored a window: its own title bar shows it
    /// (the maximize button becomes a restore button).
    fn set_maximized(&mut self, id: u32, maximized: bool) {
        let Some(t) = self.toplevels.iter().find(|t| t.id == id) else { return };
        if let Some(x11) = t.x11() {
            let _ = x11.set_maximized(maximized);
            return;
        }
        let toplevel = t.window.toplevel().expect("wayland window");
        let known_size = t.known_size;
        toplevel.with_pending_state(|state| {
            if maximized {
                // A window still at the size it picked itself has no size in
                // its configures yet, and maximized at 0x0 is a size Chromium
                // dies on (a CHECK). It keeps its size until the shell's new
                // geometry comes.
                if state.size.is_none() {
                    state.size = known_size;
                }
                state.states.set(xdg_toplevel::State::Maximized);
            } else {
                state.states.unset(xdg_toplevel::State::Maximized);
            }
        });
        if toplevel.is_initial_configure_sent() {
            toplevel.send_pending_configure();
        }
    }

    /// The shell put a window in full screen or took it out. Its size
    /// follows from the geometry the shell reports, as for maximize.
    fn set_fullscreen(&mut self, id: u32, fullscreen: bool) {
        let Some(t) = self.toplevels.iter().find(|t| t.id == id) else { return };
        if let Some(x11) = t.x11() {
            let _ = x11.set_fullscreen(fullscreen);
            return;
        }
        let toplevel = t.window.toplevel().expect("wayland window");
        let known_size = t.known_size;
        toplevel.with_pending_state(|state| {
            if fullscreen {
                // Never 0x0: see set_maximized.
                if state.size.is_none() {
                    state.size = known_size;
                }
                state.states.set(xdg_toplevel::State::Fullscreen);
            } else {
                state.states.unset(xdg_toplevel::State::Fullscreen);
            }
        });
        if toplevel.is_initial_configure_sent() {
            toplevel.send_pending_configure();
        }
    }

    /// The surface under a point and its origin, both in root coordinates.
    /// `id` 0 means the point is already in root coordinates (the shell's
    /// menu shield), where only popups can be hit.
    fn hit(&self, id: u32, x: f64, y: f64) -> (Point<f64, Logical>, Option<(WlSurface, Point<f64, Logical>)>) {
        let popup_hit = |p: &Popup, local: Point<f64, Logical>| {
            let geometry = p.geometry();
            let point = local + geometry.loc.to_f64();
            under_from_surface_tree(&p.wl_surface()?, point, (0, 0), WindowSurfaceType::ALL)
                .map(|(surface, loc)| (surface, (p.pos - geometry.loc + loc).to_f64()))
        };
        if id == 0 {
            let global: Point<f64, Logical> = (x, y).into();
            let focus = self
                .popups
                .iter()
                .rev()
                .find_map(|p| {
                    let rect = Rectangle::new(p.pos, p.geometry().size).to_f64();
                    rect.contains(global).then(|| popup_hit(p, global - p.pos.to_f64())).flatten()
                })
                // Outside every popup with an X menu open: the click still
                // goes to X (Xwayland translates it to root coordinates past
                // the menu's edge), where the menu's pointer grab closes it.
                .or_else(|| {
                    let menu = self.popups.iter().rev().find(|p| p.grab && matches!(p.shell, PopupShell::X11(_)))?;
                    Some((menu.wl_surface()?, menu.pos.to_f64()))
                });
            return (global, focus);
        }
        let local: Point<f64, Logical> = (x, y).into();
        if let Some(t) = self.toplevels.iter().find(|t| t.id == id) {
            let geometry = t.window.geometry();
            let point = local + geometry.loc.to_f64();
            let focus = t
                .window
                .surface_under(point, WindowSurfaceType::TOPLEVEL | WindowSurfaceType::SUBSURFACE)
                .map(|(surface, loc)| (surface, (t.pos - geometry.loc + loc).to_f64()));
            return (t.pos.to_f64() + local, focus);
        }
        if let Some(p) = self.popups.iter().find(|p| p.id == id) {
            return (p.pos.to_f64() + local, popup_hit(p, local));
        }
        (local, None)
    }

    /// Move the pointer to a point the shell reports. `delta` is the DOM's
    /// own movement (relative motion for apps that want it); without one,
    /// it's the distance moved.
    fn motion(&mut self, id: u32, x: f64, y: f64, delta: Option<(f64, f64)>) -> bool {
        let (location, mut focus) = self.hit(id, x, y);
        let hit = focus.is_some();
        let Some(pointer) = self.seat.get_pointer() else { return hit };
        let previous = pointer.current_location();
        let (dx, dy) = delta.unwrap_or((location.x - previous.x, location.y - previous.y));
        let location = match self.constrain(location) {
            // Locked: the pointer stays put; apps get the movement only.
            None => {
                self.relative_motion(dx, dy);
                pointer.frame(self);
                return hit;
            }
            Some(clamped) => {
                // Confined: it stays on the confining surface, however far
                // the real pointer goes.
                if clamped != location {
                    focus = self.pointer_focus.clone();
                }
                clamped
            }
        };
        let event = MotionEvent { location, serial: SERIAL_COUNTER.next_serial(), time: self.now_ms() };
        pointer.motion(self, focus.clone(), &event);
        self.pointer_focus = focus;
        self.relative_motion(dx, dy);
        pointer.frame(self);
        self.activate_constraint();
        hit
    }

    /// Movement while the shell holds a pointer lock: relative only.
    fn locked_motion(&mut self, dx: f64, dy: f64) {
        let Some(pointer) = self.seat.get_pointer() else { return };
        self.relative_motion(dx, dy);
        pointer.frame(self);
    }

    fn dismiss_menus(&mut self) {
        for p in self.popups.iter().filter(|p| p.grab) {
            let PopupShell::Xdg { kind, .. } = &p.shell else { continue };
            if let Ok(root) = find_popup_root_surface(kind) {
                let _ = smithay::desktop::PopupManager::dismiss_popup(&root, kind);
            }
        }
    }

    fn button(&mut self, id: u32, x: f64, y: f64, button: u32, down: bool) {
        let hit = self.motion(id, x, y, None);
        // A click on the shield outside every popup closes the open menus.
        if id == 0 && !hit {
            if down {
                self.dismiss_menus();
            }
            return;
        }
        let Some(pointer) = self.seat.get_pointer() else { return };
        let time = self.now_ms();
        if (4..=7).contains(&button) {
            if down {
                let (axis, sign) = match button {
                    4 => (Axis::Vertical, -1.0),
                    5 => (Axis::Vertical, 1.0),
                    6 => (Axis::Horizontal, -1.0),
                    _ => (Axis::Horizontal, 1.0),
                };
                let frame = AxisFrame::new(time)
                    .source(AxisSource::Wheel)
                    .v120(axis, (120.0 * sign) as i32)
                    .value(axis, 15.0 * sign);
                pointer.axis(self, frame);
                pointer.frame(self);
            }
            return;
        }
        let Some(code) = linux_button(button) else { return };
        let event = ButtonEvent {
            serial: SERIAL_COUNTER.next_serial(),
            time,
            button: code,
            state: if down { ButtonState::Pressed } else { ButtonState::Released },
        };
        pointer.button(self, &event);
        pointer.frame(self);
        if down {
            self.constraint_click();
        }
    }

    fn leave(&mut self) {
        let Some(pointer) = self.seat.get_pointer() else { return };
        let location = pointer.current_location();
        let event = MotionEvent { location, serial: SERIAL_COUNTER.next_serial(), time: self.now_ms() };
        pointer.motion(self, None, &event);
        self.pointer_focus = None;
        pointer.frame(self);
    }

    fn key(&mut self, keycode: u32, down: bool) {
        let Some(keyboard) = self.seat.get_keyboard() else { return };
        // xkb counts presses, so a second press of a key whose release got
        // lost would need two releases: a stuck Alt could never be cleared
        // by pressing it again.
        if down && keyboard.pressed_keys().contains(&keycode.into()) {
            return;
        }
        let state = if down { KeyState::Pressed } else { KeyState::Released };
        let time = self.now_ms();
        keyboard.input::<(), _>(self, keycode.into(), state, SERIAL_COUNTER.next_serial(), time, |_, _, _| {
            FilterResult::Forward
        });
    }

    /// Din's monitors, in viewport pixels, primary first. Each gets an
    /// output of its own, so apps see the monitors they're on: a game going
    /// full screen sizes itself to its monitor (from Xwayland's RandR), not
    /// to the union of them all, which Din would show boxed into one.
    fn set_monitors(&mut self, message: &Value) {
        let rects: Vec<Rectangle<i32, Logical>> = message["monitors"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|m| {
                        let n = |key: &str| m.get(key).and_then(Value::as_f64).filter(|v| v.is_finite()).map(f64::round);
                        let (x, y, w, h) = (n("x")?, n("y")?, n("width")?, n("height")?);
                        (w >= 1.0 && h >= 1.0 && w <= 16384.0 && h <= 16384.0)
                            .then(|| Rectangle::new((x.max(0.0) as i32, y.max(0.0) as i32).into(), (w as i32, h as i32).into()))
                    })
                    .take(MAX_MONITORS)
                    .collect()
            })
            .unwrap_or_default();
        if rects.is_empty() {
            return;
        }
        let apply = |output: &Output, rect: &Rectangle<i32, Logical>| {
            let mode = Mode { size: (rect.size.w, rect.size.h).into(), refresh: 60_000 };
            if output.current_mode() == Some(mode) && output.current_location() == rect.loc {
                return;
            }
            output.change_current_state(Some(mode), None, None, Some(rect.loc));
            output.set_preferred(mode);
        };
        apply(&self.output, &rects[0]);
        for (index, rect) in rects.iter().enumerate().skip(1) {
            if let Some((output, _)) = self.extra_outputs.get(index - 1) {
                apply(output, rect);
                continue;
            }
            let output = Output::new(
                format!("DIN-{}", index + 1),
                PhysicalProperties {
                    size: (0, 0).into(),
                    subpixel: Subpixel::Unknown,
                    make: "Din".into(),
                    model: "Embedded display".into(),
                },
            );
            let mode = Mode { size: (rect.size.w, rect.size.h).into(), refresh: 60_000 };
            output.change_current_state(Some(mode), Some(Transform::Normal), Some(Scale::Integer(1)), Some(rect.loc));
            output.set_preferred(mode);
            let global = output.create_global::<State>(&self.dh);
            self.extra_outputs.push((output, global));
        }
        for (_, global) in self.extra_outputs.drain(rects.len() - 1..) {
            // Clients get time to let go of the output before it's gone.
            self.dh.disable_global::<State>(global.clone());
            let dh = self.dh.clone();
            let _ = self.handle.insert_source(Timer::from_duration(Duration::from_secs(10)), move |_, _, _| {
                dh.remove_global::<State>(global.clone());
                TimeoutAction::Drop
            });
        }
        let union = rects.iter().skip(1).fold(rects[0], |union, rect| union.merge(*rect));
        self.screen = (union.loc.x + union.size.w, union.loc.y + union.size.h).into();
    }

    /// Switch the keyboard layout. Every client gets the new keymap,
    /// Xwayland included, which applies it to its X keyboard.
    fn set_keymap(&mut self, message: &Value) {
        let Some(keyboard) = self.seat.get_keyboard() else { return };
        let field = |key: &str| message.get(key).and_then(Value::as_str).unwrap_or("");
        let config = XkbConfig {
            rules: field("rules"),
            model: field("model"),
            layout: field("layout"),
            variant: field("variant"),
            options: Some(field("options").to_string()),
        };
        if keyboard.set_xkb_config(self, config).is_err() {
            eprintln!("din-compositor: could not compile keymap {message}");
        }
    }

    fn close(&mut self, id: u32) {
        let Some(t) = self.toplevels.iter().find(|t| t.id == id) else { return };
        match (t.window.toplevel(), t.x11()) {
            (Some(toplevel), _) => toplevel.send_close(),
            // WM_DELETE_WINDOW where the app supports it, else XKillClient.
            (_, Some(x11)) => {
                let _ = x11.close();
            }
            _ => {}
        }
    }

    fn set_clipboard(&mut self, contents: Contents) {
        let contents = std::sync::Arc::new(contents);
        set_data_device_selection(&self.dh, &self.seat, contents.mime_types(false), contents.clone());
        self.set_x11_clipboard(contents);
    }

    /// Files dragged from the shell came over window `id`: the drag starts
    /// here (a server-side one, as if the compositor itself were dragging),
    /// or carries on into this window.
    fn drag_enter(&mut self, id: u32, x: f64, y: f64, files: Vec<String>) {
        if !self.dragging {
            if files.is_empty() {
                return;
            }
            if self.seat.get_pointer().is_none() {
                return;
            }
            let (location, _) = self.hit(id, x, y);
            let drag = std::sync::Arc::new(Contents::files(files));
            let metadata = SourceMetadata { mime_types: vec![URI_LIST.into()], dnd_action: DndAction::Copy };
            self.drag = Some(drag);
            self.dragging = true;
            // The button the drag is held by went down in the shell, and
            // comes up there too: the drop (or cancel) below ends the grab.
            let start = GrabStartData { focus: None, button: 0x110, location };
            let (dh, seat) = (self.dh.clone(), self.seat.clone());
            start_dnd(&dh, &seat, self, SERIAL_COUNTER.next_serial(), Some(start), None, metadata);
        }
        self.motion(id, x, y, None);
    }

    /// The drag is over: dropped on whatever the pointer is over now (which
    /// may be nothing), or, with `cancel`, on nothing.
    fn drag_end(&mut self, cancel: bool) {
        if !self.dragging {
            return;
        }
        if cancel {
            self.leave();
        }
        self.dragging = false;
        let Some(pointer) = self.seat.get_pointer() else { return };
        pointer.unset_grab(self, SERIAL_COUNTER.next_serial(), self.now_ms());
        pointer.frame(self);
    }

    /// One message from the shell (see electron/wayland-bridge.mts).
    pub fn handle_message(&mut self, message: &Value) {
        let num = |key: &str| message.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        let id = num("id") as u32;
        match message.get("type").and_then(Value::as_str).unwrap_or("") {
            "ack" => self.ack(),
            "reset" => self.reset(),
            "geometry" => self.set_geometry(
                id,
                num("x").round() as i32,
                num("y").round() as i32,
                num("width").round() as i32,
                num("height").round() as i32,
            ),
            "focus" => self.set_focus(id),
            "state" => self.set_maximized(id, message["maximized"] == true),
            "fullscreen" => self.set_fullscreen(id, message["fullscreen"] == true),
            "close" => self.close(id),
            "motion" => {
                let delta = message.get("dx").is_some().then(|| (num("dx"), num("dy")));
                self.motion(id, num("x"), num("y"), delta);
            }
            "relative" => self.locked_motion(num("dx"), num("dy")),
            "pointer-unlock" => self.release_constraint(),
            "button" => self.button(id, num("x"), num("y"), num("button") as u32, message["down"] == true),
            "key" => self.key(num("keycode") as u32, message["down"] == true),
            "keymap" => self.set_keymap(message),
            "monitors" => self.set_monitors(message),
            "leave" => self.leave(),
            "clipboard" => {
                if let Some(contents) = Contents::from_shell(message) {
                    self.set_clipboard(contents);
                }
            }
            "drag-enter" => {
                let files = message["files"].as_array().map(|files| {
                    files.iter().filter_map(Value::as_str).filter(|p| p.starts_with('/')).map(String::from).collect()
                });
                self.drag_enter(id, num("x"), num("y"), files.unwrap_or_default());
            }
            "drag-drop" => {
                if self.dragging {
                    self.motion(id, num("x"), num("y"), None);
                    self.drag_end(false);
                }
            }
            "drag-end" => self.drag_end(true),
            _ => {}
        }
    }
}
