//! Settings → Accessibility, din-shell's part: what has to happen to the
//! whole screen and every keyboard, Linux apps' included. Din says the
//! settings in $XDG_RUNTIME_DIR/din-shell-accessibility
//! (electron/accessibility.mts), which is watched with the pointer's
//! (cursor.rs).
//!
//! - Zoom: Super+Alt+8 zooms the display the pointer's on in or out again,
//!   and Super+Alt+= and Super+Alt+- zoom further in or out, as on a Mac.
//!   The screen's magnified about the pointer (render.rs), so moving it to
//!   an edge brings that edge into view.
//! - Colour filters: inverted colours, greyscale, and corrections for the
//!   three kinds of colour blindness. The display hardware does them, on
//!   the way out to the screen, so they cost nothing per frame and never
//!   reach screenshots: greyscale and the corrections as the CRTC's colour
//!   matrix (CTM), inversion through its gamma table, under night light's.
//! - Sticky, slow and bounce keys (keys.rs).

use smithay::input::keyboard::{Keysym, ModifiersState};
use tracing::info;

use super::{keys, state::State};

/// The file Din tells the settings in, in XDG_RUNTIME_DIR.
pub const SETTINGS_FILE: &str = "din-shell-accessibility";

/// The most the screen's magnified, and how much each key press changes it by.
const MAX_ZOOM: f64 = 16.0;
const ZOOM_STEP: f64 = 1.25;
/// What Super+Alt+8 zooms to the first time.
const DEFAULT_ZOOM: f64 = 2.0;

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub enum Filter {
    #[default]
    None,
    Invert,
    Grayscale,
    /// Corrections for red-weak (protanopia), green-weak (deuteranopia) and
    /// blue-yellow (tritanopia) colour blindness.
    Protanopia,
    Deuteranopia,
    Tritanopia,
}

impl Filter {
    fn parse(value: &str) -> Filter {
        match value {
            "invert" => Filter::Invert,
            "grayscale" => Filter::Grayscale,
            "protanopia" => Filter::Protanopia,
            "deuteranopia" => Filter::Deuteranopia,
            "tritanopia" => Filter::Tritanopia,
            _ => Filter::None,
        }
    }

    /// The colour matrix it is, row by row, for RGB columns; None for none.
    pub fn matrix(self) -> Option<[f64; 9]> {
        match self {
            Filter::None | Filter::Invert => None,
            Filter::Grayscale => {
                let luma = [0.2126, 0.7152, 0.0722];
                Some([luma[0], luma[1], luma[2], luma[0], luma[1], luma[2], luma[0], luma[1], luma[2]])
            }
            Filter::Protanopia => Some(daltonize(&PROTANOPIA, &RED_GREEN_SHIFT)),
            Filter::Deuteranopia => Some(daltonize(&DEUTERANOPIA, &RED_GREEN_SHIFT)),
            Filter::Tritanopia => Some(daltonize(&TRITANOPIA, &BLUE_YELLOW_SHIFT)),
        }
    }

    pub fn inverts(self) -> bool {
        self == Filter::Invert
    }
}

// How each kind of colour blindness sees, at its strongest (Machado,
// Oliveira and Fernandes, 2009).
const PROTANOPIA: [f64; 9] = [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998];
const DEUTERANOPIA: [f64; 9] = [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881];
const TRITANOPIA: [f64; 9] = [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900];
// Where the colours that can't be told apart go instead: the red-green
// difference into the green and blue that can still be seen, and the
// blue-yellow one into red and green.
const RED_GREEN_SHIFT: [f64; 9] = [0.0, 0.0, 0.0, 0.7, 1.0, 0.0, 0.7, 0.0, 1.0];
const BLUE_YELLOW_SHIFT: [f64; 9] = [1.0, 0.0, 0.7, 0.0, 1.0, 0.7, 0.0, 0.0, 0.0];

/// The correction for a colour blindness seen as SIMULATED: the colour plus
/// what's lost (it less how it's seen), shifted to where it can be seen.
fn daltonize(simulated: &[f64; 9], shift: &[f64; 9]) -> [f64; 9] {
    let identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let lost: Vec<f64> = identity.iter().zip(simulated).map(|(i, s)| i - s).collect();
    let mut out = identity;
    for row in 0..3 {
        for col in 0..3 {
            out[row * 3 + col] += (0..3).map(|k| shift[row * 3 + k] * lost[k * 3 + col]).sum::<f64>();
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Settings {
    pub zoom_keys: bool,
    pub filter: Filter,
    pub sticky_keys: bool,
    /// How long a key must be held to count, in ms; 0 for any press.
    pub slow_keys: u32,
    /// How long after a key comes up that pressing it again doesn't count, in ms.
    pub bounce_keys: u32,
}

impl Settings {
    fn parse(text: &str) -> Settings {
        let mut settings = Settings::default();
        for line in text.lines() {
            match line.split_once('=') {
                Some(("zoom-keys", value)) => settings.zoom_keys = value == "1",
                Some(("filter", value)) => settings.filter = Filter::parse(value),
                Some(("sticky-keys", value)) => settings.sticky_keys = value == "1",
                Some(("slow-keys", value)) => settings.slow_keys = value.parse().unwrap_or(0).min(2000),
                Some(("bounce-keys", value)) => settings.bounce_keys = value.parse().unwrap_or(0).min(2000),
                _ => {}
            }
        }
        settings
    }
}

#[derive(Default)]
pub struct Accessibility {
    pub settings: Settings,
    /// How many times the screen's magnified now; 1 isn't.
    pub zoom: f64,
    /// What Super+Alt+8 zooms back to.
    last_zoom: f64,
    pub keys: keys::Keys,
}

/// What a zoom key does.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ZoomKey {
    Toggle,
    In,
    Out,
}

/// The zoom key KEYSYM is with MODIFIERS held, if it's one.
pub fn zoom_key(modifiers: &ModifiersState, keysym: Keysym) -> Option<ZoomKey> {
    if !modifiers.logo || !modifiers.alt || modifiers.ctrl {
        return None;
    }
    match keysym {
        Keysym::_8 | Keysym::KP_8 | Keysym::asterisk => Some(ZoomKey::Toggle),
        Keysym::equal | Keysym::plus | Keysym::KP_Add => Some(ZoomKey::In),
        Keysym::minus | Keysym::underscore | Keysym::KP_Subtract => Some(ZoomKey::Out),
        _ => None,
    }
}

impl Accessibility {
    /// The zoom after KEY, from ZOOM (1 for none), and what Toggle goes back to.
    fn zoomed(&mut self, key: ZoomKey) {
        let zoom = self.zoom.max(1.0);
        let next = match key {
            ZoomKey::Toggle if zoom > 1.001 => 1.0,
            ZoomKey::Toggle => if self.last_zoom > 1.001 { self.last_zoom } else { DEFAULT_ZOOM },
            ZoomKey::In => (zoom * ZOOM_STEP).min(MAX_ZOOM),
            ZoomKey::Out => {
                let out = zoom / ZOOM_STEP;
                if out < 1.05 { 1.0 } else { out }
            }
        };
        if next > 1.001 {
            self.last_zoom = next;
        }
        self.zoom = next;
    }
}

impl State {
    /// Takes the accessibility settings from FILE.
    pub fn read_accessibility_settings(&mut self, file: &std::path::Path) {
        let settings = std::fs::read_to_string(file).map(|t| Settings::parse(&t)).unwrap_or_default();
        if settings == self.accessibility.settings {
            return;
        }
        info!("accessibility: {settings:?}");
        let filter_changed = settings.filter != self.accessibility.settings.filter;
        self.accessibility.settings = settings;
        // Modifiers sticky keys was holding go back up as it goes off.
        let released = self.accessibility.keys.configure(settings.sticky_keys, settings.slow_keys, settings.bounce_keys);
        let now = std::time::Duration::from(self.clock.now()).as_millis() as u32;
        self.deliver_keys(&released, now);
        if !settings.zoom_keys && self.accessibility.zoom > 1.0 {
            self.accessibility.zoom = 1.0;
            self.queue_redraw_all();
        }
        if filter_changed {
            self.apply_color_filter();
        }
    }

    /// Zooms as KEY says, and draws the display the pointer's on again.
    pub fn zoom_by(&mut self, key: ZoomKey) {
        self.accessibility.zoomed(key);
        info!("zoom: {:.2}", self.accessibility.zoom);
        self.queue_redraw_all();
    }

    /// Puts the colour filter on every display, or takes it off.
    pub fn apply_color_filter(&mut self) {
        let filter = self.accessibility.settings.filter;
        self.backend.invert = filter.inverts();
        let ids: Vec<u64> = self.backend.heads.iter().filter(|h| h.enabled()).map(|h| h.id).collect();
        for id in ids {
            self.apply_color_filter_to(id);
        }
    }

    /// The colour filter on display ID, after it's lit or the GPU's back.
    pub fn apply_color_filter_to(&mut self, id: u64) {
        let matrix = self.accessibility.settings.filter.matrix();
        if let Err(err) = self.backend.set_ctm(id, matrix)
            && matrix.is_some()
        {
            tracing::warn!("colour filter: {err}");
        }
        let gamma = self.backend.head(id).and_then(|h| h.gamma.clone());
        let _ = self.backend.set_gamma(id, gamma.as_deref());
    }
}
