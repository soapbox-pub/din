//! The keyboard's layouts, Settings → Keyboard's: up to four of them as
//! XKB groups of the one keymap, and which of them is typing. Din says both
//! in $XDG_RUNTIME_DIR/din-shell-keyboard (electron/keyboard.mts), watched
//! with the pointer's settings (cursor.rs):
//!
//! ```text
//! rules=
//! model=
//! layout=us,de
//! variant=,nodeadkeys
//! options=
//! group=1
//! ```
//!
//! A new keymap is compiled and sent to every client, Din and Xwayland
//! included, so adding a layout needs no restart; switching only moves the
//! keyboard to another group, which clients hear of with the modifiers. The
//! keymap the compositor starts with is the unit's XKB_DEFAULT_* (state.rs),
//! the same one Din writes, so the first read changes only the group.

use std::path::Path;

use smithay::input::keyboard::{Layout, XkbConfig};
use tracing::{info, warn};

use super::state::State;

/// The file Din tells the layouts in, in XDG_RUNTIME_DIR.
pub const SETTINGS_FILE: &str = "din-shell-keyboard";

/// Rules, model, layout, variant and options, as XKB_DEFAULT_* has them.
pub type Keymap = [String; 5];

/// The keymap in FILE's text, and the group to type with.
fn parse(text: &str) -> (Keymap, u32) {
    let mut keymap = Keymap::default();
    let mut group = 0;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim().to_string();
        match key {
            "rules" => keymap[0] = value,
            "model" => keymap[1] = value,
            "layout" => keymap[2] = value,
            "variant" => keymap[3] = value,
            "options" => keymap[4] = value,
            "group" => group = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    (keymap, group)
}

impl State {
    /// Takes the keymap and the layout typing from FILE.
    pub fn read_keyboard_settings(&mut self, file: &Path) {
        let Ok(text) = std::fs::read_to_string(file) else { return };
        let (keymap, group) = parse(&text);
        if keymap[2].is_empty() {
            return;
        }
        let Some(keyboard) = self.seat.get_keyboard() else { return };
        if keymap != self.keymap {
            let config = XkbConfig {
                rules: &keymap[0],
                model: &keymap[1],
                layout: &keymap[2],
                variant: &keymap[3],
                options: if keymap[4].is_empty() { None } else { Some(keymap[4].clone()) },
            };
            if let Err(err) = keyboard.set_xkb_config(self, config) {
                warn!("the keyboard layout {keymap:?}: {err:?}");
                return;
            }
            info!("keyboard layout: {keymap:?}");
            self.keymap = keymap;
        }
        keyboard.with_xkb_state(self, |mut context| {
            let count = context.xkb().lock().unwrap().layouts().count() as u32;
            let layout = Layout(if group < count { group } else { 0 });
            if context.xkb().lock().unwrap().active_layout() != layout {
                info!("keyboard layout: group {}", layout.0);
                context.set_layout(layout);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_keymap_and_group() {
        let (keymap, group) = parse("rules=\nlayout=us,de\nvariant=,nodeadkeys\noptions=caps:none\ngroup=1\n");
        assert_eq!(keymap, ["", "", "us,de", ",nodeadkeys", "caps:none"].map(String::from));
        assert_eq!(group, 1);
    }

    #[test]
    fn a_bad_group_is_the_first() {
        assert_eq!(parse("layout=us\ngroup=x\n").1, 0);
    }
}
