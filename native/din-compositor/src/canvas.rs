//! An offscreen render target for one surface tree: a toplevel, a popup, or
//! the cursor.
//!
//! Each canvas is a pixman image sized to the surface's window geometry at
//! the scale it's drawn at (the shell's pixels per CSS pixel, for an app
//! that draws at it), plus a damage tracker. Rendering composites the whole tree (subsurfaces
//! included) and reports which rectangles actually changed, so only those
//! pixels travel to the shell.

use smithay::{
    backend::{
        allocator::Fourcc,
        renderer::{
            Bind, Offscreen,
            damage::OutputDamageTracker,
            element::{
                Kind,
                surface::{WaylandSurfaceRenderElement, render_elements_from_surface_tree},
            },
            pixman::PixmanRenderer,
        },
    },
    reexports::{pixman::Image, wayland_server::protocol::wl_surface::WlSurface},
    utils::{Physical, Point, Rectangle, Size, Transform},
};

/// One changed rectangle, as straight RGBA bytes.
pub struct Patch {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub rgba: Vec<u8>,
}

pub struct Canvas {
    image: Image<'static, 'static>,
    tracker: OutputDamageTracker,
    size: Size<i32, Physical>,
    scale: f64,
    /// Whether `image` still holds the previous frame (age 1) or is fresh.
    primed: bool,
}

impl Canvas {
    pub fn new(renderer: &mut PixmanRenderer, size: Size<i32, Physical>, scale: f64) -> Option<Self> {
        if size.w <= 0 || size.h <= 0 {
            return None;
        }
        let image = renderer
            .create_buffer(Fourcc::Argb8888, (size.w, size.h).into())
            .ok()?;
        Some(Self {
            image,
            tracker: OutputDamageTracker::new(size, scale, Transform::Normal),
            size,
            scale,
            primed: false,
        })
    }

    pub fn size(&self) -> Size<i32, Physical> {
        self.size
    }

    pub fn scale(&self) -> f64 {
        self.scale
    }

    /// Composite `surface`'s tree at the canvas's scale, offset so that
    /// `origin` (the window geometry's corner, in surface coordinates
    /// scaled) lands at the canvas's top-left. Returns the changed
    /// rectangles, or an empty list.
    pub fn render(
        &mut self,
        renderer: &mut PixmanRenderer,
        surface: &WlSurface,
        origin: Point<i32, Physical>,
    ) -> Vec<Patch> {
        let elements: Vec<WaylandSurfaceRenderElement<PixmanRenderer>> =
            render_elements_from_surface_tree(
                renderer,
                surface,
                (-origin.x, -origin.y),
                self.scale,
                1.0,
                Kind::Unspecified,
            );
        let age = if self.primed { 1 } else { 0 };
        let damage: Vec<Rectangle<i32, Physical>> = {
            let Ok(mut target) = renderer.bind(&mut self.image) else {
                return Vec::new();
            };
            match self
                .tracker
                .render_output(renderer, &mut target, age, &elements, [0.0, 0.0, 0.0, 0.0])
            {
                Ok(result) => result.damage.cloned().unwrap_or_default(),
                Err(_) => return Vec::new(),
            }
        };
        self.primed = true;
        damage
            .into_iter()
            .filter_map(|rect| rect.intersection(Rectangle::from_size(self.size)))
            .filter(|rect| rect.size.w > 0 && rect.size.h > 0)
            .map(|rect| self.extract(rect))
            .collect()
    }

    /// Copy one rectangle out, converting pixman's native ARGB words (BGRA
    /// bytes, premultiplied) to the straight RGBA that ImageData expects.
    fn extract(&self, rect: Rectangle<i32, Physical>) -> Patch {
        let stride = self.image.stride() / 4;
        // SAFETY: the image is size.w x size.h 32-bit pixels with `stride`
        // words per row, and `rect` was clipped to it above. Rendering is
        // synchronous in pixman, so nothing writes while this reads.
        let pixels = unsafe {
            std::slice::from_raw_parts(self.image.data() as *const u32, stride * self.size.h as usize)
        };
        let (w, h) = (rect.size.w as usize, rect.size.h as usize);
        let mut rgba = vec![0u8; w * h * 4];
        for (row, out) in rgba.chunks_exact_mut(w * 4).enumerate() {
            let start = (rect.loc.y as usize + row) * stride + rect.loc.x as usize;
            for (&p, px) in pixels[start..start + w].iter().zip(out.chunks_exact_mut(4)) {
                let a = p >> 24;
                // Opaque is the overwhelming case: a pure byte swizzle.
                let p = if a == 255 || a == 0 {
                    p
                } else {
                    let un = |c: u32| ((c & 0xff) * 255 / a).min(255);
                    (a << 24) | (un(p >> 16) << 16) | (un(p >> 8) << 8) | un(p)
                };
                px.copy_from_slice(&(((p & 0xff00ff00) | ((p >> 16) & 0xff) | ((p & 0xff) << 16)).to_le_bytes()));
            }
        }
        Patch { x: rect.loc.x, y: rect.loc.y, width: rect.size.w, height: rect.size.h, rgba }
    }
}
