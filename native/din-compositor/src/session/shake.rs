//! Shake to find the pointer, as on a Mac: shaking the mouse makes the
//! pointer big, the bigger the harder it's shaken, and it eases back once the
//! shaking stops. Din turns it on and off (cursor.rs); the big pointer is the
//! theme's arrow, drawn in place of whatever pointer there is (render.rs).
//!
//! A shake is strokes back and forth in quick succession, and as on a Mac it
//! takes a good hard one. Each long, quick stroke the pointer turns back
//! from adds one to the shake's energy, which drains away steadily, so a few
//! strokes in passing never add up, while shaking keeps it topped up the
//! higher the quicker the strokes come. Past a few strokes' worth, how far past sets how big
//! the pointer is to be. That's held while the strokes keep coming, sagging
//! only slowly if the shaking eases, so the pointer doesn't throb with each
//! stroke, and let go of once they stop, so it shrinks back in one go. The
//! size drawn follows it on a critically damped spring, so it neither pops
//! nor stops dead.
//!
//! A pointer moved with a button held is dragging something (a window, a
//! selection, a stroke of paint), however it's shaken, so it never grows
//! then, and one already big shrinks back as the button goes down.

use std::time::Duration;

use smithay::utils::{Logical, Point};
use tracing::debug;

/// How quickly the energy drains (a time constant, in seconds).
const DRAIN: f64 = 0.45;
/// How much energy it takes before the pointer starts to grow.
const THRESHOLD: f64 = 2.4;
/// How much bigger the pointer gets for each stroke's energy past that, and at most.
const GAIN: f64 = 1.6;
pub const MAX_SCALE: f64 = 4.5;
/// How long a stroke must be, in logical pixels, and how quickly made, to count:
/// not a hand's tremor, nor going back and forth over something.
const MIN_STROKE: f64 = 80.0;
const MAX_STROKE_TIME: Duration = Duration::from_millis(300);
/// How far the pointer must come back before it has turned, not just wavered.
const TURN: f64 = 12.0;
/// The spring's stiffness, as an angular frequency: growing, and shrinking back.
const GROW: f64 = 22.0;
const SHRINK: f64 = 16.0;
/// How long after the last stroke the shake still holds the pointer big.
const HOLD: Duration = Duration::from_millis(350);
/// How fast a held size sags while the shaking eases, in times its size a second.
const SAG: f64 = 2.5;

#[derive(Default)]
pub struct Shake {
    enabled: bool,
    last: Option<Point<f64, Logical>>,
    /// The stroke so far, from where the pointer last turned.
    stroke: (f64, f64),
    /// How far it's come back against the stroke since.
    back: (f64, f64),
    /// When the stroke began.
    stroke_from: Duration,
    energy: f64,
    energy_at: Option<Duration>,
    /// When the last stroke counted, and how big it's held to be meanwhile, past 1.
    stroked_at: Option<Duration>,
    held: f64,
    /// How big it's drawn, past 1, and how fast that's changing.
    scale: f64,
    velocity: f64,
    last_step: Option<Duration>,
    /// The buttons held down.
    pressed: Vec<u32>,
    /// The biggest it's been drawn this shake, for the log.
    peak: f64,
}

impl Shake {
    pub fn set_enabled(&mut self, enabled: bool) {
        if !enabled {
            *self = Shake::default();
        }
        self.enabled = enabled;
    }

    /// A button went down (PRESSED) or up.
    pub fn button(&mut self, button: u32, pressed: bool) {
        self.pressed.retain(|&b| b != button);
        if pressed {
            self.pressed.push(button);
        }
    }

    /// The pointer moved to AT at NOW.
    pub fn moved(&mut self, at: Point<f64, Logical>, now: Duration) {
        if !self.enabled {
            return;
        }
        self.drain(now);
        let Some(last) = self.last.replace(at) else { return };
        if !self.pressed.is_empty() {
            self.energy = 0.0;
            self.stroked_at = None;
            self.stroke = (0.0, 0.0);
            self.back = (0.0, 0.0);
            return;
        }
        let (dx, dy) = (at.x - last.x, at.y - last.y);
        let (sx, sy) = self.stroke;
        if (sx != 0.0 || sy != 0.0) && dx * sx + dy * sy < 0.0 {
            self.back = (self.back.0 + dx, self.back.1 + dy);
            if self.back.0.hypot(self.back.1) >= TURN {
                if sx.hypot(sy) >= MIN_STROKE && now.saturating_sub(self.stroke_from) <= MAX_STROKE_TIME {
                    let before = self.wanted();
                    self.energy += 1.0;
                    self.stroked_at = Some(now);
                    if before == 0.0 && self.wanted() > 0.0 {
                        debug!("shake: the pointer grows");
                    }
                }
                self.stroke = self.back;
                self.back = (0.0, 0.0);
                self.stroke_from = now;
            }
        } else {
            self.stroke = (sx + self.back.0 + dx, sy + self.back.1 + dy);
            self.back = (0.0, 0.0);
        }
    }

    fn drain(&mut self, now: Duration) {
        if let Some(at) = self.energy_at {
            self.energy *= (-now.saturating_sub(at).as_secs_f64() / DRAIN).exp();
        }
        self.energy_at = Some(now);
    }

    /// How much bigger than itself the shake asks for the pointer to be.
    fn wanted(&self) -> f64 {
        ((self.energy - THRESHOLD) * GAIN).clamp(0.0, MAX_SCALE - 1.0)
    }

    /// Moves the size along to NOW; true while it's still changing.
    pub fn step(&mut self, now: Duration) -> bool {
        let dt = self.last_step.map_or(0.0, |last| now.saturating_sub(last).as_secs_f64().min(0.05));
        self.last_step = Some(now);
        self.drain(now);
        let shaking = self.stroked_at.is_some_and(|at| now.saturating_sub(at) < HOLD);
        self.held = if shaking { self.wanted().max(self.held - SAG * dt) } else { 0.0 };
        let target = self.held;
        // In small steps, so a slow frame doesn't throw the spring.
        let mut left = dt;
        while left > 0.0 {
            let h = left.min(0.004);
            left -= h;
            let omega = if target > self.scale { GROW } else { SHRINK };
            let accel = omega * omega * (target - self.scale) - 2.0 * omega * self.velocity;
            self.velocity += accel * h;
            self.scale = (self.scale + self.velocity * h).max(0.0);
        }
        self.peak = self.peak.max(self.scale);
        let active = target > 0.0 || self.scale > 0.005 || self.velocity.abs() > 0.01;
        if !active {
            if self.peak > 0.0 {
                debug!("shake: the pointer grew to {:.1}×", 1.0 + self.peak);
            }
            self.peak = 0.0;
            self.scale = 0.0;
            self.velocity = 0.0;
            self.last_step = None;
        }
        active
    }

    /// How many times its size the pointer's drawn now.
    pub fn scale(&self) -> f64 {
        1.0 + self.scale
    }
}

