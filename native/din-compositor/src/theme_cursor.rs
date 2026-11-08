//! Telling the pointer theme's own images apart from an app's.
//!
//! Apps that draw their cursor themselves (X apps, by way of Xwayland, and
//! Wayland apps without cursor-shape) mostly draw the theme Din uses, and an
//! animated theme's frames one after another. Din would show each as an
//! image cursor, and Chromium, which animates the theme's cursors itself on
//! Din's own window, never stops that animation when an image cursor
//! replaces one (WaylandCursor::UpdateBitmap leaves its timer running): the
//! app's frames and Chromium's took turns, and the pointer flickered, its
//! animation seeming to start over and over. An image that's one of the
//! theme's goes to Din by its CSS name instead, so Din shows the cursor as
//! its own, animated once.

use std::{
    collections::{HashMap, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
    path::PathBuf,
    str::FromStr,
};

use smithay::input::pointer::CursorIcon;
use xcursor::{CursorTheme, parser::parse_xcursor};

use crate::canvas::straight_rgba;

/// The CSS cursors Din's canvases can show by name, commonest first: an
/// image two of them share (a theme's links) goes by the first.
const NAMES: &[&str] = &[
    "default", "text", "pointer", "wait", "progress", "help", "crosshair", "move", "grab", "grabbing",
    "not-allowed", "no-drop", "copy", "alias", "context-menu", "cell", "vertical-text", "all-scroll",
    "col-resize", "row-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "e-resize",
    "n-resize", "ne-resize", "nw-resize", "s-resize", "se-resize", "sw-resize", "w-resize", "zoom-in",
    "zoom-out",
];

pub struct ThemeCursors {
    /// The theme the images are from.
    theme: Option<String>,
    /// Every frame of every cursor in it, at every size, hashed, to its CSS name.
    images: HashMap<u64, &'static str>,
}

impl ThemeCursors {
    pub fn new() -> Self {
        Self { theme: None, images: HashMap::new() }
    }

    /// The CSS name of the theme's cursor an image (straight RGBA) is a frame of, if it's one.
    pub fn name(&mut self, width: i32, height: i32, xhot: i32, yhot: i32, rgba: &[u8]) -> Option<&'static str> {
        let theme = current_theme()?;
        if self.theme.as_deref() != Some(theme.as_str()) {
            self.images = load(&theme);
            self.theme = Some(theme);
        }
        self.images.get(&key(width, height, xhot, yhot, rgba)).copied()
    }
}

fn key(width: i32, height: i32, xhot: i32, yhot: i32, rgba: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    (width, height, xhot, yhot).hash(&mut hasher);
    rgba.hash(&mut hasher);
    hasher.finish()
}

/// The theme Din has now: what it last told din-shell (electron/cursor.mts),
/// or, outside DinOS, what it started this compositor with.
fn current_theme() -> Option<String> {
    let file = std::env::var_os("XDG_RUNTIME_DIR").map(|dir| PathBuf::from(dir).join("din-shell-pointer"));
    let told = file.and_then(|file| std::fs::read_to_string(file).ok()).and_then(|text| {
        text.lines().find_map(|line| line.strip_prefix("theme=").filter(|v| !v.is_empty()).map(String::from))
    });
    told.or_else(|| std::env::var("XCURSOR_THEME").ok().filter(|v| !v.is_empty()))
}

fn load(theme_name: &str) -> HashMap<u64, &'static str> {
    let theme = CursorTheme::load(theme_name);
    let mut images = HashMap::new();
    for &css in NAMES {
        let Ok(icon) = CursorIcon::from_str(css) else { continue };
        let Some(path) = std::iter::once(icon.name()).chain(icon.alt_names().iter().copied()).find_map(|n| theme.load_icon(n))
        else {
            continue;
        };
        let Some(frames) = std::fs::read(path).ok().and_then(|data| parse_xcursor(&data)) else { continue };
        for frame in frames {
            // The file's pixels are little-endian premultiplied ARGB words,
            // as pixman's are; converted the way the canvas converts those.
            let rgba: Vec<u8> = frame
                .pixels_rgba
                .chunks_exact(4)
                .flat_map(|p| straight_rgba(u32::from_le_bytes([p[0], p[1], p[2], p[3]])))
                .collect();
            let k = key(frame.width as i32, frame.height as i32, frame.xhot as i32, frame.yhot as i32, &rgba);
            images.entry(k).or_insert(css);
        }
    }
    tracing::info!("pointer theme {theme_name}: {} images known", images.len());
    images
}
