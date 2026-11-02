//! The pointer's images, for when no client has set one, and for Shake to
//! find the pointer (shake.rs): the XCursor theme and size, from
//! XCURSOR_THEME and XCURSOR_SIZE at first (which DinOS's launcher reads from
//! the GSettings Din's Settings writes), then from what Din says in
//! $XDG_RUNTIME_DIR/din-shell-pointer (electron/cursor.mts), which is
//! watched. Din's own pointer is a surface Chromium draws from the same
//! theme, so it follows theme changes live.

use std::{
    collections::HashMap,
    ffi::CString,
    os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd},
    path::PathBuf,
};

use smithay::{
    backend::{allocator::Fourcc, renderer::element::memory::MemoryRenderBuffer},
    input::pointer::CursorIcon,
    reexports::calloop::{Interest, LoopHandle, Mode, PostAction, generic::Generic},
    utils::{Physical, Point, Transform},
};
use tracing::{info, warn};
use xcursor::{CursorTheme, parser::parse_xcursor};

use super::{accessibility, mouse, state::State};

/// The file Din tells the pointer's settings in, in XDG_RUNTIME_DIR.
const SETTINGS_FILE: &str = "din-shell-pointer";

/// An image at a given pixel size, with its hotspot in its own pixels.
#[derive(Clone)]
pub struct Image {
    pub buffer: MemoryRenderBuffer,
    pub hotspot: Point<i32, Physical>,
    pub width: i32,
    pub height: i32,
    /// The size the theme made it for, in pixels.
    pub nominal: u32,
}

pub struct Cursors {
    name: String,
    theme: CursorTheme,
    /// The nominal size, in logical pixels.
    pub size: u32,
    cache: HashMap<(CursorIcon, u32), Option<Image>>,
    /// The arrow at every size the theme has it, smallest first, for drawing it big.
    arrows: Option<Vec<Image>>,
}

impl Cursors {
    pub fn load() -> Cursors {
        let name = std::env::var("XCURSOR_THEME").unwrap_or_else(|_| "default".into());
        let size = std::env::var("XCURSOR_SIZE").ok().and_then(|s| s.parse().ok()).filter(|&s| s > 0).unwrap_or(24);
        Cursors { theme: CursorTheme::load(&name), name, size, cache: HashMap::new(), arrows: None }
    }

    /// Switches to theme NAME at SIZE, if that's a change.
    fn set(&mut self, name: &str, size: u32) {
        if name == self.name && size == self.size {
            return;
        }
        info!("pointer: {name} at {size}");
        self.theme = CursorTheme::load(name);
        self.name = name.to_string();
        self.size = size;
        self.cache.clear();
        self.arrows = None;
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

    /// The arrow for drawing PX pixels big: the theme's smallest image at
    /// least that big, so it's only ever drawn smaller, or else its biggest.
    pub fn arrow(&mut self, px: f64) -> Option<Image> {
        let arrows = self.arrows();
        arrows.iter().find(|i| i.nominal as f64 >= px).or(arrows.last()).cloned()
    }

    /// The size the arrow's drawn at normally on an output at SCALE: the
    /// theme's nearest to the size asked for, as clients and get() choose.
    pub fn arrow_size(&mut self, scale: f64) -> f64 {
        let px = self.size as f64 * scale;
        self.arrows()
            .iter()
            .map(|i| i.nominal as f64)
            .min_by(|a, b| (a - px).abs().total_cmp(&(b - px).abs()))
            .unwrap_or(px)
    }

    fn arrows(&mut self) -> &[Image] {
        if self.arrows.is_none() {
            let arrows = std::iter::once(CursorIcon::Default.name())
                .chain(CursorIcon::Default.alt_names().iter().copied())
                .find_map(|name| self.load_all(name))
                .unwrap_or_default();
            self.arrows = Some(arrows);
        }
        self.arrows.as_deref().unwrap_or_default()
    }

    fn load_image(&self, name: &str, px: u32) -> Option<Image> {
        let path = self.theme.load_icon(name)?;
        let data = std::fs::read(path).ok()?;
        let images = parse_xcursor(&data)?;
        // The size nearest the one wanted; animated cursors show their first frame.
        let image = images.iter().min_by_key(|i| (i.size as i64 - px as i64).abs())?;
        Some(to_image(image))
    }

    /// The first frame at each size of the cursor NAME, smallest first.
    fn load_all(&self, name: &str) -> Option<Vec<Image>> {
        let path = self.theme.load_icon(name)?;
        let data = std::fs::read(path).ok()?;
        let mut images = parse_xcursor(&data)?;
        images.sort_by_key(|i| i.size);
        images.dedup_by_key(|i| i.size);
        let images: Vec<Image> = images.iter().map(to_image).collect();
        (!images.is_empty()).then_some(images)
    }
}

fn to_image(image: &xcursor::parser::Image) -> Image {
    // In the file's byte order: little-endian ARGB words.
    let buffer = MemoryRenderBuffer::from_slice(
        &image.pixels_rgba,
        Fourcc::Argb8888,
        (image.width as i32, image.height as i32),
        1,
        Transform::Normal,
        None,
    );
    Image {
        buffer,
        hotspot: (image.xhot as i32, image.yhot as i32).into(),
        width: image.width as i32,
        height: image.height as i32,
        nominal: image.size,
    }
}

/// Reads what Din says about the pointer, the mouse (mouse.rs) and
/// accessibility (accessibility.rs) now, and
/// again each time it says something new.
pub fn watch_settings(handle: &LoopHandle<'static, State>, state: &mut State) {
    let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) else { return };
    state.read_pointer_settings(&dir.join(SETTINGS_FILE));
    state.read_mouse_settings(&dir.join(mouse::SETTINGS_FILE));
    state.read_accessibility_settings(&dir.join(accessibility::SETTINGS_FILE));
    let Ok(cdir) = CString::new(dir.as_os_str().as_encoded_bytes()) else { return };
    // SAFETY: plain syscalls; the fd is owned from here on.
    let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
    if fd < 0 {
        warn!("watching the pointer's settings: {}", std::io::Error::last_os_error());
        return;
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    // Din writes the file elsewhere and renames it into place.
    if unsafe { libc::inotify_add_watch(fd.as_raw_fd(), cdir.as_ptr(), libc::IN_MOVED_TO | libc::IN_CLOSE_WRITE) } < 0 {
        warn!("watching the pointer's settings: {}", std::io::Error::last_os_error());
        return;
    }
    let inserted = handle.insert_source(Generic::new(fd, Interest::READ, Mode::Level), move |_, fd, state| {
        let mut buf = [0u8; 4096];
        let mut changed = false;
        let mut mouse_changed = false;
        let mut accessibility_changed = false;
        loop {
            // SAFETY: reading into a buffer of the size given.
            let n = unsafe { libc::read(fd.as_fd().as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
            if n <= 0 {
                break;
            }
            let mut at = 0;
            let header = std::mem::size_of::<libc::inotify_event>();
            while at + header <= n as usize {
                let len = u32::from_ne_bytes(buf[at + 12..at + 16].try_into().unwrap()) as usize;
                let name = &buf[at + header..(at + header + len).min(n as usize)];
                let name = name.split(|&b| b == 0).next().unwrap_or_default();
                changed |= name == SETTINGS_FILE.as_bytes();
                mouse_changed |= name == mouse::SETTINGS_FILE.as_bytes();
                accessibility_changed |= name == accessibility::SETTINGS_FILE.as_bytes();
                at += header + len;
            }
        }
        if changed {
            state.read_pointer_settings(&dir.join(SETTINGS_FILE));
        }
        if mouse_changed {
            state.read_mouse_settings(&dir.join(mouse::SETTINGS_FILE));
        }
        if accessibility_changed {
            state.read_accessibility_settings(&dir.join(accessibility::SETTINGS_FILE));
        }
        Ok(PostAction::Continue)
    });
    if let Err(err) = inserted {
        warn!("watching the pointer's settings: {err}");
    }
}

impl State {
    /// Takes the pointer's theme, size and Shake to find the pointer from FILE.
    fn read_pointer_settings(&mut self, file: &std::path::Path) {
        let Ok(text) = std::fs::read_to_string(file) else { return };
        let mut name = self.cursor.name.clone();
        let mut size = self.cursor.size;
        let mut shake = false;
        for line in text.lines() {
            match line.split_once('=') {
                Some(("theme", value)) if !value.is_empty() => name = value.to_string(),
                Some(("size", value)) => size = value.parse().ok().filter(|&s| s > 0).unwrap_or(size),
                Some(("shake-to-find", value)) => shake = value == "1",
                _ => {}
            }
        }
        self.cursor.set(&name, size);
        self.shake.set_enabled(shake);
        self.queue_redraw_pointer();
    }
}
