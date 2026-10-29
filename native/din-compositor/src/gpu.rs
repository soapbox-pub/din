//! The GPU path: windows composited on the GPU into dmabufs that Din shows
//! without a single CPU copy.
//!
//! Each window (and popup) gets a ring of three GBM buffers. The compositor
//! renders its surface tree into the next one with GLES - client buffers
//! included, which with linux-dmabuf are GPU textures to begin with - and
//! tells Din "window W is in buffer B". Din's main process imports each
//! buffer once, by file descriptor (`sharedTexture` in Electron; the
//! descriptors travel over the buffer socket below via SCM_RIGHTS, received
//! by native/din-fd), and the shell draws it into the window's canvas on the
//! GPU. Per frame, only a few dozen bytes cross a process boundary.
//!
//! Three buffers suffice: the shell acks every batch, at most two batches are
//! ever in flight, so the buffer being rendered into is never one Din may
//! still be reading.
//!
//! Most windows are one surface in one GPU buffer, though - a game, a video
//! player, anything through Xwayland - and there's nothing to composite:
//! Din is handed the app's own buffer instead (Passthrough), imported once
//! like a ring buffer, and the app gets it back once Din has drawn the frame
//! after it.
//!
//! Only where Din can show such a buffer, though: one it can't import is a
//! black window, with nothing to say so. Linear buffers it always can, as
//! the rings are linear. Tiled ones are passed on only when this compositor
//! draws on the GPU Chromium does (DIN_CHROMIUM_RENDER_NODE, from Din's
//! main process); the apps are then offered the layouts Chromium imports.
//! Elsewhere (two GPUs, Din on X11) apps get every layout the GPU can
//! composite, and only those that pick a linear one are passed on.
//! DIN_COMPOSITOR_PASSTHROUGH=0 turns it off.

use std::{
    collections::HashMap,
    io::Write,
    os::{
        fd::{AsFd, AsRawFd, OwnedFd},
        unix::{fs::MetadataExt, net::{UnixListener, UnixStream}},
    },
    path::PathBuf,
};

use serde_json::{Value, json};
use smithay::{
    backend::{
        allocator::{
            Allocator, Buffer, Fourcc, Modifier,
            dmabuf::{AsDmabuf, Dmabuf},
            gbm::{GbmAllocator, GbmBuffer, GbmBufferFlags, GbmDevice},
        },
        egl::{EGLContext, EGLDisplay},
        renderer::{
            Bind,
            damage::OutputDamageTracker,
            element::{
                Kind,
                surface::{WaylandSurfaceRenderElement, render_elements_from_surface_tree},
            },
            gles::GlesRenderer,
            utils::{self, import_surface_tree, with_renderer_surface_state},
        },
    },
    reexports::wayland_server::{
        Resource,
        backend::ObjectId,
        protocol::{wl_buffer::WlBuffer, wl_surface::WlSurface},
    },
    utils::{DeviceFd, Logical, Physical, Rectangle, Size, Transform},
    wayland::{compositor::get_children, dmabuf::get_dmabuf},
};

/// Buffers per window.
const RING: usize = 3;

pub struct Gpu {
    pub renderer: GlesRenderer,
    allocator: GbmAllocator<DeviceFd>,
    /// The render node's device number, for dmabuf feedback.
    pub device: libc::dev_t,
    next_buffer: u32,
    /// Whether apps' own buffers may go to Din (DIN_COMPOSITOR_PASSTHROUGH).
    passthrough: bool,
    /// Whether this is the GPU Chromium draws on, so it imports the tiled
    /// layouts apps render in.
    shared_with_chromium: bool,
}

/// The device number of a render node.
fn device_of(path: &str) -> Option<libc::dev_t> {
    std::fs::metadata(path).ok().map(|m| m.rdev())
}

/// The render node to use: DIN_RENDER_NODE, else Chromium's, else the first
/// one present.
fn render_node() -> Option<PathBuf> {
    for name in ["DIN_RENDER_NODE", "DIN_CHROMIUM_RENDER_NODE"] {
        if let Ok(node) = std::env::var(name) {
            return Some(node.into());
        }
    }
    let mut nodes: Vec<PathBuf> = std::fs::read_dir("/dev/dri")
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.file_name().is_some_and(|n| n.to_string_lossy().starts_with("renderD")))
        .collect();
    nodes.sort();
    nodes.into_iter().next()
}

impl Gpu {
    /// Open the GPU, or None where there isn't a usable one (a VM, a box
    /// without render nodes, DIN_COMPOSITOR_GPU=0) - the CPU path runs then.
    pub fn open() -> Option<Self> {
        if std::env::var("DIN_COMPOSITOR_GPU").as_deref() == Ok("0") {
            return None;
        }
        let path = render_node()?;
        let file = std::fs::OpenOptions::new().read(true).write(true).open(&path).ok()?;
        let device = file.metadata().ok()?.rdev();
        let gbm = GbmDevice::new(DeviceFd::from(OwnedFd::from(file))).ok()?;
        // SAFETY: the GBM device outlives the display (both live in Gpu).
        let display = unsafe { EGLDisplay::new(gbm.clone()) }.ok()?;
        let context = EGLContext::new(&display).ok()?;
        // SAFETY: the context is new and current on this thread only.
        let renderer = unsafe { GlesRenderer::new(context) }.ok()?;
        let passthrough = std::env::var("DIN_COMPOSITOR_PASSTHROUGH").as_deref() != Ok("0");
        let shared_with_chromium = std::env::var("DIN_CHROMIUM_RENDER_NODE")
            .ok()
            .and_then(|node| device_of(&node))
            .is_some_and(|chromium| chromium == device);
        eprintln!(
            "din-compositor: rendering on {}{}",
            path.display(),
            match (passthrough, shared_with_chromium) {
                (false, _) => ", compositing every window",
                (true, true) => ", Chromium's GPU",
                (true, false) => ", passing on only linear buffers",
            },
        );
        Some(Self {
            renderer,
            allocator: GbmAllocator::new(gbm, GbmBufferFlags::RENDERING),
            device,
            next_buffer: 1,
            passthrough,
            shared_with_chromium,
        })
    }

    /// Composite `surface`'s tree into the window's next buffer. Returns the
    /// buffer to present, or None when nothing changed.
    pub fn render(
        &mut self,
        target: &mut Option<Target>,
        surface: &WlSurface,
        geometry: Rectangle<i32, Logical>,
        channel: &mut BufferChannel,
    ) -> Option<u32> {
        let size: Size<i32, Physical> = (geometry.size.w, geometry.size.h).into();
        if size.w <= 0 || size.h <= 0 {
            return None;
        }
        if target.as_ref().is_none_or(|t| t.size != size) {
            if let Some(old) = target.take() {
                old.release(channel);
            }
            *target = Some(Target::new(self, size, channel)?);
        }
        let target = target.as_mut()?;

        let _ = import_surface_tree(&mut self.renderer, surface);
        let elements: Vec<WaylandSurfaceRenderElement<GlesRenderer>> = render_elements_from_surface_tree(
            &mut self.renderer,
            surface,
            (-geometry.loc.x, -geometry.loc.y),
            1.0,
            1.0,
            Kind::Unspecified,
        );
        let slot = target.next;
        let buffer = &mut target.buffers[slot];
        let age = buffer.rendered_at.map(|f| (target.frame + 1 - f) as usize).unwrap_or(0);
        let mut dmabuf = buffer.dmabuf.clone();
        let damaged = {
            let mut framebuffer = self.renderer.bind(&mut dmabuf).ok()?;
            let result = target
                .tracker
                .render_output(&mut self.renderer, &mut framebuffer, age, &elements, [0.0, 0.0, 0.0, 0.0])
                .ok()?;
            let damaged = result.damage.is_some_and(|d| !d.is_empty());
            // Din samples the buffer from another process; it must be
            // finished before it's announced.
            let _ = result.sync.wait();
            damaged
        };
        if !damaged {
            return None;
        }
        target.frame += 1;
        target.next = (slot + 1) % target.buffers.len();
        let buffer = &mut target.buffers[slot];
        buffer.rendered_at = Some(target.frame);
        Some(buffer.id)
    }

    /// The buffer formats to offer apps. On Chromium's GPU: 8-bit RGB (Din's
    /// pages show nothing deeper), in layouts of a single plane. Those are
    /// what Chromium imports, so an app's buffer can go to Din as it is;
    /// compressed layouts (AMD's DCC) carry a second plane it can't.
    /// Elsewhere, everything the GPU composites.
    pub fn client_formats(&mut self) -> Vec<smithay::backend::allocator::Format> {
        let formats = smithay::backend::renderer::ImportDma::dmabuf_formats(&self.renderer);
        if !(self.passthrough && self.shared_with_chromium) {
            return formats.into_iter().collect();
        }
        formats
            .into_iter()
            .filter(|f| matches!(f.code, Fourcc::Argb8888 | Fourcc::Xrgb8888 | Fourcc::Abgr8888 | Fourcc::Xbgr8888))
            .filter(|f| {
                f.modifier == Modifier::Linear
                    || f.modifier == Modifier::Invalid
                    || self
                        .allocator
                        .create_buffer(64, 64, f.code, &[f.modifier])
                        .ok()
                        .and_then(|bo| bo.export().ok())
                        .is_some_and(|dmabuf| dmabuf.num_planes() == 1)
            })
            .collect()
    }

    /// Whether Din can be handed DMABUF as it is (see the module docs).
    fn shows(&self, dmabuf: &Dmabuf) -> bool {
        self.passthrough
            && dmabuf.num_planes() == 1
            && (self.shared_with_chromium || dmabuf.format().modifier == Modifier::Linear)
    }

    fn allocate_id(&mut self) -> u32 {
        let id = self.next_buffer;
        self.next_buffer += 1;
        id
    }
}

/// How Din imports a client buffer of FORMAT (its pixel format, in
/// Electron's terms), or None where it can't be shown as it is. A format
/// without alpha only goes in an opaque window: Din would take the padding
/// byte for alpha, which an opaque canvas ignores.
fn passthrough_format(format: Fourcc, opaque: bool) -> Option<&'static str> {
    match format {
        Fourcc::Argb8888 => Some("bgra"),
        Fourcc::Abgr8888 => Some("rgba"),
        Fourcc::Xrgb8888 if opaque => Some("bgra"),
        Fourcc::Xbgr8888 if opaque => Some("rgba"),
        _ => None,
    }
}

/// Whether nothing shows through SURFACE: its buffer has no alpha, or the
/// app marked all of it opaque.
pub fn fully_opaque(surface: &WlSurface) -> bool {
    let buffer = with_renderer_surface_state(surface, |state| {
        let size = state.surface_size()?;
        let covered = state.opaque_regions().is_some_and(|regions| {
            regions.iter().any(|region| region.contains_rect(Rectangle::from_size(size)))
        });
        Some((state.buffer()?.clone(), covered))
    })
    .flatten();
    let Some((buffer, covered)) = buffer else { return false };
    covered
        || get_dmabuf(&buffer).is_ok_and(|d| matches!(d.format().code, Fourcc::Xrgb8888 | Fourcc::Xbgr8888))
        || smithay::wayland::shm::with_buffer_contents(&buffer, |_, _, data| {
            data.format == smithay::reexports::wayland_server::protocol::wl_shm::Format::Xrgb8888
        })
        .unwrap_or(false)
}

/// A window whose app's own buffer Din shows (see the module docs).
pub struct Shown {
    buffer: utils::Buffer,
}

/// Client buffers handed to Din as they are.
#[derive(Default)]
pub struct Passthrough {
    /// The ones Din has imported, by their wl_buffer.
    known: HashMap<ObjectId, u32>,
    /// Buffers replaced on screen by the batch in flight: their apps get
    /// them back once it's acked.
    releasing: Vec<utils::Buffer>,
}

impl Passthrough {
    /// Show SURFACE's buffer itself as a window of GEOMETRY, if it can be:
    /// a lone surface (no subsurfaces), whose GPU buffer is exactly the
    /// window, unscaled, in a format Din takes. Returns the buffer's id, or
    /// None to composite the window as usual.
    pub fn show(
        &mut self,
        gpu: &mut Gpu,
        channel: &mut BufferChannel,
        shown: &mut Option<Shown>,
        surface: &WlSurface,
        geometry: Rectangle<i32, Logical>,
        opaque: bool,
    ) -> Option<u32> {
        if !get_children(surface).is_empty() || geometry.loc != (0, 0).into() {
            return None;
        }
        let buffer = with_renderer_surface_state(surface, |state| {
            if state.buffer_scale() != 1 || state.buffer_transform() != Transform::Normal {
                return None;
            }
            let size = state.buffer_size()?;
            let view = state.view()?;
            let whole = view.src == Rectangle::from_size(size.to_f64()) && view.dst == size;
            (whole && size == geometry.size).then(|| state.buffer().cloned()).flatten()
        })
        .flatten()?;
        let dmabuf = get_dmabuf(&buffer).ok().filter(|d| gpu.shows(d))?;
        let format = passthrough_format(dmabuf.format().code, opaque)?;
        let id = match self.known.get(&buffer.id()) {
            Some(&id) => id,
            None => {
                let id = gpu.allocate_id();
                channel.announce(id, dmabuf, format);
                self.known.insert(buffer.id(), id);
                id
            }
        };
        if let Some(old) = shown.replace(Shown { buffer }) {
            self.releasing.push(old.buffer);
        }
        Some(id)
    }

    /// The window is composited again, or gone: its app's buffer goes back
    /// with the next ack.
    pub fn stop(&mut self, shown: &mut Option<Shown>) {
        if let Some(old) = shown.take() {
            self.releasing.push(old.buffer);
        }
    }

    /// Din has drawn the batch in flight: what it replaced goes back.
    pub fn acked(&mut self) {
        self.releasing.clear();
    }

    /// An app destroyed a buffer: Din lets go of its import.
    pub fn destroyed(&mut self, buffer: &WlBuffer, channel: Option<&mut BufferChannel>) {
        if let (Some(id), Some(channel)) = (self.known.remove(&buffer.id()), channel) {
            channel.send(&json!({ "type": "drop", "buffer": id }), &[]);
        }
    }

    /// A new reader holds no imports: every buffer is announced afresh.
    pub fn forget(&mut self) {
        self.known.clear();
    }
}

struct SharedBuffer {
    id: u32,
    dmabuf: Dmabuf,
    /// Keeps the allocation alive as long as the dmabuf is in use.
    _bo: GbmBuffer,
    /// Frame number last rendered into this buffer (for damage age).
    rendered_at: Option<u64>,
}

/// One window's ring of shared buffers.
pub struct Target {
    size: Size<i32, Physical>,
    buffers: Vec<SharedBuffer>,
    next: usize,
    frame: u64,
    tracker: OutputDamageTracker,
}

impl Target {
    fn new(gpu: &mut Gpu, size: Size<i32, Physical>, channel: &mut BufferChannel) -> Option<Self> {
        let mut buffers = Vec::with_capacity(RING);
        for _ in 0..RING {
            let bo = gpu
                .allocator
                .create_buffer(size.w as u32, size.h as u32, Fourcc::Argb8888, &[Modifier::Linear])
                .ok()?;
            let dmabuf = bo.export().ok()?;
            let id = gpu.allocate_id();
            channel.announce(id, &dmabuf, "bgra");
            buffers.push(SharedBuffer { id, dmabuf, _bo: bo, rendered_at: None });
        }
        Some(Self {
            size,
            buffers,
            next: 0,
            frame: 0,
            tracker: OutputDamageTracker::new(size, 1.0, Transform::Normal),
        })
    }

    /// Tell Din these buffers are gone (it releases its imports).
    pub fn release(self, channel: &mut BufferChannel) {
        for buffer in &self.buffers {
            channel.send(&json!({ "type": "drop", "buffer": buffer.id }), &[]);
        }
    }
}

/// The socket Din's main process reads buffers and presents from.
pub struct BufferChannel {
    pub listener: UnixListener,
    pub path: PathBuf,
    client: Option<UnixStream>,
}

impl BufferChannel {
    pub fn bind() -> std::io::Result<Self> {
        let dir = PathBuf::from(std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into()));
        // Sockets of compositors that died without cleaning up.
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(pid) = name.strip_prefix("din-buffers-") {
                if !PathBuf::from(format!("/proc/{pid}")).exists() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let path = dir.join(format!("din-buffers-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path)?;
        listener.set_nonblocking(true)?;
        Ok(Self { listener, path, client: None })
    }

    /// A new reader (Din started, or its main process reconnected).
    pub fn accept(&mut self) -> bool {
        match self.listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                self.client = Some(stream);
                true
            }
            Err(_) => false,
        }
    }

    pub fn connected(&self) -> bool {
        self.client.is_some()
    }

    /// Tell Din about a buffer, in FORMAT (Electron's name for it), with a
    /// descriptor for each of its planes.
    fn announce(&mut self, id: u32, dmabuf: &Dmabuf, format: &str) {
        let size = dmabuf.size();
        let modifier: u64 = dmabuf.format().modifier.into();
        let fds: Vec<i32> = dmabuf.handles().map(|fd| fd.as_raw_fd()).collect();
        let planes: Vec<Value> = dmabuf
            .offsets()
            .zip(dmabuf.strides())
            .zip(&fds)
            .map(|((offset, stride), &fd)| {
                // SAFETY: lseek on a descriptor the dmabuf owns; a dmabuf's
                // end is its size, and nothing reads it by position.
                let end = unsafe { libc::lseek(fd, 0, libc::SEEK_END) }.max(0) as u64;
                json!({ "offset": offset, "stride": stride, "size": end.saturating_sub(offset as u64) })
            })
            .collect();
        let message = json!({
            "type": "buffer",
            "buffer": id,
            "width": size.w,
            "height": size.h,
            "format": format,
            "planes": planes,
            "modifier": modifier.to_string(),
        });
        self.send(&message, &fds);
    }

    /// Send one message, with any descriptors riding on its first byte.
    pub fn send(&mut self, message: &Value, fds: &[i32]) {
        let Some(stream) = self.client.as_ref() else { return };
        let body = serde_json::to_vec(message).unwrap_or_default();
        let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(&body);
        let ok = if fds.is_empty() { (&*stream).write_all(&bytes).is_ok() } else { send_with_fds(stream, &bytes, fds) };
        if !ok {
            self.client = None;
        }
    }
}

impl Drop for BufferChannel {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn send_with_fds(stream: &UnixStream, bytes: &[u8], fds: &[i32]) -> bool {
    let len = size_of_val(fds) as u32;
    // SAFETY: a standard SCM_RIGHTS sendmsg over buffers that outlive it.
    unsafe {
        let mut iov = libc::iovec { iov_base: bytes.as_ptr() as *mut _, iov_len: bytes.len() };
        let space = libc::CMSG_SPACE(len) as usize;
        let mut control = vec![0u8; space];
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = control.as_mut_ptr().cast();
        msg.msg_controllen = space as _;
        let cmsg = libc::CMSG_FIRSTHDR(&msg);
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = libc::CMSG_LEN(len) as _;
        std::ptr::copy_nonoverlapping(fds.as_ptr().cast::<u8>(), libc::CMSG_DATA(cmsg), len as usize);
        let sent = libc::sendmsg(stream.as_fd().as_raw_fd(), &msg, 0);
        if sent < 0 {
            return false;
        }
        // The descriptors went with the first byte; finish the rest plainly.
        let sent = sent as usize;
        sent == bytes.len() || (&*stream).write_all(&bytes[sent..]).is_ok()
    }
}
