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

use std::{
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
            utils::import_surface_tree,
        },
    },
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{DeviceFd, Logical, Physical, Rectangle, Size, Transform},
};

/// Buffers per window.
const RING: usize = 3;

pub struct Gpu {
    pub renderer: GlesRenderer,
    allocator: GbmAllocator<DeviceFd>,
    /// The render node's device number, for dmabuf feedback.
    pub device: libc::dev_t,
    next_buffer: u32,
}

/// The render node to use: DIN_RENDER_NODE, else the first one present.
fn render_node() -> Option<PathBuf> {
    if let Ok(node) = std::env::var("DIN_RENDER_NODE") {
        return Some(node.into());
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
        eprintln!("din-compositor: rendering on {}", path.display());
        Some(Self {
            renderer,
            allocator: GbmAllocator::new(gbm, GbmBufferFlags::RENDERING),
            device,
            next_buffer: 1,
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
            let id = gpu.next_buffer;
            gpu.next_buffer += 1;
            channel.announce(id, &dmabuf);
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
            channel.send(&json!({ "type": "drop", "buffer": buffer.id }), None);
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

    fn announce(&mut self, id: u32, dmabuf: &Dmabuf) {
        let size = dmabuf.size();
        let stride = dmabuf.strides().next().unwrap_or(0);
        let offset = dmabuf.offsets().next().unwrap_or(0);
        let modifier: u64 = dmabuf.format().modifier.into();
        let message = json!({
            "type": "buffer",
            "buffer": id,
            "width": size.w,
            "height": size.h,
            "stride": stride,
            "offset": offset,
            "modifier": modifier.to_string(),
        });
        let fd = dmabuf.handles().next().map(|fd| fd.as_raw_fd());
        self.send(&message, fd);
    }

    /// Send one message, with a descriptor riding on its first byte.
    pub fn send(&mut self, message: &Value, fd: Option<i32>) {
        let Some(stream) = self.client.as_ref() else { return };
        let body = serde_json::to_vec(message).unwrap_or_default();
        let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
        bytes.extend_from_slice(&body);
        let ok = match fd {
            None => (&*stream).write_all(&bytes).is_ok(),
            Some(fd) => send_with_fd(stream, &bytes, fd),
        };
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

fn send_with_fd(stream: &UnixStream, bytes: &[u8], fd: i32) -> bool {
    // SAFETY: a standard SCM_RIGHTS sendmsg over buffers that outlive it.
    unsafe {
        let mut iov = libc::iovec { iov_base: bytes.as_ptr() as *mut _, iov_len: bytes.len() };
        let space = libc::CMSG_SPACE(size_of::<i32>() as u32) as usize;
        let mut control = vec![0u8; space];
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = control.as_mut_ptr().cast();
        msg.msg_controllen = space as _;
        let cmsg = libc::CMSG_FIRSTHDR(&msg);
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = libc::CMSG_LEN(size_of::<i32>() as u32) as _;
        std::ptr::write_unaligned(libc::CMSG_DATA(cmsg).cast::<i32>(), fd);
        let sent = libc::sendmsg(stream.as_fd().as_raw_fd(), &msg, 0);
        if sent < 0 {
            return false;
        }
        // The descriptor went with the first byte; finish the rest plainly.
        let sent = sent as usize;
        sent == bytes.len() || (&*stream).write_all(&bytes[sent..]).is_ok()
    }
}
