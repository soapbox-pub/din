//! Compositor state and the Wayland protocol handlers.
//!
//! Din owns window placement, stacking and decoration; this compositor
//! only tracks what clients map and relays it. Toplevels are told they're
//! tiled on every side (so toolkits drop their shadows and rounded corners)
//! and to use server-side decorations (Din draws the title bar).

use std::{io::Read, os::fd::OwnedFd, sync::Arc, time::Instant};

use smithay::{
    backend::{
        allocator::dmabuf::Dmabuf,
        renderer::{ImportDma, pixman::PixmanRenderer, utils::on_commit_buffer_handler},
    },
    delegate_compositor, delegate_cursor_shape, delegate_data_device, delegate_dmabuf,
    delegate_output, delegate_seat, delegate_shm, delegate_xdg_decoration, delegate_xdg_shell,
    desktop::{PopupKind, PopupManager, Window},
    input::{Seat, SeatHandler, SeatState, keyboard::XkbConfig, pointer::CursorImageStatus},
    output::{Mode, Output, PhysicalProperties, Scale, Subpixel},
    reexports::{
        calloop::channel::Sender,
        wayland_protocols::xdg::{
            decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as DecorationMode,
            shell::server::xdg_toplevel,
        },
        wayland_server::{
            Client, DisplayHandle, Resource,
            backend::{ClientData, ClientId, DisconnectReason},
            protocol::{wl_buffer, wl_seat, wl_surface::WlSurface},
        },
    },
    utils::{Logical, Point, Rectangle, Serial, Size, Transform},
    wayland::{
        buffer::BufferHandler,
        compositor::{CompositorClientState, CompositorHandler, CompositorState, get_parent},
        cursor_shape::CursorShapeManagerState,
        dmabuf::{DmabufFeedbackBuilder, DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
        output::{OutputHandler, OutputManagerState},
        selection::{
            SelectionHandler, SelectionSource, SelectionTarget,
            data_device::{
                ClientDndGrabHandler, DataDeviceHandler, DataDeviceState, ServerDndGrabHandler,
                request_data_device_client_selection, set_data_device_focus,
            },
        },
        shell::xdg::{
            PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState,
            decoration::{XdgDecorationHandler, XdgDecorationState},
        },
        shm::{ShmHandler, ShmState},
        tablet_manager::TabletSeatHandler,
    },
};

use crate::{
    canvas::Canvas,
    frames::FrameServer,
    gpu::{BufferChannel, Gpu, Target},
    stats::Stats,
    wire::Wire,
};

/// Window ids start here, clear of X11 resource ids (29-bit), so the shell
/// can tell the two servers' windows apart.
const FIRST_ID: u32 = 0x4000_0001;

/// Clipboard text larger than this isn't bridged.
const MAX_CLIPBOARD_BYTES: u64 = 256 * 1024;

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}

pub struct Toplevel {
    pub id: u32,
    pub window: Window,
    /// Root position of the window geometry's corner (where Din put it).
    pub pos: Point<i32, Logical>,
    pub announced: bool,
    pub canvas: Option<Canvas>,
    pub target: Option<Target>,
    pub dirty: bool,
    pub title: String,
    /// The size the shell knows the window to be, from either side.
    pub known_size: Option<Size<i32, Logical>>,
}

impl Toplevel {
    pub fn surface(&self) -> &WlSurface {
        self.window.toplevel().expect("wayland window").wl_surface()
    }
}

pub struct Popup {
    pub id: u32,
    pub kind: PopupKind,
    pub parent: WlSurface,
    /// Position relative to the parent's window geometry, from the positioner.
    pub rel: Point<i32, Logical>,
    /// Root position of the popup's window geometry corner.
    pub pos: Point<i32, Logical>,
    pub grab: bool,
    pub announced: bool,
    pub canvas: Option<Canvas>,
    pub target: Option<Target>,
    pub dirty: bool,
}

pub struct State {
    pub dh: DisplayHandle,
    pub start: Instant,
    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
    pub shm_state: ShmState,
    pub seat_state: SeatState<State>,
    pub data_device_state: DataDeviceState,
    // Held only so their globals stay advertised.
    _output_manager_state: OutputManagerState,
    _decoration_state: XdgDecorationState,
    _cursor_shape_state: CursorShapeManagerState,
    pub seat: Seat<State>,
    pub output: Output,
    /// Software renderer: the CPU path, and cursor images in either path.
    pub renderer: PixmanRenderer,
    /// The GPU path, when there is a GPU (see gpu.rs).
    pub gpu: Option<Gpu>,
    pub buffers: Option<BufferChannel>,
    pub dmabuf_state: DmabufState,
    _dmabuf_global: Option<DmabufGlobal>,
    pub popup_manager: PopupManager,
    pub toplevels: Vec<Toplevel>,
    pub popups: Vec<Popup>,
    pub next_id: u32,
    pub wire: Wire,
    pub frames: FrameServer,
    /// Whether a renderer is connected to the frame stream.
    pub streaming: bool,
    pub stats: Option<Stats>,
    pub screen: Size<i32, Logical>,
    /// Patch batches sent and not yet acked by the shell.
    pub in_flight: u32,
    /// Surfaces whose frame callbacks wait for the next ack.
    pub awaiting_frame: Vec<WlSurface>,
    /// The toplevel the shell gave the keyboard (0: none).
    pub focused: u32,
    pub cursor_surface: Option<WlSurface>,
    pub clipboard_tx: Sender<String>,
}

impl State {
    pub fn new(
        dh: &DisplayHandle,
        screen: Size<i32, Logical>,
        frames: FrameServer,
        gpu: Option<Gpu>,
        buffers: Option<BufferChannel>,
        clipboard_tx: Sender<String>,
    ) -> Self {
        let compositor_state = CompositorState::new::<Self>(dh);
        let xdg_shell_state = XdgShellState::new::<Self>(dh);
        let shm_state = ShmState::new::<Self>(dh, vec![]);
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(dh);
        let decoration_state = XdgDecorationState::new::<Self>(dh);
        let cursor_shape_state = CursorShapeManagerState::new::<Self>(dh);

        // linux-dmabuf only with a GPU: clients then render on the GPU and
        // hand over GPU buffers, which the GPU path composites directly.
        let mut dmabuf_state = DmabufState::new();
        let dmabuf_global = gpu.as_ref().and_then(|gpu| {
            let formats = smithay::backend::renderer::ImportDma::dmabuf_formats(&gpu.renderer);
            let feedback = DmabufFeedbackBuilder::new(gpu.device, formats).build().ok()?;
            Some(dmabuf_state.create_global_with_default_feedback::<Self>(dh, &feedback))
        });

        let mut seat = seat_state.new_wl_seat(dh, "seat0");
        // Clients repeat held keys themselves at this rate (the shell drops
        // the DOM's own repeats).
        seat.add_keyboard(XkbConfig::default(), 500, 30).expect("keymap");
        seat.add_pointer();

        // One virtual monitor the size of the shell's viewport: apps size
        // and constrain popups against it.
        let output = Output::new(
            "DIN-1".into(),
            PhysicalProperties {
                size: (0, 0).into(),
                subpixel: Subpixel::Unknown,
                make: "Din".into(),
                model: "Embedded display".into(),
            },
        );
        let mode = Mode { size: (screen.w, screen.h).into(), refresh: 60_000 };
        output.change_current_state(Some(mode), Some(Transform::Normal), Some(Scale::Integer(1)), Some((0, 0).into()));
        output.set_preferred(mode);
        output.create_global::<Self>(dh);

        Self {
            dh: dh.clone(),
            start: Instant::now(),
            compositor_state,
            xdg_shell_state,
            shm_state,
            seat_state,
            data_device_state,
            _output_manager_state: output_manager_state,
            _decoration_state: decoration_state,
            _cursor_shape_state: cursor_shape_state,
            seat,
            output,
            renderer: PixmanRenderer::new().expect("pixman"),
            gpu,
            buffers,
            dmabuf_state,
            _dmabuf_global: dmabuf_global,
            popup_manager: PopupManager::default(),
            toplevels: Vec::new(),
            popups: Vec::new(),
            next_id: FIRST_ID,
            wire: Wire::new(),
            frames,
            streaming: false,
            stats: Stats::from_env(),
            screen,
            in_flight: 0,
            awaiting_frame: Vec::new(),
            focused: 0,
            cursor_surface: None,
            clipboard_tx,
        }
    }

    pub fn allocate_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Root position of a surface's window geometry corner (toplevel or popup).
    pub fn geometry_origin(&self, surface: &WlSurface) -> Point<i32, Logical> {
        if let Some(t) = self.toplevels.iter().find(|t| t.surface() == surface) {
            return t.pos;
        }
        if let Some(p) = self.popups.iter().find(|p| p.kind.wl_surface() == surface) {
            return p.pos;
        }
        (0, 0).into()
    }

    /// Place a popup inside the screen, per its positioner.
    fn place_popup(&self, surface: &PopupSurface, positioner: PositionerState) -> Rectangle<i32, Logical> {
        let parent = surface.get_parent_surface();
        let origin = parent.map(|p| self.geometry_origin(&p)).unwrap_or_default();
        let target = Rectangle::new((-origin.x, -origin.y).into(), self.screen);
        positioner.get_unconstrained_geometry(target)
    }

    /// Tell Din a window's GPU buffers are gone.
    pub fn release_target(&mut self, target: &mut Option<Target>) {
        if let (Some(target), Some(buffers)) = (target.take(), self.buffers.as_mut()) {
            target.release(buffers);
        }
    }

    pub fn now_ms(&self) -> u32 {
        self.start.elapsed().as_millis() as u32
    }
}

/// The topmost surface of a subsurface tree.
pub fn root_surface(surface: &WlSurface) -> WlSurface {
    let mut root = surface.clone();
    while let Some(parent) = get_parent(&root) {
        root = parent;
    }
    root
}

impl CompositorHandler for State {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor_state
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        &client.get_data::<ClientState>().expect("client state").compositor_state
    }

    fn commit(&mut self, surface: &WlSurface) {
        on_commit_buffer_handler::<Self>(surface);
        self.popup_manager.commit(surface);
        let root = root_surface(surface);

        if self.cursor_surface.as_ref() == Some(&root) {
            self.render_cursor();
            return;
        }
        if let Some(t) = self.toplevels.iter_mut().find(|t| t.surface() == &root) {
            t.window.on_commit();
            let toplevel = t.window.toplevel().expect("wayland window");
            if !toplevel.is_initial_configure_sent() {
                toplevel.send_configure();
            }
            t.dirty = true;
        } else if let Some(p) = self.popups.iter_mut().find(|p| p.kind.wl_surface() == &root) {
            if let PopupKind::Xdg(xdg) = &p.kind {
                if !xdg.is_initial_configure_sent() {
                    let _ = xdg.send_configure();
                }
            }
            p.dirty = true;
        }
    }
}

impl BufferHandler for State {
    fn buffer_destroyed(&mut self, _buffer: &wl_buffer::WlBuffer) {}
}

impl ShmHandler for State {
    fn shm_state(&self) -> &ShmState {
        &self.shm_state
    }
}

impl XdgShellHandler for State {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        surface.with_pending_state(|state| {
            state.states.set(xdg_toplevel::State::TiledLeft);
            state.states.set(xdg_toplevel::State::TiledRight);
            state.states.set(xdg_toplevel::State::TiledTop);
            state.states.set(xdg_toplevel::State::TiledBottom);
            state.decoration_mode = Some(DecorationMode::ServerSide);
        });
        let id = self.allocate_id();
        // Cascade until the shell places it; only popup placement reads this.
        let offset = 40 * (self.toplevels.len() as i32 % 8);
        self.toplevels.push(Toplevel {
            id,
            window: Window::new_wayland_window(surface),
            pos: (80 + offset, 80 + offset).into(),
            announced: false,
            canvas: None,
            target: None,
            dirty: false,
            title: String::new(),
            known_size: None,
        });
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        if let Some(index) = self.toplevels.iter().position(|t| t.surface() == surface.wl_surface()) {
            let mut t = self.toplevels.remove(index);
            self.release_target(&mut t.target);
            if t.announced {
                self.wire.json(serde_json::json!({ "type": "close", "id": t.id }));
            }
            if self.focused == t.id {
                self.focused = 0;
            }
        }
    }

    fn new_popup(&mut self, surface: PopupSurface, positioner: PositionerState) {
        let geometry = self.place_popup(&surface, positioner);
        surface.with_pending_state(|state| state.geometry = geometry);
        let Some(parent) = surface.get_parent_surface() else { return };
        let origin = self.geometry_origin(&parent);
        let kind = PopupKind::Xdg(surface);
        let _ = self.popup_manager.track_popup(kind.clone());
        let id = self.allocate_id();
        self.popups.push(Popup {
            id,
            kind,
            parent,
            rel: geometry.loc,
            pos: origin + geometry.loc,
            grab: false,
            announced: false,
            canvas: None,
            target: None,
            dirty: false,
        });
    }

    fn reposition_request(&mut self, surface: PopupSurface, positioner: PositionerState, token: u32) {
        let geometry = self.place_popup(&surface, positioner);
        surface.with_pending_state(|state| {
            state.geometry = geometry;
            state.positioner = positioner;
        });
        surface.send_repositioned(token);
        if let Some(p) = self.popups.iter_mut().find(|p| p.kind.wl_surface() == surface.wl_surface()) {
            p.rel = geometry.loc;
        }
        self.relayout_popups();
    }

    fn grab(&mut self, surface: PopupSurface, _seat: wl_seat::WlSeat, _serial: Serial) {
        // A grabbing popup is a menu: it takes the keyboard, and the shell
        // forwards clicks anywhere so it can dismiss it.
        if let Some(p) = self.popups.iter_mut().find(|p| p.kind.wl_surface() == surface.wl_surface()) {
            p.grab = true;
        }
        if let Some(keyboard) = self.seat.get_keyboard() {
            keyboard.set_focus(self, Some(surface.wl_surface().clone()), Serial::from(0));
        }
    }

    fn popup_destroyed(&mut self, surface: PopupSurface) {
        if let Some(index) = self.popups.iter().position(|p| p.kind.wl_surface() == surface.wl_surface()) {
            let mut p = self.popups.remove(index);
            self.release_target(&mut p.target);
            if p.announced {
                self.wire.json(serde_json::json!({ "type": "close", "id": p.id }));
            }
            if p.grab {
                self.restore_keyboard_focus();
            }
        }
    }
}

impl XdgDecorationHandler for State {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        toplevel.with_pending_state(|state| state.decoration_mode = Some(DecorationMode::ServerSide));
    }

    fn request_mode(&mut self, toplevel: ToplevelSurface, _mode: DecorationMode) {
        toplevel.with_pending_state(|state| state.decoration_mode = Some(DecorationMode::ServerSide));
        if toplevel.is_initial_configure_sent() {
            toplevel.send_pending_configure();
        }
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        self.request_mode(toplevel, DecorationMode::ServerSide);
    }
}

impl SeatHandler for State {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<Self> {
        &mut self.seat_state
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let client = focused.and_then(|surface| self.dh.get_client(surface.id()).ok());
        set_data_device_focus(&self.dh, seat, client);
    }

    fn cursor_image(&mut self, _seat: &Seat<Self>, image: CursorImageStatus) {
        match image {
            CursorImageStatus::Hidden => {
                self.cursor_surface = None;
                self.wire.json(serde_json::json!({ "type": "cursor-name", "name": "none" }));
            }
            CursorImageStatus::Named(icon) => {
                self.cursor_surface = None;
                self.wire.json(serde_json::json!({ "type": "cursor-name", "name": icon.name() }));
            }
            CursorImageStatus::Surface(surface) => {
                self.cursor_surface = Some(surface);
                self.render_cursor();
            }
        }
    }
}

impl TabletSeatHandler for State {}

impl DmabufHandler for State {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf_state
    }

    fn dmabuf_imported(&mut self, _global: &DmabufGlobal, dmabuf: Dmabuf, notifier: ImportNotifier) {
        let imported = self.gpu.as_mut().is_some_and(|gpu| gpu.renderer.import_dmabuf(&dmabuf, None).is_ok());
        if imported {
            let _ = notifier.successful::<Self>();
        } else {
            notifier.failed();
        }
    }
}

impl SelectionHandler for State {
    type SelectionUserData = Arc<String>;

    fn new_selection(&mut self, ty: SelectionTarget, source: Option<SelectionSource>, seat: Seat<Self>) {
        if ty != SelectionTarget::Clipboard {
            return;
        }
        let Some(source) = source else { return };
        let mimes = source.mime_types();
        let Some(mime) = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING"]
            .into_iter()
            .find(|m| mimes.iter().any(|have| have == m))
        else {
            return;
        };
        let Ok((mut reader, writer)) = std::io::pipe() else { return };
        if request_data_device_client_selection(&seat, mime.to_string(), OwnedFd::from(writer)).is_err() {
            return;
        }
        // The app writes at its own pace; read off the event loop.
        let tx = self.clipboard_tx.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if reader.by_ref().take(MAX_CLIPBOARD_BYTES).read_to_end(&mut bytes).is_ok() {
                if let Ok(text) = String::from_utf8(bytes) {
                    let _ = tx.send(text);
                }
            }
        });
    }

    fn send_selection(
        &mut self,
        _ty: SelectionTarget,
        _mime_type: String,
        fd: OwnedFd,
        _seat: Seat<Self>,
        user_data: &Arc<String>,
    ) {
        let text = user_data.clone();
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = std::fs::File::from(fd).write_all(text.as_bytes());
        });
    }
}

impl DataDeviceHandler for State {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device_state
    }
}

impl ClientDndGrabHandler for State {}
impl ServerDndGrabHandler for State {}

impl OutputHandler for State {}

delegate_compositor!(State);
delegate_shm!(State);
delegate_xdg_shell!(State);
delegate_xdg_decoration!(State);
delegate_seat!(State);
delegate_data_device!(State);
delegate_output!(State);
delegate_cursor_shape!(State);
delegate_dmabuf!(State);
