//! Keyboards, pointers and touchscreens, from libinput.
//!
//! Everything goes to Din (or the popup holding a grab), except
//! Ctrl+Alt+F1..F12, which switch to another virtual terminal: with Din hung,
//! that's the way to a text login; and Super+Alt+8, = and -, which zoom the
//! screen when Settings → Accessibility says so (accessibility.rs). Keys go
//! through the keyboard aids first (keys.rs).

use smithay::{
    backend::input::{
        AbsolutePositionEvent, Axis, ButtonState, Event, GestureBeginEvent, GestureEndEvent,
        GesturePinchUpdateEvent, GestureSwipeUpdateEvent, InputEvent, KeyState, KeyboardKeyEvent, PointerAxisEvent,
        PointerButtonEvent, PointerMotionEvent, TouchEvent,
    },
    backend::libinput::LibinputInputBackend,
    backend::session::Session,
    desktop::WindowSurfaceType,
    input::{
        keyboard::{FilterResult, Keysym, keysyms},
        pointer::{
            AxisFrame, ButtonEvent, GestureHoldBeginEvent, GestureHoldEndEvent, GesturePinchBeginEvent,
            GesturePinchEndEvent, GesturePinchUpdateEvent as PinchUpdate, GestureSwipeBeginEvent,
            GestureSwipeEndEvent, GestureSwipeUpdateEvent as SwipeUpdate, MotionEvent, RelativeMotionEvent,
        },
        touch::{DownEvent, MotionEvent as TouchMotion, UpEvent},
    },
    input::keyboard::Keycode,
    reexports::{
        calloop::timer::{TimeoutAction, Timer},
        wayland_server::protocol::wl_surface::WlSurface,
    },
    utils::{Logical, Point, SERIAL_COUNTER},
    wayland::pointer_constraints::{PointerConstraint, with_pointer_constraint},
};
use tracing::warn;

use super::{
    accessibility::{self, ZoomKey},
    keys::KeyAction,
    magic_mouse,
    state::State,
};

impl State {
    pub fn process_input(&mut self, event: InputEvent<LibinputInputBackend>) {
        match event {
            InputEvent::Keyboard { event } => self.on_key(event),
            InputEvent::PointerMotion { event } => self.on_pointer_motion(event),
            InputEvent::PointerMotionAbsolute { event } => {
                let layout = self.layout_box();
                let location = layout.loc.to_f64() + event.position_transformed(layout.size);
                self.move_pointer(location, event.time_msec());
            }
            InputEvent::PointerButton { event } => {
                let Some(pointer) = self.seat.get_pointer() else { return };
                let serial = SERIAL_COUNTER.next_serial();
                let state = event.state();
                let button = self.mouse_button(&event.device(), event.button_code(), state == ButtonState::Pressed);
                // A click outside a popup, with no grab, goes to Din.
                if state == ButtonState::Pressed && !pointer.is_grabbed() {
                    if let (Some(keyboard), Some(din)) = (self.seat.get_keyboard(), self.din().and_then(|w| w.toplevel()).map(|t| t.wl_surface().clone())) {
                        if keyboard.current_focus().is_none() {
                            keyboard.set_focus(self, Some(din), serial);
                        }
                    }
                }
                pointer.button(
                    self,
                    &ButtonEvent { button, state, serial, time: event.time_msec() },
                );
                pointer.frame(self);
            }
            InputEvent::PointerAxis { event } => self.on_axis(event),
            InputEvent::GestureSwipeBegin { event } => {
                let Some(pointer) = self.seat.get_pointer() else { return };
                let serial = SERIAL_COUNTER.next_serial();
                pointer.gesture_swipe_begin(
                    self,
                    &GestureSwipeBeginEvent { serial, time: event.time_msec(), fingers: event.fingers() },
                );
            }
            InputEvent::GestureSwipeUpdate { event } => {
                let Some(pointer) = self.seat.get_pointer() else { return };
                pointer.gesture_swipe_update(self, &SwipeUpdate { time: event.time_msec(), delta: event.delta() });
            }
            InputEvent::GestureSwipeEnd { event } => {
                let Some(pointer) = self.seat.get_pointer() else { return };
                let serial = SERIAL_COUNTER.next_serial();
                pointer.gesture_swipe_end(
                    self,
                    &GestureSwipeEndEvent { serial, time: event.time_msec(), cancelled: event.cancelled() },
                );
            }
            InputEvent::GesturePinchBegin { event } => {
                let Some(pointer) = self.seat.get_pointer() else { return };
                let serial = SERIAL_COUNTER.next_serial();
                pointer.gesture_pinch_begin(
                    self,
                    &GesturePinchBeginEvent { serial, time: event.time_msec(), fingers: event.fingers() },
                );
            }
            InputEvent::GesturePinchUpdate { event } => {
                let Some(pointer) = self.seat.get_pointer() else { return };
                pointer.gesture_pinch_update(
                    self,
                    &PinchUpdate {
                        time: event.time_msec(),
                        delta: event.delta(),
                        scale: event.scale(),
                        rotation: event.rotation(),
                    },
                );
            }
            InputEvent::GesturePinchEnd { event } => {
                let Some(pointer) = self.seat.get_pointer() else { return };
                let serial = SERIAL_COUNTER.next_serial();
                pointer.gesture_pinch_end(
                    self,
                    &GesturePinchEndEvent { serial, time: event.time_msec(), cancelled: event.cancelled() },
                );
            }
            InputEvent::GestureHoldBegin { event } => {
                let Some(pointer) = self.seat.get_pointer() else { return };
                let serial = SERIAL_COUNTER.next_serial();
                pointer.gesture_hold_begin(
                    self,
                    &GestureHoldBeginEvent { serial, time: event.time_msec(), fingers: event.fingers() },
                );
            }
            InputEvent::GestureHoldEnd { event } => {
                let Some(pointer) = self.seat.get_pointer() else { return };
                let serial = SERIAL_COUNTER.next_serial();
                pointer.gesture_hold_end(
                    self,
                    &GestureHoldEndEvent { serial, time: event.time_msec(), cancelled: event.cancelled() },
                );
            }
            InputEvent::TouchDown { event } => {
                let Some(location) = self.touch_location(&event) else { return };
                let Some(touch) = self.seat.get_touch() else { return };
                let under = self.surface_under(location);
                touch.down(
                    self,
                    under,
                    &DownEvent {
                        slot: event.slot(),
                        location,
                        serial: SERIAL_COUNTER.next_serial(),
                        time: event.time_msec(),
                    },
                );
            }
            InputEvent::TouchMotion { event } => {
                let Some(location) = self.touch_location(&event) else { return };
                let Some(touch) = self.seat.get_touch() else { return };
                let under = self.surface_under(location);
                touch.motion(self, under, &TouchMotion { slot: event.slot(), location, time: event.time_msec() });
            }
            InputEvent::TouchUp { event } => {
                let Some(touch) = self.seat.get_touch() else { return };
                touch.up(
                    self,
                    &UpEvent { slot: event.slot(), serial: SERIAL_COUNTER.next_serial(), time: event.time_msec() },
                );
            }
            InputEvent::TouchFrame { .. } => {
                if let Some(touch) = self.seat.get_touch() {
                    touch.frame(self);
                }
            }
            InputEvent::TouchCancel { .. } => {
                if let Some(touch) = self.seat.get_touch() {
                    touch.cancel(self);
                }
            }
            InputEvent::DeviceAdded { mut device } => self.mouse_device_added(&mut device),
            InputEvent::DeviceRemoved { device } => self.mouse_device_removed(&device),
            _ => {}
        }
    }

    fn on_key(&mut self, event: <LibinputInputBackend as smithay::backend::input::InputBackend>::KeyboardKeyEvent) {
        let time = event.time_msec();
        let outcome = self.accessibility.keys.key(event.key_code().raw(), event.state() == KeyState::Pressed, time);
        if let Some((code, ms)) = outcome.wait {
            let _ = self.handle.insert_source(Timer::from_duration(std::time::Duration::from_millis(ms.into())), move |_, _, state| {
                let keys = state.accessibility.keys.slow_key_held(code);
                let now = std::time::Duration::from(state.clock.now()).as_millis() as u32;
                state.deliver_keys(&keys, now);
                TimeoutAction::Drop
            });
        }
        self.deliver_keys(&outcome.keys, time);
    }

    /// Passes KEYS on to the keyboard, as pressed at TIME.
    pub fn deliver_keys(&mut self, keys: &[KeyAction], time: u32) {
        for key in keys {
            let state = if key.pressed { KeyState::Pressed } else { KeyState::Released };
            self.deliver_key(Keycode::new(key.code), state, time);
        }
    }

    fn deliver_key(&mut self, code: Keycode, state: KeyState, time: u32) {
        let Some(keyboard) = self.seat.get_keyboard() else { return };
        let serial = SERIAL_COUNTER.next_serial();
        let zoom_keys = self.accessibility.settings.zoom_keys;
        let mut suppressed = std::mem::take(&mut self.suppressed_keys);
        let taken = keyboard.input(self, code, state, serial, time, |_, modifiers, handle| {
            let keysym = handle.modified_sym();
            if state == KeyState::Pressed {
                if let Some(vt) = vt_for(keysym) {
                    suppressed.push(keysym);
                    return FilterResult::Intercept(Some(Taken::Vt(vt)));
                }
                if let Some(zoom) = accessibility::zoom_key(modifiers, keysym).filter(|_| zoom_keys) {
                    suppressed.push(keysym);
                    return FilterResult::Intercept(Some(Taken::Zoom(zoom)));
                }
                FilterResult::Forward
            } else if let Some(i) = suppressed.iter().position(|k| *k == keysym) {
                suppressed.remove(i);
                FilterResult::Intercept(None)
            } else {
                FilterResult::Forward
            }
        });
        self.suppressed_keys = suppressed;
        match taken {
            Some(Some(Taken::Vt(vt))) => {
                if let Err(err) = self.backend.session.change_vt(vt) {
                    warn!("switching to VT {vt}: {err}");
                }
            }
            Some(Some(Taken::Zoom(zoom))) => self.zoom_by(zoom),
            _ => {}
        }
    }

    fn on_pointer_motion(&mut self, event: <LibinputInputBackend as smithay::backend::input::InputBackend>::PointerMotionEvent) {
        let Some(pointer) = self.seat.get_pointer() else { return };
        let location = pointer.current_location();
        let under = self.surface_under(location);

        let mut locked = false;
        let mut confined = None;
        if let Some((surface, origin)) = &under {
            with_pointer_constraint(surface, &pointer, |constraint| match constraint {
                Some(constraint) if constraint.is_active() => {
                    if !constraint.region().is_none_or(|r| r.contains((location - *origin).to_i32_round())) {
                        return;
                    }
                    match &*constraint {
                        PointerConstraint::Locked(_) => locked = true,
                        PointerConstraint::Confined(confine) => confined = Some(confine.region().cloned()),
                    }
                }
                _ => {}
            });
        }

        pointer.relative_motion(
            self,
            under.clone(),
            &RelativeMotionEvent { delta: event.delta(), delta_unaccel: event.delta_unaccel(), utime: event.time() },
        );
        if locked {
            pointer.frame(self);
            return;
        }

        let target = self.clamp_to_layout(location + event.delta());
        if let (Some(region), Some((surface, origin))) = (&confined, &under) {
            let new_under = self.surface_under(target);
            if new_under.as_ref().map(|(s, _)| s) != Some(surface)
                || region.as_ref().is_some_and(|r| !r.contains((target - *origin).to_i32_round()))
            {
                pointer.frame(self);
                return;
            }
        }
        self.move_pointer(target, event.time_msec());
    }

    /// Moves the pointer to LOCATION on the layout.
    pub fn move_pointer(&mut self, location: Point<f64, Logical>, time: u32) {
        let Some(pointer) = self.seat.get_pointer() else { return };
        self.queue_redraw_pointer();
        let location = self.clamp_to_layout(location);
        let under = self.surface_under(location);
        pointer.motion(self, under.clone(), &MotionEvent { location, serial: SERIAL_COUNTER.next_serial(), time });
        pointer.frame(self);
        self.shake.moved(location, self.clock.now().into());
        if self.accessibility.zoom > 1.001 {
            // The whole zoomed display moves with the pointer, and one it's left goes back to normal.
            self.queue_redraw_all();
        } else {
            self.queue_redraw_pointer();
        }

        // A constraint takes effect once the pointer is inside it.
        if let Some((surface, origin)) = under {
            with_pointer_constraint(&surface, &pointer, |constraint| match constraint {
                Some(constraint) if !constraint.is_active() => {
                    let point = (location - origin).to_i32_round();
                    if constraint.region().is_none_or(|r| r.contains(point)) {
                        constraint.activate();
                    }
                }
                _ => {}
            });
        }
    }

    fn on_axis(&mut self, event: <LibinputInputBackend as smithay::backend::input::InputBackend>::PointerAxisEvent) {
        // A Magic Mouse whose fingers din-shell reads scrolls from those.
        if magic_mouse::reads_touches(self, &event.device()) {
            return;
        }
        let Some(pointer) = self.seat.get_pointer() else { return };
        let speed = self.mouse.settings.scroll_speed;
        let mut frame = AxisFrame::new(event.time_msec()).source(event.source());
        for axis in [Axis::Horizontal, Axis::Vertical] {
            let v120 = event.amount_v120(axis).map(|v| v * speed);
            let amount = event.amount(axis).map(|a| a * speed).unwrap_or_else(|| v120.unwrap_or(0.0) * 15.0 / 120.0);
            if amount != 0.0 {
                frame = frame.relative_direction(axis, event.relative_direction(axis)).value(axis, amount);
                if let Some(v120) = v120 {
                    frame = frame.v120(axis, v120.round() as i32);
                }
            }
            // libinput ends finger and continuous (trackpoint button) scrolls
            // with a zero; Chromium keeps a scroll latched to the page it
            // started on until the axis_stop.
            if event.amount(axis) == Some(0.0) {
                frame = frame.stop(axis);
            }
        }
        pointer.axis(self, frame);
        pointer.frame(self);
    }

    /// Where a touch lands: on the built-in panel, or else the first display.
    ///
    /// Kept within the panel's last row and column: a finger on the bottom or
    /// right edge reports a hair short of the panel's size, which Smithay's
    /// input-region test rounds onto the pixel past it, outside Din's window,
    /// and the whole touch went nowhere.
    fn touch_location<E: AbsolutePositionEvent<LibinputInputBackend>>(&self, event: &E) -> Option<Point<f64, Logical>> {
        let output = self
            .space
            .outputs()
            .find(|o| o.name().starts_with("eDP") || o.name().starts_with("DSI") || o.name().starts_with("LVDS"))
            .or_else(|| self.space.outputs().next())?;
        let geometry = self.space.output_geometry(output)?;
        let location = geometry.loc.to_f64() + event.position_transformed(geometry.size);
        let g = geometry.to_f64();
        Some(Point::from((
            location.x.clamp(g.loc.x, g.loc.x + g.size.w - 1.0),
            location.y.clamp(g.loc.y, g.loc.y + g.size.h - 1.0),
        )))
    }

    /// The surface at LOCATION on the layout, and where its origin is.
    pub fn surface_under(&self, location: Point<f64, Logical>) -> Option<(WlSurface, Point<f64, Logical>)> {
        let (window, origin) = self.space.element_under(location)?;
        window
            .surface_under(location - origin.to_f64(), WindowSurfaceType::ALL)
            .map(|(surface, offset)| (surface, (origin + offset).to_f64()))
    }

    /// The nearest point to LOCATION that's on a display.
    pub fn clamp_to_layout(&self, location: Point<f64, Logical>) -> Point<f64, Logical> {
        let mut best: Option<(f64, Point<f64, Logical>)> = None;
        for geometry in self.space.outputs().filter_map(|o| self.space.output_geometry(o)) {
            let g = geometry.to_f64();
            let x = location.x.clamp(g.loc.x, g.loc.x + g.size.w - 1.0);
            let y = location.y.clamp(g.loc.y, g.loc.y + g.size.h - 1.0);
            let distance = (x - location.x).powi(2) + (y - location.y).powi(2);
            if best.is_none_or(|(d, _)| distance < d) {
                best = Some((distance, (x, y).into()));
            }
        }
        best.map_or(location, |(_, p)| p)
    }
}

/// A key the compositor took for itself.
enum Taken {
    Vt(i32),
    Zoom(ZoomKey),
}

/// The VT Ctrl+Alt+F<N> switches to (XKB maps it to XF86Switch_VT_<N>).
fn vt_for(keysym: Keysym) -> Option<i32> {
    let raw = keysym.raw();
    (keysyms::KEY_XF86Switch_VT_1..=keysyms::KEY_XF86Switch_VT_12)
        .contains(&raw)
        .then(|| (raw - keysyms::KEY_XF86Switch_VT_1 + 1) as i32)
}
