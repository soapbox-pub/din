//! Shake to find the pointer, as on a Mac: shaking the mouse makes the
//! pointer big, the bigger the harder it's shaken, and it eases back once the
//! shaking stops. Din turns it on and off (cursor.rs); the big pointer is the
//! theme's arrow, drawn in place of whatever pointer there is (render.rs).
//!
//! A shake is a lot of travel in a small space: over the last moment, the
//! length of the path the pointer took against the diagonal of the box it
//! stayed in (KWin's measure). Going straight is 1, there and back again 2,
//! and each stroke of a shake adds about 1. Past a few strokes, how far past
//! sets how big the pointer is to be; that fades steadily, and each move
//! of the shake tops it back up. The size drawn follows it on a critically
//! damped spring, so it neither pops nor stops dead.

use std::{collections::VecDeque, time::Duration};

use smithay::utils::{Logical, Point};

/// The stretch of movement a shake is measured over.
const WINDOW: Duration = Duration::from_millis(600);
/// How many strokes it takes before the pointer starts to grow.
const THRESHOLD: f64 = 3.0;
/// How much bigger the pointer gets for each stroke past that, and at most.
const GAIN: f64 = 0.9;
pub const MAX_SCALE: f64 = 4.5;
/// The smallest box, in logical pixels, a shake counts in: not a hand's tremor.
const MIN_DIAGONAL: f64 = 60.0;
/// How quickly the size a shake asks for fades once it stops (a time constant).
const FADE: f64 = 0.16;
/// The spring's stiffness, as an angular frequency: growing, and shrinking back.
const GROW: f64 = 24.0;
const SHRINK: f64 = 13.0;
/// The most movement history kept.
const MAX_HISTORY: usize = 512;

#[derive(Default)]
pub struct Shake {
    enabled: bool,
    /// Where the pointer turned, and when; runs in one direction are kept as their end.
    history: VecDeque<(Point<f64, Logical>, Duration)>,
    /// How big the shake asks for the pointer to be, past 1.
    level: f64,
    /// How big it's drawn, past 1, and how fast that's changing.
    scale: f64,
    velocity: f64,
    last_step: Option<Duration>,
}

impl Shake {
    pub fn set_enabled(&mut self, enabled: bool) {
        if !enabled {
            *self = Shake::default();
        }
        self.enabled = enabled;
    }

    /// The pointer moved to AT at NOW.
    pub fn moved(&mut self, at: Point<f64, Logical>, now: Duration) {
        if !self.enabled {
            return;
        }
        while self.history.front().is_some_and(|(_, t)| now.saturating_sub(*t) > WINDOW) {
            self.history.pop_front();
        }
        let n = self.history.len();
        if n >= 2 {
            let (last, _) = self.history[n - 1];
            let (prev, _) = self.history[n - 2];
            let same = |a: f64, b: f64| (a >= 0.0) == (b >= 0.0);
            if same(last.x - prev.x, at.x - last.x) && same(last.y - prev.y, at.y - last.y) {
                self.history[n - 1] = (at, now);
                self.measure();
                return;
            }
        }
        if self.history.len() >= MAX_HISTORY {
            self.history.pop_front();
        }
        self.history.push_back((at, now));
        self.measure();
    }

    fn measure(&mut self) {
        let Some(&(first, _)) = self.history.front() else { return };
        let (mut left, mut top, mut right, mut bottom) = (first.x, first.y, first.x, first.y);
        let mut path = 0.0;
        let mut prev = first;
        for &(p, _) in self.history.iter().skip(1) {
            left = left.min(p.x);
            top = top.min(p.y);
            right = right.max(p.x);
            bottom = bottom.max(p.y);
            path += (p.x - prev.x).hypot(p.y - prev.y);
            prev = p;
        }
        let diagonal = (right - left).hypot(bottom - top);
        if diagonal < MIN_DIAGONAL {
            return;
        }
        let wanted = ((path / diagonal - THRESHOLD) * GAIN).clamp(0.0, MAX_SCALE - 1.0);
        self.level = self.level.max(wanted);
    }

    /// Moves the size along to NOW; true while it's still changing.
    pub fn step(&mut self, now: Duration) -> bool {
        let dt = self.last_step.map_or(0.0, |last| now.saturating_sub(last).as_secs_f64().min(0.05));
        self.last_step = Some(now);
        self.level *= (-dt / FADE).exp();
        // In small steps, so a slow frame doesn't throw the spring.
        let mut left = dt;
        while left > 0.0 {
            let h = left.min(0.004);
            left -= h;
            let omega = if self.level > self.scale { GROW } else { SHRINK };
            let accel = omega * omega * (self.level - self.scale) - 2.0 * omega * self.velocity;
            self.velocity += accel * h;
            self.scale = (self.scale + self.velocity * h).max(0.0);
        }
        let active = self.level > 0.005 || self.scale > 0.005 || self.velocity.abs() > 0.01;
        if !active {
            self.level = 0.0;
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
