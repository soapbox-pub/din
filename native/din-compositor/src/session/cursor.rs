//! The pointer's images, for when no client has set one: the XCursor theme
//! and size from XCURSOR_THEME and XCURSOR_SIZE (which DinOS's launcher reads
//! from the GSettings Din's Settings writes). Din's own pointer is a surface
//! Chromium draws from the same theme, so it follows theme changes live.

use std::collections::HashMap;

use smithay::{
    backend::{allocator::Fourcc, renderer::element::memory::MemoryRenderBuffer},
    input::pointer::CursorIcon,
    utils::{Physical, Point, Transform},
};
use tracing::warn;
use xcursor::{CursorTheme, parser::parse_xcursor};

/// An image at a given pixel size, with its hotspot in its own pixels.
#[derive(Clone)]
pub struct Image {
    pub buffer: MemoryRenderBuffer,
    pub hotspot: Point<i32, Physical>,
    pub width: i32,
    pub height: i32,
}

pub struct Cursors {
    theme: CursorTheme,
    /// The nominal size, in logical pixels.
    pub size: u32,
    cache: HashMap<(CursorIcon, u32), Option<Image>>,
}

impl Cursors {
    pub fn load() -> Cursors {
        let name = std::env::var("XCURSOR_THEME").unwrap_or_else(|_| "default".into());
        let size = std::env::var("XCURSOR_SIZE").ok().and_then(|s| s.parse().ok()).filter(|&s| s > 0).unwrap_or(24);
        Cursors { theme: CursorTheme::load(&name), size, cache: HashMap::new() }
    }

    /// ICON for an output at SCALE; the theme's default where it lacks ICON.
    pub fn get(&mut self, icon: CursorIcon, scale: f64) -> Option<Image> {
        let px = (self.size as f64 * scale).round() as u32;
        if let Some(image) = self.cache.get(&(icon, px)) {
            return image.clone();
        }
        let image = std::iter::once(icon.name())
            .chain(icon.alt_names().iter().copied())
            .find_map(|name| self.load_image(name, px))
            .or_else(|| (icon != CursorIcon::Default).then(|| self.get(CursorIcon::Default, scale)).flatten());
        if image.is_none() && icon == CursorIcon::Default {
            warn!("the cursor theme has no default pointer");
        }
        self.cache.insert((icon, px), image.clone());
        image
    }

    fn load_image(&self, name: &str, px: u32) -> Option<Image> {
        let path = self.theme.load_icon(name)?;
        let data = std::fs::read(path).ok()?;
        let images = parse_xcursor(&data)?;
        // The size nearest the one wanted; animated cursors show their first frame.
        let image = images.iter().min_by_key(|i| (i.size as i64 - px as i64).abs())?;
        // In the file's byte order: little-endian ARGB words.
        let buffer = MemoryRenderBuffer::from_slice(
            &image.pixels_rgba,
            Fourcc::Argb8888,
            (image.width as i32, image.height as i32),
            1,
            Transform::Normal,
            None,
        );
        Some(Image {
            buffer,
            hotspot: (image.xhot as i32, image.yhot as i32).into(),
            width: image.width as i32,
            height: image.height as i32,
        })
    }
}
