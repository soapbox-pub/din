//! What the compositor does between protocol events: announcing windows to
//! the shell, rendering what changed, pacing apps by the shell's acks, and
//! applying the shell's input and window-management messages.

use serde_json::{Value, json};
use smithay::{
    backend::{
        input::{Axis, AxisSource, ButtonState, KeyState},
        renderer::utils::{import_surface_tree, with_renderer_surface_state},
    },
    desktop::{
        PopupKind, WindowSurfaceType, find_popup_root_surface,
        utils::{bbox_from_surface_tree, send_frames_surface_tree, under_from_surface_tree, with_surfaces_surface_tree},
    },
    input::{
        keyboard::FilterResult,
        pointer::{AxisFrame, ButtonEvent, CursorImageSurfaceData, MotionEvent},
    },
    reexports::{
        wayland_protocols::xdg::shell::server::xdg_toplevel,
        wayland_server::{Resource, protocol::wl_surface::WlSurface},
    },
    utils::{Logical, Point, Rectangle, SERIAL_COUNTER, Size},
    wayland::{
        compositor::with_states,
        selection::data_device::set_data_device_selection,
        shell::xdg::XdgToplevelSurfaceData,
    },
};

use crate::{
    canvas::{Canvas, Patch},
    state::State,
};

/// Batches in flight before rendering pauses; damage accumulates meanwhile.
/// The CPU path overlaps two, since producing a batch takes a while. On the
/// GPU, rendering takes about a millisecond, and one batch per display frame
/// is the goal: a second would only show the same frame twice, while apps
/// whose surfaces commit separately (Firefox's video subsurface) would be
/// paced at double the refresh rate.
const MAX_IN_FLIGHT_CPU: u32 = 2;
const MAX_IN_FLIGHT_GPU: u32 = 1;

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

/// A popup's window geometry, falling back to its buffer's extent.
fn popup_geometry(kind: &PopupKind) -> Rectangle<i32, Logical> {
    let geometry = kind.geometry();
    if geometry.size.w > 0 && geometry.size.h > 0 {
        geometry
    } else {
        bbox_from_surface_tree(kind.wl_surface(), (0, 0))
    }
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
    fn frame_done(&self, surface: &WlSurface) {
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

    /// Announce newly mapped windows and report title/size changes.
    fn announce(&mut self) {
        let mut messages = Vec::new();
        for index in 0..self.toplevels.len() {
            let surface = self.toplevels[index].surface().clone();
            if !has_buffer(&surface) {
                continue;
            }
            let (title, app_id) = with_states(&surface, |states| {
                let data = states.data_map.get::<XdgToplevelSurfaceData>();
                let data = data.map(|d| d.lock().unwrap());
                (
                    data.as_ref().and_then(|d| d.title.clone()).unwrap_or_default(),
                    data.as_ref().and_then(|d| d.app_id.clone()).unwrap_or_default(),
                )
            });
            let geometry = self.toplevels[index].window.geometry();
            let pid = self.pid_of(&surface);
            let toplevel = self.toplevels[index].window.toplevel().expect("wayland window").clone();
            let t = &mut self.toplevels[index];
            if !t.announced {
                t.announced = true;
                t.title = title.clone();
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
                    "wmClass": if app_id.is_empty() { vec![] } else { vec![app_id] },
                    "pid": pid,
                    "kind": if toplevel.parent().is_some() { "DIALOG" } else { "NORMAL" },
                    "transientFor": Value::Null,
                }));
                self.enter_output(&surface);
                continue;
            }
            if title != t.title {
                t.title = title.clone();
                messages.push(json!({ "type": "title", "id": t.id, "title": title }));
            }
            // The app sized itself (an initial size, a minimum it insists
            // on): the Din window follows. Only once it has acked the shell's
            // last configure, so a stale commit never fights a live resize.
            let acked = toplevel.with_pending_state(|s| s.size) == toplevel.current_state().size;
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
            let surface = self.popups[index].kind.wl_surface().clone();
            if self.popups[index].announced || !has_buffer(&surface) {
                continue;
            }
            let geometry = popup_geometry(&self.popups[index].kind);
            let p = &mut self.popups[index];
            p.announced = true;
            p.dirty = true;
            p.canvas = None;
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
                // Menus grab; the shell shields the desktop for those.
                "kind": if p.grab { "POPUP_MENU" } else { "NORMAL" },
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
            let surface = t.surface().clone();
            let patches = render(renderer, &mut t.canvas, &surface, t.window.geometry());
            for patch in &patches {
                frames.patch(t.id, patch);
            }
            sent |= !patches.is_empty();
            if patches.is_empty() { idle.push(surface) } else { waiting.push(surface) }
        }
        for p in popups.iter_mut().filter(|p| p.announced && p.dirty) {
            p.dirty = false;
            let surface = p.kind.wl_surface().clone();
            let patches = render(renderer, &mut p.canvas, &surface, popup_geometry(&p.kind));
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
        let State { toplevels, popups, gpu, buffers, .. } = self;
        let (Some(gpu), Some(buffers)) = (gpu.as_mut(), buffers.as_mut()) else { return };
        let windows = toplevels
            .iter_mut()
            .filter(|t| t.announced && t.dirty)
            .map(|t| {
                let geometry = t.window.geometry();
                (t.id, t.surface().clone(), geometry, &mut t.dirty, &mut t.target)
            })
            .chain(popups.iter_mut().filter(|p| p.announced && p.dirty).map(|p| {
                let geometry = popup_geometry(&p.kind);
                (p.id, p.kind.wl_surface().clone(), geometry, &mut p.dirty, &mut p.target)
            }));
        for (id, surface, geometry, dirty, target) in windows {
            *dirty = false;
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
            buffers.send(&json!({ "type": "present", "windows": presents }), None);
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
        let mut targets: Vec<_> = self.toplevels.iter_mut().map(|t| t.target.take()).collect();
        targets.extend(self.popups.iter_mut().map(|p| p.target.take()));
        for mut target in targets {
            self.release_target(&mut target);
        }
    }

    /// The shell put a batch on screen: apps that drew into it may draw again.
    fn ack(&mut self) {
        self.in_flight = self.in_flight.saturating_sub(1);
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
        // Popups are kept in creation order, so parents come first.
        for index in 0..self.popups.len() {
            let origin = self.geometry_origin(&self.popups[index].parent.clone());
            let p = &mut self.popups[index];
            let pos = origin + p.rel;
            if pos != p.pos {
                p.pos = pos;
                if p.announced {
                    let geometry = popup_geometry(&p.kind);
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
        let surface = self.toplevels.iter().find(|t| t.id == self.focused).map(|t| t.surface().clone());
        if let Some(keyboard) = self.seat.get_keyboard() {
            keyboard.set_focus(self, surface, SERIAL_COUNTER.next_serial());
        }
    }

    fn set_focus(&mut self, id: u32) {
        let previous = self.focused;
        self.focused = if self.toplevels.iter().any(|t| t.id == id) { id } else { 0 };
        for t in &self.toplevels {
            if t.id != previous && t.id != self.focused {
                continue;
            }
            let toplevel = t.window.toplevel().expect("wayland window");
            let active = t.id == self.focused;
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
        t.pos = (x, y).into();
        let size: Size<i32, Logical> = (width.max(1), height.max(1)).into();
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

    /// The surface under a point and its origin, both in root coordinates.
    /// `id` 0 means the point is already in root coordinates (the shell's
    /// menu shield), where only popups can be hit.
    fn hit(&self, id: u32, x: f64, y: f64) -> (Point<f64, Logical>, Option<(WlSurface, Point<f64, Logical>)>) {
        let popup_hit = |p: &crate::state::Popup, local: Point<f64, Logical>| {
            let geometry = popup_geometry(&p.kind);
            let point = local + geometry.loc.to_f64();
            under_from_surface_tree(p.kind.wl_surface(), point, (0, 0), WindowSurfaceType::ALL)
                .map(|(surface, loc)| (surface, (p.pos - geometry.loc + loc).to_f64()))
        };
        if id == 0 {
            let global: Point<f64, Logical> = (x, y).into();
            let focus = self.popups.iter().rev().find_map(|p| {
                let geometry = popup_geometry(&p.kind);
                let rect = Rectangle::new(p.pos, geometry.size).to_f64();
                rect.contains(global).then(|| popup_hit(p, global - p.pos.to_f64())).flatten()
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

    fn motion(&mut self, id: u32, x: f64, y: f64) -> bool {
        let (location, focus) = self.hit(id, x, y);
        let hit = focus.is_some();
        let Some(pointer) = self.seat.get_pointer() else { return hit };
        let event = MotionEvent { location, serial: SERIAL_COUNTER.next_serial(), time: self.now_ms() };
        pointer.motion(self, focus, &event);
        pointer.frame(self);
        hit
    }

    fn dismiss_menus(&mut self) {
        for p in self.popups.iter().filter(|p| p.grab) {
            if let Ok(root) = find_popup_root_surface(&p.kind) {
                let _ = smithay::desktop::PopupManager::dismiss_popup(&root, &p.kind);
            }
        }
    }

    fn button(&mut self, id: u32, x: f64, y: f64, button: u32, down: bool) {
        let hit = self.motion(id, x, y);
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
    }

    fn leave(&mut self) {
        let Some(pointer) = self.seat.get_pointer() else { return };
        let location = pointer.current_location();
        let event = MotionEvent { location, serial: SERIAL_COUNTER.next_serial(), time: self.now_ms() };
        pointer.motion(self, None, &event);
        pointer.frame(self);
    }

    fn key(&mut self, keycode: u32, down: bool) {
        let Some(keyboard) = self.seat.get_keyboard() else { return };
        let state = if down { KeyState::Pressed } else { KeyState::Released };
        let time = self.now_ms();
        keyboard.input::<(), _>(self, keycode.into(), state, SERIAL_COUNTER.next_serial(), time, |_, _, _| {
            FilterResult::Forward
        });
    }

    fn close(&mut self, id: u32) {
        if let Some(t) = self.toplevels.iter().find(|t| t.id == id) {
            t.window.toplevel().expect("wayland window").send_close();
        }
    }

    fn set_clipboard(&mut self, text: String) {
        let mimes = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT"]
            .map(String::from)
            .to_vec();
        set_data_device_selection(&self.dh, &self.seat, mimes, std::sync::Arc::new(text));
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
            "close" => self.close(id),
            "motion" => {
                self.motion(id, num("x"), num("y"));
            }
            "button" => self.button(id, num("x"), num("y"), num("button") as u32, message["down"] == true),
            "key" => self.key(num("keycode") as u32, message["down"] == true),
            "leave" => self.leave(),
            "clipboard" => {
                if let Some(text) = message.get("text").and_then(Value::as_str) {
                    self.set_clipboard(text.to_string());
                }
            }
            _ => {}
        }
    }
}
