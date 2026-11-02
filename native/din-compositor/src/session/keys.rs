//! The keyboard aids, between the keyboards and everything they type into
//! (input.rs), each on its own from Settings → Accessibility:
//!
//! - Bounce keys: a key pressed again within a moment of coming up didn't
//!   mean to be, so it's left out, press and release.
//! - Slow keys: a key only counts once it's been held a moment; a brush
//!   past one is left out.
//! - Sticky keys: Shift, Ctrl, Alt or Super pressed and let go on its own
//!   stays down for the next key, pressed twice stays down until it's
//!   pressed again; held with another key, it's as it always is.
//!
//! In that order: what bounce keys keeps, slow keys sees, and what that
//! lets through goes to sticky keys. Key codes are XKB's (evdev's plus 8),
//! and times libinput's milliseconds.

use std::collections::{HashMap, HashSet};

/// The modifiers sticky keys holds: Shift, Ctrl, Alt and Super, left and right.
const MODIFIERS: [u32; 8] = [50, 62, 37, 105, 64, 108, 133, 134];

#[derive(Clone, Copy, PartialEq, Debug)]
enum Sticky {
    /// Held down; CHORDED once another key's been pressed with it.
    Down { chorded: bool },
    /// Let go on its own: down for the next key.
    Latched,
    /// Pressed again while latched, and not yet let go.
    LatchedAgain,
    /// Down until it's pressed again.
    Locked,
    /// Pressed again while locked, and not yet let go.
    LockedAgain,
}

/// What the keyboard's to be told: key CODE went down, or up.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct KeyAction {
    pub code: u32,
    pub pressed: bool,
}

/// What a key event comes to: the keys to pass on, and, for slow keys, a
/// key to wait on for so many ms before calling `slow_key_held`.
#[derive(Default, PartialEq, Debug)]
pub struct Outcome {
    pub keys: Vec<KeyAction>,
    pub wait: Option<(u32, u32)>,
}

#[derive(Default)]
pub struct Keys {
    sticky: bool,
    slow_ms: u32,
    bounce_ms: u32,
    /// When each key last came up, for bounce keys.
    released_at: HashMap<u32, u32>,
    /// Presses bounce keys left out, whose releases it leaves out too.
    bounced: HashSet<u32>,
    /// Keys held, waiting to have been held long enough; and those that were.
    slow_waiting: HashSet<u32>,
    slow_taken: HashSet<u32>,
    modifiers: HashMap<u32, Sticky>,
    /// Keys pressed while modifiers were latched, which let them go as they come up.
    using_latched: HashSet<u32>,
}

impl Keys {
    /// Turns the aids on or off; the modifiers sticky keys held go back up.
    pub fn configure(&mut self, sticky: bool, slow_ms: u32, bounce_ms: u32) -> Vec<KeyAction> {
        let mut released = Vec::new();
        if !sticky {
            released = self.release_held(|_| true);
        }
        self.sticky = sticky;
        self.slow_ms = slow_ms;
        self.bounce_ms = bounce_ms;
        if slow_ms == 0 {
            self.slow_waiting.clear();
        }
        released
    }

    /// Key CODE went down (PRESSED) or up at TIME.
    pub fn key(&mut self, code: u32, pressed: bool, time: u32) -> Outcome {
        // Bounce keys.
        if pressed {
            let bounced = self.bounce_ms > 0
                && self.released_at.get(&code).is_some_and(|&at| time.wrapping_sub(at) < self.bounce_ms);
            if bounced {
                self.bounced.insert(code);
                return Outcome::default();
            }
        } else {
            if self.bounced.remove(&code) {
                return Outcome::default();
            }
            self.released_at.insert(code, time);
        }

        // Slow keys.
        if pressed && self.slow_ms > 0 {
            self.slow_waiting.insert(code);
            return Outcome { keys: Vec::new(), wait: Some((code, self.slow_ms)) };
        }
        if !pressed && self.slow_waiting.remove(&code) {
            return Outcome::default();
        }
        if !pressed {
            self.slow_taken.remove(&code);
        }

        Outcome { keys: self.sticky_key(code, pressed), wait: None }
    }

    /// Slow keys' wait for CODE is over: if it's still held, it counts now.
    pub fn slow_key_held(&mut self, code: u32) -> Vec<KeyAction> {
        if !self.slow_waiting.remove(&code) {
            return Vec::new();
        }
        self.slow_taken.insert(code);
        self.sticky_key(code, true)
    }

    fn sticky_key(&mut self, code: u32, pressed: bool) -> Vec<KeyAction> {
        let pass = vec![KeyAction { code, pressed }];
        if !self.sticky {
            return pass;
        }
        if MODIFIERS.contains(&code) {
            let state = self.modifiers.get(&code).copied();
            let (next, keys) = match (state, pressed) {
                (None, true) => (Some(Sticky::Down { chorded: false }), pass),
                (Some(Sticky::Latched), true) => (Some(Sticky::LatchedAgain), Vec::new()),
                (Some(Sticky::Locked), true) => (Some(Sticky::LockedAgain), Vec::new()),
                (Some(Sticky::Down { chorded: true }), false) => (None, pass),
                (Some(Sticky::Down { chorded: false }), false) => (Some(Sticky::Latched), Vec::new()),
                (Some(Sticky::LatchedAgain), false) => (Some(Sticky::Locked), Vec::new()),
                (Some(Sticky::LockedAgain), false) => (None, pass),
                // A repeat, or a release of a press made before sticky keys came on.
                (state, _) => (state, if state.is_none() { pass } else { Vec::new() }),
            };
            match next {
                Some(next) => self.modifiers.insert(code, next),
                None => self.modifiers.remove(&code),
            };
            return keys;
        }
        if pressed {
            for state in self.modifiers.values_mut() {
                if let Sticky::Down { chorded } = state {
                    *chorded = true;
                }
            }
            if self.modifiers.values().any(|s| *s == Sticky::Latched) {
                self.using_latched.insert(code);
            }
            return pass;
        }
        let mut keys = pass;
        if self.using_latched.remove(&code) {
            keys.extend(self.release_held(|s| s == Sticky::Latched));
        }
        keys
    }

    /// Lets go of the modifiers sticky keys holds that WHICH picks.
    fn release_held(&mut self, which: impl Fn(Sticky) -> bool) -> Vec<KeyAction> {
        let mut codes: Vec<u32> = self
            .modifiers
            .iter()
            .filter(|(_, s)| !matches!(s, Sticky::Down { .. }) && which(**s))
            .map(|(code, _)| *code)
            .collect();
        codes.sort();
        for code in &codes {
            self.modifiers.remove(code);
        }
        codes.into_iter().map(|code| KeyAction { code, pressed: false }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHIFT: u32 = 50;
    const A: u32 = 38;

    fn keys(outcome: Outcome) -> Vec<(u32, bool)> {
        outcome.keys.into_iter().map(|k| (k.code, k.pressed)).collect()
    }

    #[test]
    fn a_tapped_modifier_holds_for_the_next_key() {
        let mut k = Keys::default();
        k.configure(true, 0, 0);
        assert_eq!(keys(k.key(SHIFT, true, 0)), [(SHIFT, true)]);
        assert_eq!(keys(k.key(SHIFT, false, 10)), []);
        assert_eq!(keys(k.key(A, true, 20)), [(A, true)]);
        assert_eq!(keys(k.key(A, false, 30)), [(A, false), (SHIFT, false)]);
        // It's gone now.
        assert_eq!(keys(k.key(A, true, 40)), [(A, true)]);
        assert_eq!(keys(k.key(A, false, 50)), [(A, false)]);
    }

    #[test]
    fn a_modifier_tapped_twice_locks_until_tapped_again() {
        let mut k = Keys::default();
        k.configure(true, 0, 0);
        k.key(SHIFT, true, 0);
        k.key(SHIFT, false, 10);
        assert_eq!(keys(k.key(SHIFT, true, 20)), []);
        assert_eq!(keys(k.key(SHIFT, false, 30)), []);
        k.key(A, true, 40);
        assert_eq!(keys(k.key(A, false, 50)), [(A, false)]);
        assert_eq!(keys(k.key(SHIFT, true, 60)), []);
        assert_eq!(keys(k.key(SHIFT, false, 70)), [(SHIFT, false)]);
    }

    #[test]
    fn a_chord_is_as_ever() {
        let mut k = Keys::default();
        k.configure(true, 0, 0);
        k.key(SHIFT, true, 0);
        k.key(A, true, 10);
        k.key(A, false, 20);
        assert_eq!(keys(k.key(SHIFT, false, 30)), [(SHIFT, false)]);
    }

    #[test]
    fn turning_sticky_keys_off_lets_go() {
        let mut k = Keys::default();
        k.configure(true, 0, 0);
        k.key(SHIFT, true, 0);
        k.key(SHIFT, false, 10);
        assert_eq!(k.configure(false, 0, 0), [KeyAction { code: SHIFT, pressed: false }]);
    }

    #[test]
    fn bounce_keys_leaves_out_a_quick_second_press() {
        let mut k = Keys::default();
        k.configure(false, 0, 300);
        assert_eq!(keys(k.key(A, true, 0)), [(A, true)]);
        assert_eq!(keys(k.key(A, false, 50)), [(A, false)]);
        assert_eq!(keys(k.key(A, true, 100)), []);
        assert_eq!(keys(k.key(A, false, 120)), []);
        assert_eq!(keys(k.key(A, true, 500)), [(A, true)]);
    }

    #[test]
    fn slow_keys_waits_for_a_held_key() {
        let mut k = Keys::default();
        k.configure(false, 300, 0);
        assert_eq!(k.key(A, true, 0), Outcome { keys: Vec::new(), wait: Some((A, 300)) });
        assert_eq!(keys(k.key(A, false, 100)), []);
        assert_eq!(k.slow_key_held(A), []);
        k.key(A, true, 200);
        assert_eq!(k.slow_key_held(A), [KeyAction { code: A, pressed: true }]);
        assert_eq!(keys(k.key(A, false, 600)), [(A, false)]);
    }
}
