//! What's drawn on a display: Din's window with its popups, a drag's icon and
//! the pointer, as render elements for any rectangle of the layout (a
//! display, or the part of one a screenshot asks for), magnified about the
//! pointer while the screen is zoomed (accessibility.rs).

use smithay::{
    backend::renderer::{
        element::{
            Kind,
            memory::MemoryRenderBufferRenderElement,
            render_elements,
            surface::{WaylandSurfaceRenderElement, render_elements_from_surface_tree},
            texture::{TextureBuffer, TextureRenderElement},
            utils::RescaleRenderElement,
        },
        gles::{GlesRenderer, GlesTexture},
    },
    desktop::{Space, Window},
    input::pointer::{CursorImageStatus, CursorImageSurfaceData},
    utils::{Logical, Point, Rectangle, Scale},
    wayland::compositor::with_states,
};

use super::{cursor::Cursors, state::DndIcon};

/// The boot screen's background, under everything, so the screen goes from
/// the boot screen to Din without a black frame between.
pub const BACKDROP: [f32; 4] = [0.043, 0.059, 0.078, 1.0];

render_elements! {
    pub SceneElement<=GlesRenderer>;
    Surface=WaylandSurfaceRenderElement<GlesRenderer>,
    Memory=MemoryRenderBufferRenderElement<GlesRenderer>,
    Texture=TextureRenderElement<GlesTexture>,
}

render_elements! {
    pub OutputElement<=GlesRenderer>;
    Scene=SceneElement,
    Zoomed=RescaleRenderElement<SceneElement>,
}

/// What a frame is drawn from.
pub struct Scene<'a> {
    pub space: &'a Space<Window>,
    /// Where the pointer is, if it's drawn at all.
    pub pointer: Option<Point<f64, Logical>>,
    pub cursor_status: &'a CursorImageStatus,
    pub cursors: &'a mut Cursors,
    /// How many times its size the pointer's drawn: past 1, Shake to find
    /// the pointer draws the theme's arrow that big in place of any other.
    pub magnify: f64,
    pub dnd_icon: Option<&'a DndIcon>,
    /// How many times the screen's magnified about the pointer; 1 isn't.
    pub zoom: f64,
    /// A full-screen game's frame over Din's window, and where (direct.rs).
    pub direct: Option<(&'a TextureBuffer<GlesTexture>, Rectangle<i32, Logical>)>,
}

/// The elements for AREA of the layout at SCALE, front to back, positioned
/// relative to AREA's top-left.
pub fn elements(
    scene: &mut Scene,
    renderer: &mut GlesRenderer,
    area: Rectangle<i32, Logical>,
    scale: f64,
    with_pointer: bool,
) -> Vec<OutputElement> {
    let scale_xy = Scale::from(scale);
    let origin = area.loc;
    let mut elements: Vec<SceneElement> = Vec::new();

    if let Some(pointer) = scene.pointer.filter(|p| with_pointer && area.to_f64().contains(*p)) {
        let at = pointer - origin.to_f64();
        if let Some(icon) = scene.dnd_icon {
            let location = (at + icon.offset.to_f64()).to_physical(scale_xy).to_i32_round();
            elements.extend(render_elements_from_surface_tree(
                renderer,
                &icon.surface,
                location,
                scale_xy,
                1.0,
                Kind::Unspecified,
            ));
        }
        let big = scene.magnify > 1.001 && !matches!(scene.cursor_status, CursorImageStatus::Hidden);
        match scene.cursor_status {
            _ if big => {
                // From the size the arrow's drawn at anyway, which with a theme
                // of few sizes can be well off the size asked for.
                let px = scene.cursors.arrow_size(scale) * scene.magnify;
                if let Some(image) = scene.cursors.arrow(px) {
                    // Physical pixels to each of the image's.
                    let k = px / image.nominal.max(1) as f64;
                    let location = at.to_physical(scale_xy) - image.hotspot.to_f64().upscale(k);
                    let size =
                        ((image.width as f64 * k / scale).round() as i32, (image.height as f64 * k / scale).round() as i32);
                    if let Ok(element) = MemoryRenderBufferRenderElement::from_buffer(
                        renderer,
                        location,
                        &image.buffer,
                        None,
                        // All of the image, however big it's drawn: without it,
                        // smithay takes as much of the image as it's drawn big.
                        Some(Rectangle::from_size((image.width as f64, image.height as f64).into())),
                        Some(size.into()),
                        Kind::Cursor,
                    ) {
                        elements.push(SceneElement::Memory(element));
                    }
                } else {
                    tracing::warn!("shake: the cursor theme has no arrow to draw big");
                }
            }
            CursorImageStatus::Hidden => {}
            CursorImageStatus::Surface(surface) => {
                let hotspot = with_states(surface, |states| {
                    states
                        .data_map
                        .get::<CursorImageSurfaceData>()
                        .map(|data| data.lock().unwrap().hotspot)
                        .unwrap_or_default()
                });
                let location = (at - hotspot.to_f64()).to_physical(scale_xy).to_i32_round();
                elements.extend(render_elements_from_surface_tree(
                    renderer,
                    surface,
                    location,
                    scale_xy,
                    1.0,
                    Kind::Cursor,
                ));
            }
            CursorImageStatus::Named(icon) => {
                if let Some(image) = scene.cursors.get(*icon, scale) {
                    let location = at.to_physical(scale_xy) - image.hotspot.to_f64();
                    let size = (
                        (image.width as f64 / scale).round() as i32,
                        (image.height as f64 / scale).round() as i32,
                    );
                    if let Ok(element) = MemoryRenderBufferRenderElement::from_buffer(
                        renderer,
                        location,
                        &image.buffer,
                        None,
                        // All of the image, however big it's drawn: without it,
                        // smithay takes as much of the image as it's drawn big.
                        Some(Rectangle::from_size((image.width as f64, image.height as f64).into())),
                        Some(size.into()),
                        Kind::Cursor,
                    ) {
                        elements.push(SceneElement::Memory(element));
                    }
                }
            }
        }
    }

    if let Some((buffer, rect)) = scene.direct.filter(|(_, rect)| rect.overlaps(area)) {
        let location = (rect.loc - origin).to_f64().to_physical(scale_xy);
        elements.push(SceneElement::Texture(TextureRenderElement::from_texture_buffer(
            location,
            buffer,
            None,
            None,
            Some(rect.size),
            Kind::Unspecified,
        )));
    }

    for window in scene.space.elements() {
        let Some(location) = scene.space.element_location(window) else { continue };
        let location = (location - window.geometry().loc - origin).to_physical_precise_round(scale_xy);
        elements.extend(
            smithay::backend::renderer::element::AsRenderElements::<GlesRenderer>::render_elements::<SceneElement>(
                window, renderer, location, scale_xy, 1.0,
            ),
        );
    }

    // Zoomed about the pointer, which so stays over what it's pointing at:
    // what's under it on screen is what's under it on the layout, and input
    // needs no translating.
    let zoom_about = scene.pointer.filter(|p| scene.zoom > 1.001 && area.to_f64().contains(*p));
    match zoom_about {
        Some(pointer) => {
            let about = (pointer - origin.to_f64()).to_physical(scale_xy).to_i32_round();
            elements
                .into_iter()
                .map(|e| OutputElement::Zoomed(RescaleRenderElement::from_element(e, about, scene.zoom)))
                .collect()
        }
        None => elements.into_iter().map(OutputElement::Scene).collect(),
    }
}
