//! Pointer lock and confinement (pointer-constraints) and relative motion
//! (relative-pointer): what games and 3D apps use for mouse-look. Xwayland
//! uses them too, for X games that grab and warp the pointer.
//!
//! A lock is mirrored by DOM Pointer Lock on the window's canvas: the shell
//! hides the cursor and reports raw movement, which becomes relative motion
//! here while the pointer stays put. The shell can't confine the real
//! pointer, so a confinement only clamps the positions apps see.
//!
//! Escape, or anything else that ends the shell's lock, releases the
//! constraint, and it comes back only on the next click in the window - an
//! app can't take the pointer back on its own and trap the user.

use smithay::{
    delegate_pointer_constraints, delegate_relative_pointer,
    desktop::utils::bbox_from_surface_tree,
    input::pointer::{PointerHandle, RelativeMotionEvent},
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Logical, Point, Rectangle},
    wayland::{
        compositor::RectangleKind,
        pointer_constraints::{PointerConstraint, PointerConstraintsHandler, with_pointer_constraint},
    },
};

use crate::state::{State, root_surface};

impl State {
    /// The constraint on the surface under the pointer: whether it locks
    /// (rather than confines), and whether it's active.
    fn focused_constraint(&self) -> Option<(WlSurface, bool, bool)> {
        let pointer = self.seat.get_pointer()?;
        let surface = pointer.current_focus()?;
        let found = with_pointer_constraint(&surface, &pointer, |constraint| {
            constraint.map(|c| (matches!(&*c, PointerConstraint::Locked(_)), c.is_active()))
        });
        found.map(|(locked, active)| (surface, locked, active))
    }

    /// Activate the constraint under the pointer, where the pointer is in its
    /// region and the user hasn't released it since their last click.
    pub fn activate_constraint(&mut self) {
        if self.constraint_released {
            return;
        }
        let Some(pointer) = self.seat.get_pointer() else { return };
        let Some((surface, origin)) = self.pointer_focus.clone() else { return };
        let point = (pointer.current_location() - origin).to_i32_round();
        with_pointer_constraint(&surface, &pointer, |constraint| {
            let Some(constraint) = constraint else { return };
            if !constraint.is_active() && constraint.region().is_none_or(|r| r.contains(point)) {
                constraint.activate();
            }
        });
    }

    /// The shell's lock ended: release the constraint until the next click.
    pub fn release_constraint(&mut self) {
        self.constraint_released = true;
        let Some(pointer) = self.seat.get_pointer() else { return };
        let Some(surface) = pointer.current_focus() else { return };
        with_pointer_constraint(&surface, &pointer, |constraint| {
            if let Some(constraint) = constraint.filter(|c| c.is_active()) {
                constraint.deactivate();
            }
        });
    }

    /// A click in a window lets its constraint take hold again.
    pub fn constraint_click(&mut self) {
        self.constraint_released = false;
        self.activate_constraint();
    }

    /// Where the pointer may go when the shell moves it to `location` (root
    /// coordinates): None while locked, inside the region while confined.
    pub fn constrain(&self, location: Point<f64, Logical>) -> Option<Point<f64, Logical>> {
        let Some((surface, locked, true)) = self.focused_constraint() else { return Some(location) };
        if locked {
            return None;
        }
        let (_, origin) = self.pointer_focus.as_ref().filter(|(s, _)| *s == surface)?;
        let pointer = self.seat.get_pointer()?;
        let region = with_pointer_constraint(&surface, &pointer, |constraint| {
            let rects = constraint?.region()?.rects.clone();
            rects
                .into_iter()
                .filter(|(kind, _)| matches!(kind, RectangleKind::Add))
                .map(|(_, rect)| rect)
                .reduce(|a, b| a.merge(b))
        });
        let bounds: Rectangle<i32, Logical> = region.unwrap_or_else(|| bbox_from_surface_tree(&surface, (0, 0)));
        let min = *origin + bounds.loc.to_f64();
        let max = (min.x + (bounds.size.w - 1).max(0) as f64, min.y + (bounds.size.h - 1).max(0) as f64);
        Some((location.x.clamp(min.x, max.0), location.y.clamp(min.y, max.1)).into())
    }

    /// Relative motion to the surface under the pointer.
    pub fn relative_motion(&mut self, dx: f64, dy: f64) {
        if dx == 0.0 && dy == 0.0 {
            return;
        }
        let Some(pointer) = self.seat.get_pointer() else { return };
        let focus = self.pointer_focus.clone();
        let event = RelativeMotionEvent {
            delta: (dx, dy).into(),
            delta_unaccel: (dx, dy).into(),
            utime: self.start.elapsed().as_micros() as u64,
        };
        pointer.relative_motion(self, focus, &event);
    }

    /// Tell the shell when a lock starts or ends, however it did: activated,
    /// destroyed by the app, or lost with the pointer focus.
    pub fn report_pointer_lock(&mut self) {
        let locked = self
            .focused_constraint()
            .filter(|(_, locked, active)| *locked && *active)
            .and_then(|(surface, ..)| {
                let root = root_surface(&surface);
                let toplevel = self.toplevel_for(&root).map(|t| t.id);
                toplevel.or_else(|| self.popup_for(&root).map(|p| p.id))
            })
            .unwrap_or(0);
        if locked == self.pointer_lock {
            return;
        }
        if self.pointer_lock != 0 {
            self.wire.json(serde_json::json!({ "type": "pointer-lock", "id": self.pointer_lock, "locked": false }));
        }
        if locked != 0 {
            self.wire.json(serde_json::json!({ "type": "pointer-lock", "id": locked, "locked": true }));
        }
        self.pointer_lock = locked;
    }
}

impl PointerConstraintsHandler for State {
    fn new_constraint(&mut self, surface: &WlSurface, pointer: &PointerHandle<Self>) {
        if pointer.current_focus().as_ref() == Some(surface) {
            self.activate_constraint();
        }
    }

    fn cursor_position_hint(
        &mut self,
        _surface: &WlSurface,
        _pointer: &PointerHandle<Self>,
        _location: Point<f64, Logical>,
    ) {
    }
}

delegate_pointer_constraints!(State);
delegate_relative_pointer!(State);
