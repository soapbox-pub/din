//! wlr-screencopy: copies of a display (or part of one) for screenshots
//! (grim) and screen sharing (deckmon's AirPlay), into the client's shared
//! memory or, where it offers one, its GPU buffer, so a copy never leaves
//! the GPU.
//!
//! A plain copy is made at once. A copy "with damage" waits for the
//! display's next frame that changed something, which paces a screen
//! recorder by what happens on screen.
//!
//! A copy into a GPU buffer is ready once the GPU has drawn it, which the
//! event loop hears from its fence, so the compositor's own frames and input
//! don't wait on it.

use std::{
    os::fd::OwnedFd,
    sync::atomic::{AtomicBool, Ordering},
};

use smithay::{
    backend::{
        allocator::{Buffer, Fourcc},
        renderer::{
            Bind, ExportMem, Offscreen,
            damage::OutputDamageTracker,
            gles::{GlesRenderbuffer, GlesRenderer},
        },
    },
    output::Output,
    reexports::{
        calloop::{Interest, Mode, PostAction, generic::Generic},
        wayland_protocols_wlr::screencopy::v1::server::{
            zwlr_screencopy_frame_v1::{self, ZwlrScreencopyFrameV1},
            zwlr_screencopy_manager_v1::{self, ZwlrScreencopyManagerV1},
        },
        wayland_server::{
            Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource,
            protocol::{wl_buffer::WlBuffer, wl_output::WlOutput, wl_shm},
        },
    },
    utils::{Logical, Physical, Rectangle, Size, Transform},
    wayland::{dmabuf::get_dmabuf, shm::with_buffer_contents_mut},
};
use tracing::debug;

use super::{
    render::{self, BACKDROP, Scene},
    state::State,
};

pub struct Screencopy {
    /// Copies waiting for their display to change.
    waiting: Vec<Copy>,
}

struct Copy {
    frame: ZwlrScreencopyFrameV1,
    buffer: WlBuffer,
}

/// What a frame copies.
pub struct FrameInfo {
    /// None for an output that's gone or off: the frame has failed.
    head: Option<u64>,
    /// The part of the display, in its logical coordinates; None for all of it.
    region: Option<Rectangle<i32, Logical>>,
    cursor: bool,
    size: Size<i32, Physical>,
    used: AtomicBool,
}

impl Screencopy {
    pub fn new(dh: &DisplayHandle) -> Screencopy {
        dh.create_global::<State, ZwlrScreencopyManagerV1, _>(3, ());
        Screencopy { waiting: Vec::new() }
    }

    pub fn head_disabled(&mut self, id: u64) {
        self.waiting.retain(|copy| {
            let ours = copy.frame.data::<FrameInfo>().and_then(|i| i.head) == Some(id);
            if ours {
                copy.frame.failed();
            }
            !ours
        });
    }

    pub fn head_removed(&mut self, id: u64) {
        self.head_disabled(id);
    }
}

impl GlobalDispatch<ZwlrScreencopyManagerV1, ()> for State {
    fn bind(
        _state: &mut State,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<ZwlrScreencopyManagerV1>,
        _data: &(),
        data_init: &mut DataInit<'_, State>,
    ) {
        data_init.init(resource, ());
    }
}

impl Dispatch<ZwlrScreencopyManagerV1, ()> for State {
    fn request(
        state: &mut State,
        _client: &Client,
        _resource: &ZwlrScreencopyManagerV1,
        request: zwlr_screencopy_manager_v1::Request,
        _data: &(),
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, State>,
    ) {
        match request {
            zwlr_screencopy_manager_v1::Request::CaptureOutput { frame, overlay_cursor, output } => {
                state.new_frame(frame, overlay_cursor != 0, &output, None, data_init);
            }
            zwlr_screencopy_manager_v1::Request::CaptureOutputRegion { frame, overlay_cursor, output, x, y, width, height } => {
                let region = Rectangle::new((x, y).into(), (width, height).into());
                state.new_frame(frame, overlay_cursor != 0, &output, Some(region), data_init);
            }
            _ => {}
        }
    }
}

impl Dispatch<ZwlrScreencopyFrameV1, FrameInfo> for State {
    fn request(
        state: &mut State,
        _client: &Client,
        frame: &ZwlrScreencopyFrameV1,
        request: zwlr_screencopy_frame_v1::Request,
        info: &FrameInfo,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, State>,
    ) {
        let (buffer, with_damage) = match request {
            zwlr_screencopy_frame_v1::Request::Copy { buffer } => (buffer, false),
            zwlr_screencopy_frame_v1::Request::CopyWithDamage { buffer } => (buffer, true),
            _ => return,
        };
        if info.used.swap(true, Ordering::SeqCst) {
            frame.post_error(zwlr_screencopy_frame_v1::Error::AlreadyUsed, "the frame was already copied");
            return;
        }
        if info.head.is_none_or(|id| !state.backend.head(id).is_some_and(|h| h.enabled())) {
            frame.failed();
            return;
        }
        if !buffer_fits(&buffer, info.size) {
            frame.post_error(zwlr_screencopy_frame_v1::Error::InvalidBuffer, "the buffer isn't what was offered");
            return;
        }
        if with_damage {
            state.screencopy.waiting.push(Copy { frame: frame.clone(), buffer });
        } else {
            state.copy_frame(frame, &buffer, false);
        }
    }
}

/// Whether BUFFER is shared memory or a GPU buffer of SIZE, in a format offered.
fn buffer_fits(buffer: &WlBuffer, size: Size<i32, Physical>) -> bool {
    if let Ok(dmabuf) = get_dmabuf(buffer) {
        let s = dmabuf.size();
        return (s.w, s.h) == (size.w, size.h);
    }
    smithay::wayland::shm::with_buffer_contents(buffer, |_, _, data| {
        data.width == size.w
            && data.height == size.h
            && data.stride >= size.w * 4
            && matches!(data.format, wl_shm::Format::Xrgb8888 | wl_shm::Format::Argb8888)
    })
    .unwrap_or(false)
}

impl State {
    fn new_frame(
        &mut self,
        frame: New<ZwlrScreencopyFrameV1>,
        cursor: bool,
        output: &WlOutput,
        region: Option<Rectangle<i32, Logical>>,
        data_init: &mut DataInit<'_, State>,
    ) {
        let head = Output::from_resource(output).and_then(|o| self.backend.head_for_output(&o)).filter(|h| h.enabled());
        let (head, region, size) = match head {
            Some(head) => {
                let (w, h) = head.mode.size();
                match region {
                    None => (Some(head.id), None, Size::from((w as i32, h as i32))),
                    Some(region) => {
                        let logical = self.space.output_geometry(&head.output).map(|g| g.size).unwrap_or_default();
                        let region = region.intersection(Rectangle::from_size(logical)).unwrap_or_default();
                        let size = region.size.to_f64().to_physical(head.scale).to_i32_round();
                        (Some(head.id), Some(region), size)
                    }
                }
            }
            None => (None, None, Size::from((0, 0))),
        };
        let frame = data_init.init(frame, FrameInfo { head, region, cursor, size, used: AtomicBool::new(false) });
        if head.is_none() || size.w <= 0 || size.h <= 0 {
            frame.failed();
            return;
        }
        frame.buffer(wl_shm::Format::Xrgb8888, size.w as u32, size.h as u32, size.w as u32 * 4);
        if frame.version() >= 3 {
            frame.linux_dmabuf(Fourcc::Xrgb8888 as u32, size.w as u32, size.h as u32);
            frame.buffer_done();
        }
    }

    /// After display ID rendered a frame: the copies waiting for it to change.
    pub fn after_render(&mut self, id: u64, damaged: bool) {
        if !damaged {
            return;
        }
        let (ready, waiting): (Vec<Copy>, Vec<Copy>) = std::mem::take(&mut self.screencopy.waiting)
            .into_iter()
            .partition(|c| c.frame.data::<FrameInfo>().and_then(|i| i.head) == Some(id));
        self.screencopy.waiting = waiting;
        for copy in ready {
            if copy.frame.is_alive() {
                self.copy_frame(&copy.frame, &copy.buffer, true);
            }
        }
    }

    fn copy_frame(&mut self, frame: &ZwlrScreencopyFrameV1, buffer: &WlBuffer, with_damage: bool) {
        let Some(info) = frame.data::<FrameInfo>() else { return };
        match self.render_copy(info, buffer) {
            Ok(None) => self.copy_ready(frame, with_damage),
            Ok(Some(fence)) => {
                let waiting = frame.clone();
                let source = Generic::new(fence, Interest::READ, Mode::OneShot);
                let inserted = self.handle.insert_source(source, move |_, _, state| {
                    if waiting.is_alive() {
                        state.copy_ready(&waiting, with_damage);
                    }
                    Ok(PostAction::Remove)
                });
                if let Err(err) = inserted {
                    debug!("screencopy: waiting for the GPU: {err}");
                    frame.failed();
                }
            }
            Err(err) => {
                debug!("screencopy: {err}");
                frame.failed();
            }
        }
    }

    fn copy_ready(&self, frame: &ZwlrScreencopyFrameV1, with_damage: bool) {
        let Some(info) = frame.data::<FrameInfo>() else { return };
        frame.flags(zwlr_screencopy_frame_v1::Flags::empty());
        if with_damage {
            frame.damage(0, 0, info.size.w as u32, info.size.h as u32);
        }
        let now: std::time::Duration = self.clock.now().into();
        let secs = now.as_secs();
        frame.ready((secs >> 32) as u32, secs as u32, now.subsec_nanos());
    }

    /// Draws the copy. A GPU copy that's still being drawn gives the fence
    /// that signals when it's done.
    fn render_copy(&mut self, info: &FrameInfo, buffer: &WlBuffer) -> Result<Option<OwnedFd>, String> {
        let head = info.head.and_then(|id| self.backend.head(id)).ok_or("the display is gone")?;
        let output = head.output.clone();
        let display = self.space.output_geometry(&output).ok_or("the display is off")?;
        let scale = output.current_scale().fractional_scale();
        let (area, transform) = match info.region {
            Some(region) => (Rectangle::new(display.loc + region.loc, region.size), Transform::Normal),
            None => (display, output.current_transform()),
        };
        let pointer =
            self.pointer_visible().then(|| self.seat.get_pointer().map(|p| p.current_location())).flatten();
        let renderer = &mut self.backend.renderer;
        let mut scene = Scene {
            space: &self.space,
            pointer,
            cursor_status: &self.cursor_status,
            cursors: &mut self.cursor,
            dnd_icon: self.dnd_icon.as_ref(),
        };
        let elements = render::elements(&mut scene, renderer, area, scale, info.cursor);
        let mut tracker = OutputDamageTracker::new(info.size, scale, transform);

        if let Ok(dmabuf) = get_dmabuf(buffer) {
            let mut dmabuf = dmabuf.clone();
            let mut target = renderer.bind(&mut dmabuf).map_err(|e| e.to_string())?;
            let result = tracker
                .render_output(renderer, &mut target, 0, &elements, BACKDROP)
                .map_err(|e| format!("{e:?}"))?;
            // The client reads it as soon as it hears it's ready.
            if !result.sync.is_reached() {
                if let Some(fence) = result.sync.export() {
                    return Ok(Some(fence));
                }
                let _ = result.sync.wait();
            }
            return Ok(None);
        }

        let size = (info.size.w, info.size.h);
        let mut offscreen: GlesRenderbuffer =
            renderer.create_buffer(Fourcc::Xrgb8888, size.into()).map_err(|e| e.to_string())?;
        let mut target = renderer.bind(&mut offscreen).map_err(|e| e.to_string())?;
        tracker
            .render_output(renderer, &mut target, 0, &elements, BACKDROP)
            .map_err(|e| format!("{e:?}"))?;
        let mapping = renderer
            .copy_framebuffer(&target, Rectangle::from_size(size.into()), Fourcc::Xrgb8888)
            .map_err(|e| e.to_string())?;
        drop(target);
        // The mapping says it's flipped, as every GLES one does, but the frame
        // was drawn top row first, as for a display, so it reads out upright.
        let pixels = ExportMem::map_texture(renderer as &mut GlesRenderer, &mapping).map_err(|e| e.to_string())?;
        let row = info.size.w as usize * 4;
        let rows = info.size.h as usize;
        with_buffer_contents_mut(buffer, |ptr, len, data| {
            let stride = data.stride as usize;
            let offset = data.offset as usize;
            for y in 0..rows {
                let from = y * row;
                let to = offset + y * stride;
                if to + row > len || from + row > pixels.len() {
                    break;
                }
                // SAFETY: the range was checked against the pool's length.
                unsafe { std::ptr::copy_nonoverlapping(pixels[from..].as_ptr(), ptr.add(to), row) };
            }
        })
        .map_err(|e| e.to_string())
        .map(|()| None)
    }
}
