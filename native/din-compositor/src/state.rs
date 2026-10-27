//! Compositor state and the Wayland protocol handlers.
//!
//! Din owns window placement, stacking and decoration; this compositor
//! only tracks what clients map and relays it. Toplevels are told they're
//! tiled on every side (so toolkits drop their shadows and rounded corners)
//! and to use server-side decorations (Din draws the title bar), unless they
//! insist on drawing their own, which the shell is told about.

use std::{borrow::Cow, os::fd::OwnedFd, sync::Arc, time::Instant};

use smithay::{
    backend::{
        allocator::dmabuf::Dmabuf,
        renderer::{ImportDma, pixman::PixmanRenderer, utils::on_commit_buffer_handler},
    },
    delegate_compositor, delegate_cursor_shape, delegate_data_control, delegate_data_device, delegate_dmabuf,
    delegate_ext_data_control, delegate_output, delegate_seat, delegate_shm, delegate_xdg_decoration, delegate_xdg_shell,
    delegate_xwayland_shell,
    desktop::{PopupKind, PopupManager, Window, utils::bbox_from_surface_tree},
    input::{
        Seat, SeatHandler, SeatState,
        keyboard::{KeyboardTarget, KeysymHandle, ModifiersState, XkbConfig},
        pointer::CursorImageStatus,
    },
    output::{Mode, Output, PhysicalProperties, Scale, Subpixel},
    reexports::{
        calloop::{LoopHandle, channel::Sender},
        wayland_protocols::xdg::{
            decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode as DecorationMode,
            shell::server::xdg_toplevel,
        },
        wayland_server::{
            Client, DisplayHandle, Resource,
            backend::{ClientData, ClientId, DisconnectReason},
            protocol::{wl_buffer, wl_output, wl_seat, wl_surface::WlSurface},
        },
    },
    backend::input::KeyState,
    utils::{IsAlive, Logical, Point, Rectangle, Serial, Size, Transform},
    xwayland::{X11Surface, X11Wm, XWaylandClientData},
    wayland::{
        seat::WaylandFocus,
        xwayland_shell::{XWaylandShellHandler, XWaylandShellState},
        buffer::BufferHandler,
        compositor::{CompositorClientState, CompositorHandler, CompositorState, get_parent},
        cursor_shape::CursorShapeManagerState,
        dmabuf::{DmabufFeedbackBuilder, DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
        output::{OutputHandler, OutputManagerState},
        pointer_constraints::PointerConstraintsState,
        relative_pointer::RelativePointerManagerState,
        selection::{
            SelectionHandler, SelectionSource, SelectionTarget,
            data_device::{
                ClientDndGrabHandler, DataDeviceHandler, DataDeviceState, ServerDndGrabHandler,
                request_data_device_client_selection, set_data_device_focus,
            },
            ext_data_control::{
                DataControlHandler as ExtDataControlHandler, DataControlState as ExtDataControlState,
            },
            wlr_data_control::{DataControlHandler, DataControlState},
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
    clipboard::{Contents, read_from_app},
    frames::FrameServer,
    gpu::{BufferChannel, Gpu, Target},
    stats::Stats,
    wire::Wire,
};

/// Window ids start here, clear of X11 resource ids (29-bit), so the shell
/// can tell the two servers' windows apart.
const FIRST_ID: u32 = 0x4000_0001;

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}

/// An xdg toplevel, or an X11 window managed through Xwayland (xwayland.rs).
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
    /// An xdg toplevel draws its own decorations: it never asked for a
    /// decoration object (GTK3, libadwaita), or asked for client-side ones.
    /// X11 windows say so in their Motif hints instead.
    pub client_side: bool,
    /// Whether the shell was last told the app decorates itself.
    pub csd: bool,
}

impl Toplevel {
    pub fn new(id: u32, window: Window, pos: Point<i32, Logical>) -> Self {
        Self {
            id,
            window,
            pos,
            announced: false,
            canvas: None,
            target: None,
            dirty: false,
            title: String::new(),
            known_size: None,
            client_side: true,
            csd: false,
        }
    }

    /// The window's surface; an X11 window has none until Xwayland
    /// associates one.
    pub fn wl_surface(&self) -> Option<WlSurface> {
        self.window.wl_surface().map(|s| s.into_owned())
    }

    pub fn x11(&self) -> Option<&X11Surface> {
        self.window.x11_surface()
    }
}

/// What a popup is on the protocol side.
pub enum PopupShell {
    /// An xdg popup, placed relative to its parent by its positioner.
    Xdg { kind: PopupKind, parent: WlSurface },
    /// An X11 override-redirect window (a menu, a tooltip), which places
    /// itself in root coordinates.
    X11(X11Surface),
}

pub struct Popup {
    pub id: u32,
    pub shell: PopupShell,
    /// Position relative to the parent's window geometry, from the positioner.
    pub rel: Point<i32, Logical>,
    /// Root position of the popup's window geometry corner.
    pub pos: Point<i32, Logical>,
    /// A menu: it closes when clicked outside.
    pub grab: bool,
    pub announced: bool,
    pub canvas: Option<Canvas>,
    pub target: Option<Target>,
    pub dirty: bool,
}

impl Popup {
    pub fn new(id: u32, shell: PopupShell, pos: Point<i32, Logical>, grab: bool) -> Self {
        Self { id, shell, rel: (0, 0).into(), pos, grab, announced: false, canvas: None, target: None, dirty: false }
    }

    pub fn wl_surface(&self) -> Option<WlSurface> {
        match &self.shell {
            PopupShell::Xdg { kind, .. } => Some(kind.wl_surface().clone()),
            PopupShell::X11(x11) => x11.wl_surface(),
        }
    }

    /// The popup's window geometry, relative to its surface.
    pub fn geometry(&self) -> Rectangle<i32, Logical> {
        match &self.shell {
            PopupShell::Xdg { kind, .. } => {
                let geometry = kind.geometry();
                if geometry.size.w > 0 && geometry.size.h > 0 {
                    geometry
                } else {
                    bbox_from_surface_tree(kind.wl_surface(), (0, 0))
                }
            }
            PopupShell::X11(x11) => Rectangle::from_size(x11.geometry().size),
        }
    }
}

/// Whoever has the keyboard. An X11 window must be focused on the X side too
/// (SetInputFocus, WM_TAKE_FOCUS), which its own KeyboardTarget does.
#[derive(Debug, Clone, PartialEq)]
pub enum KeyboardFocus {
    Wayland(WlSurface),
    X11(X11Surface),
}

impl WaylandFocus for KeyboardFocus {
    fn wl_surface(&self) -> Option<Cow<'_, WlSurface>> {
        match self {
            Self::Wayland(surface) => Some(Cow::Borrowed(surface)),
            Self::X11(x11) => x11.wl_surface().map(Cow::Owned),
        }
    }
}

impl IsAlive for KeyboardFocus {
    fn alive(&self) -> bool {
        match self {
            Self::Wayland(surface) => surface.alive(),
            Self::X11(x11) => x11.alive(),
        }
    }
}

impl KeyboardTarget<State> for KeyboardFocus {
    fn enter(&self, seat: &Seat<State>, data: &mut State, keys: Vec<KeysymHandle<'_>>, serial: Serial) {
        match self {
            Self::Wayland(surface) => KeyboardTarget::enter(surface, seat, data, keys, serial),
            Self::X11(x11) => KeyboardTarget::enter(x11, seat, data, keys, serial),
        }
    }

    fn leave(&self, seat: &Seat<State>, data: &mut State, serial: Serial) {
        match self {
            Self::Wayland(surface) => KeyboardTarget::leave(surface, seat, data, serial),
            Self::X11(x11) => KeyboardTarget::leave(x11, seat, data, serial),
        }
    }

    fn key(
        &self,
        seat: &Seat<State>,
        data: &mut State,
        key: KeysymHandle<'_>,
        state: KeyState,
        serial: Serial,
        time: u32,
    ) {
        match self {
            Self::Wayland(surface) => KeyboardTarget::key(surface, seat, data, key, state, serial, time),
            Self::X11(x11) => KeyboardTarget::key(x11, seat, data, key, state, serial, time),
        }
    }

    fn modifiers(&self, seat: &Seat<State>, data: &mut State, modifiers: ModifiersState, serial: Serial) {
        match self {
            Self::Wayland(surface) => KeyboardTarget::modifiers(surface, seat, data, modifiers, serial),
            Self::X11(x11) => KeyboardTarget::modifiers(x11, seat, data, modifiers, serial),
        }
    }
}

pub struct State {
    pub dh: DisplayHandle,
    pub start: Instant,
    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
    pub shm_state: ShmState,
    pub seat_state: SeatState<State>,
    pub data_device_state: DataDeviceState,
    /// Copying and pasting without a window (wl-copy, wl-paste).
    pub data_control_state: DataControlState,
    pub ext_data_control_state: ExtDataControlState,
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
    /// What apps copied, and whether it came from X.
    pub clipboard_tx: Sender<(Contents, bool)>,
    pub handle: LoopHandle<'static, State>,
    pub xwayland_shell_state: XWaylandShellState,
    /// The X11 window manager, once Xwayland is up (xwayland.rs).
    pub xwm: Option<X11Wm>,
    /// What was last put on (or read from) the X clipboard.
    pub x11_clipboard: Option<Arc<Contents>>,
    /// Files being dragged in from the shell (they stay readable after the
    /// drop, until the app has them), and whether the drag is under way.
    pub drag: Option<Arc<Contents>>,
    pub dragging: bool,
    /// The surface under the pointer and its root origin.
    pub pointer_focus: Option<(WlSurface, Point<f64, Logical>)>,
    /// The window the shell was told holds a pointer lock (0: none).
    pub pointer_lock: u32,
    /// The user ended a lock; constraints wait for their next click.
    pub constraint_released: bool,
    // Held only so their globals stay advertised.
    _relative_pointer_state: RelativePointerManagerState,
    _pointer_constraints_state: PointerConstraintsState,
}

impl State {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        dh: &DisplayHandle,
        handle: LoopHandle<'static, State>,
        screen: Size<i32, Logical>,
        frames: FrameServer,
        gpu: Option<Gpu>,
        buffers: Option<BufferChannel>,
        clipboard_tx: Sender<(Contents, bool)>,
    ) -> Self {
        let compositor_state = CompositorState::new::<Self>(dh);
        let xdg_shell_state = XdgShellState::new::<Self>(dh);
        let shm_state = ShmState::new::<Self>(dh, vec![]);
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<Self>(dh);
        let data_control_state = DataControlState::new::<Self, _>(dh, None, |_| true);
        let ext_data_control_state = ExtDataControlState::new::<Self, _>(dh, None, |_| true);
        let decoration_state = XdgDecorationState::new::<Self>(dh);
        let cursor_shape_state = CursorShapeManagerState::new::<Self>(dh);
        let xwayland_shell_state = XWaylandShellState::new::<Self>(dh);

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
            data_control_state,
            ext_data_control_state,
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
            handle,
            xwayland_shell_state,
            xwm: None,
            x11_clipboard: None,
            drag: None,
            dragging: false,
            pointer_focus: None,
            pointer_lock: 0,
            constraint_released: false,
            _relative_pointer_state: RelativePointerManagerState::new::<Self>(dh),
            _pointer_constraints_state: PointerConstraintsState::new::<Self>(dh),
        }
    }

    pub fn allocate_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Root position of a surface's window geometry corner (toplevel or popup).
    pub fn geometry_origin(&self, surface: &WlSurface) -> Point<i32, Logical> {
        if let Some(t) = self.toplevel_for(surface) {
            return t.pos;
        }
        if let Some(p) = self.popup_for(surface) {
            return p.pos;
        }
        (0, 0).into()
    }

    pub fn toplevel_for(&self, surface: &WlSurface) -> Option<&Toplevel> {
        self.toplevels.iter().find(|t| t.wl_surface().as_ref() == Some(surface))
    }

    pub fn popup_for(&self, surface: &WlSurface) -> Option<&Popup> {
        self.popups.iter().find(|p| p.wl_surface().as_ref() == Some(surface))
    }

    fn xdg_toplevel_mut(&mut self, surface: &ToplevelSurface) -> Option<&mut Toplevel> {
        self.toplevels.iter_mut().find(|t| t.window.toplevel() == Some(surface))
    }

    /// Tell the shell about a request from a window's own decorations (a
    /// title-bar drag, its maximize button), if the shell knows the window.
    pub fn window_request(&mut self, id: u32, mut message: serde_json::Value) {
        if !self.toplevels.iter().any(|t| t.id == id && t.announced) {
            return;
        }
        message["id"] = id.into();
        self.wire.json(message);
    }

    /// Forget a toplevel (destroyed or unmapped), telling the shell.
    pub fn remove_toplevel(&mut self, index: usize) {
        let mut t = self.toplevels.remove(index);
        self.release_target(&mut t.target);
        if t.announced {
            self.wire.json(serde_json::json!({ "type": "close", "id": t.id }));
        }
        if self.focused == t.id {
            self.focused = 0;
        }
    }

    /// Forget a popup, telling the shell.
    pub fn remove_popup(&mut self, index: usize) {
        let mut p = self.popups.remove(index);
        self.release_target(&mut p.target);
        if p.announced {
            self.wire.json(serde_json::json!({ "type": "close", "id": p.id }));
        }
        // An xdg menu took the keyboard; X menus grab it on the X side.
        if p.grab && matches!(p.shell, PopupShell::Xdg { .. }) {
            self.restore_keyboard_focus();
        }
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
        if let Some(xwayland) = client.get_data::<XWaylandClientData>() {
            return &xwayland.compositor_state;
        }
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
        if let Some(t) = self.toplevels.iter_mut().find(|t| t.wl_surface().as_ref() == Some(&root)) {
            t.window.on_commit();
            if let Some(toplevel) = t.window.toplevel() {
                if !toplevel.is_initial_configure_sent() {
                    toplevel.send_configure();
                }
            }
            t.dirty = true;
        } else if let Some(p) = self.popups.iter_mut().find(|p| p.wl_surface().as_ref() == Some(&root)) {
            if let PopupShell::Xdg { kind: PopupKind::Xdg(xdg), .. } = &p.shell {
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
        let pos = (80 + offset, 80 + offset).into();
        self.toplevels.push(Toplevel::new(id, Window::new_wayland_window(surface), pos));
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        let index = self.toplevels.iter().position(|t| t.window.toplevel() == Some(&surface));
        if let Some(index) = index {
            self.remove_toplevel(index);
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
        let mut popup = Popup::new(id, PopupShell::Xdg { kind, parent }, origin + geometry.loc, false);
        popup.rel = geometry.loc;
        self.popups.push(popup);
    }

    fn reposition_request(&mut self, surface: PopupSurface, positioner: PositionerState, token: u32) {
        let geometry = self.place_popup(&surface, positioner);
        surface.with_pending_state(|state| {
            state.geometry = geometry;
            state.positioner = positioner;
        });
        surface.send_repositioned(token);
        let wl_surface = Some(surface.wl_surface().clone());
        if let Some(p) = self.popups.iter_mut().find(|p| p.wl_surface() == wl_surface) {
            p.rel = geometry.loc;
        }
        self.relayout_popups();
    }

    fn grab(&mut self, surface: PopupSurface, _seat: wl_seat::WlSeat, _serial: Serial) {
        // A grabbing popup is a menu: it takes the keyboard, and the shell
        // forwards clicks anywhere so it can dismiss it.
        let wl_surface = surface.wl_surface().clone();
        if let Some(p) = self.popups.iter_mut().find(|p| p.wl_surface().as_ref() == Some(&wl_surface)) {
            p.grab = true;
        }
        if let Some(keyboard) = self.seat.get_keyboard() {
            keyboard.set_focus(self, Some(KeyboardFocus::Wayland(wl_surface)), Serial::from(0));
        }
    }

    fn popup_destroyed(&mut self, surface: PopupSurface) {
        let wl_surface = Some(surface.wl_surface().clone());
        if let Some(index) = self.popups.iter().position(|p| p.wl_surface() == wl_surface) {
            self.remove_popup(index);
        }
    }

    // A client-side title bar asks Din to move, resize, maximize or minimize
    // its window; the shell owns all of that.

    fn move_request(&mut self, surface: ToplevelSurface, _seat: wl_seat::WlSeat, _serial: Serial) {
        let Some(id) = self.xdg_toplevel_mut(&surface).map(|t| t.id) else { return };
        self.window_request(id, serde_json::json!({ "type": "move" }));
    }

    fn resize_request(
        &mut self,
        surface: ToplevelSurface,
        _seat: wl_seat::WlSeat,
        _serial: Serial,
        edges: xdg_toplevel::ResizeEdge,
    ) {
        use xdg_toplevel::ResizeEdge as E;
        let edge = match edges {
            E::Top => "n",
            E::Bottom => "s",
            E::Left => "w",
            E::Right => "e",
            E::TopLeft => "nw",
            E::TopRight => "ne",
            E::BottomLeft => "sw",
            E::BottomRight => "se",
            _ => return,
        };
        let Some(id) = self.xdg_toplevel_mut(&surface).map(|t| t.id) else { return };
        self.window_request(id, serde_json::json!({ "type": "resize", "edge": edge }));
    }

    fn maximize_request(&mut self, surface: ToplevelSurface) {
        self.xdg_maximize_request(surface, true);
    }

    fn unmaximize_request(&mut self, surface: ToplevelSurface) {
        self.xdg_maximize_request(surface, false);
    }

    fn minimize_request(&mut self, surface: ToplevelSurface) {
        let Some(id) = self.xdg_toplevel_mut(&surface).map(|t| t.id) else { return };
        self.window_request(id, serde_json::json!({ "type": "minimize" }));
    }

    // The output asked for is ignored: the shell puts the window on the
    // monitor it's on.
    fn fullscreen_request(&mut self, surface: ToplevelSurface, _output: Option<wl_output::WlOutput>) {
        self.xdg_fullscreen_request(surface, true);
    }

    fn unfullscreen_request(&mut self, surface: ToplevelSurface) {
        self.xdg_fullscreen_request(surface, false);
    }
}

impl State {
    /// The protocol wants a configure in reply either way; the shell's
    /// answer, if it changes anything, comes as a "state" message.
    fn xdg_maximize_request(&mut self, surface: ToplevelSurface, maximized: bool) {
        if surface.is_initial_configure_sent() {
            surface.send_configure();
        }
        let Some(id) = self.xdg_toplevel_mut(&surface).map(|t| t.id) else { return };
        self.window_request(id, serde_json::json!({ "type": "maximize", "maximized": maximized }));
    }

    /// As for maximize; the shell answers with a "fullscreen" message.
    fn xdg_fullscreen_request(&mut self, surface: ToplevelSurface, fullscreen: bool) {
        if surface.is_initial_configure_sent() {
            surface.send_configure();
        }
        let Some(id) = self.xdg_toplevel_mut(&surface).map(|t| t.id) else { return };
        self.window_request(id, serde_json::json!({ "type": "fullscreen", "fullscreen": fullscreen }));
    }
}

/// Din's title bar is the default; an app that asks to draw its own gets
/// to, and the shell drops its title bar for it.
impl XdgDecorationHandler for State {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        if let Some(t) = self.xdg_toplevel_mut(&toplevel) {
            t.client_side = false;
        }
        toplevel.with_pending_state(|state| state.decoration_mode = Some(DecorationMode::ServerSide));
    }

    fn request_mode(&mut self, toplevel: ToplevelSurface, mode: DecorationMode) {
        if let Some(t) = self.xdg_toplevel_mut(&toplevel) {
            t.client_side = mode == DecorationMode::ClientSide;
        }
        toplevel.with_pending_state(|state| state.decoration_mode = Some(mode));
        if toplevel.is_initial_configure_sent() {
            toplevel.send_pending_configure();
        }
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        self.request_mode(toplevel, DecorationMode::ServerSide);
    }
}

impl SeatHandler for State {
    type KeyboardFocus = KeyboardFocus;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<Self> {
        &mut self.seat_state
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&KeyboardFocus>) {
        let surface = focused.and_then(|focus| focus.wl_surface());
        let client = surface.and_then(|surface| self.dh.get_client(surface.id()).ok());
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
    type SelectionUserData = Arc<Contents>;

    /// A Wayland app copied: read what Din can use and hand it on.
    fn new_selection(&mut self, ty: SelectionTarget, source: Option<SelectionSource>, _seat: Seat<Self>) {
        if ty != SelectionTarget::Clipboard {
            return;
        }
        let Some(source) = source else { return };
        let offered = source.mime_types();
        // This runs before the seat takes the new selection, so a read now
        // would go to the previous one: wait until it has.
        self.handle.insert_idle(move |state| {
            let tx = state.clipboard_tx.clone();
            read_from_app(
                &offered,
                &["text/plain;charset=utf-8", "UTF8_STRING", "text/plain", "STRING"],
                |mime, fd| request_data_device_client_selection(&state.seat, mime.to_string(), fd).is_ok(),
                move |contents| {
                    let _ = tx.send((contents, false));
                },
            );
        });
    }

    /// A Wayland app pastes Din's clipboard.
    fn send_selection(
        &mut self,
        _ty: SelectionTarget,
        mime_type: String,
        fd: OwnedFd,
        _seat: Seat<Self>,
        user_data: &Arc<Contents>,
    ) {
        user_data.send(&mime_type, fd);
    }
}

impl DataDeviceHandler for State {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device_state
    }
}

impl DataControlHandler for State {
    fn data_control_state(&self) -> &DataControlState {
        &self.data_control_state
    }
}

impl ExtDataControlHandler for State {
    fn data_control_state(&self) -> &ExtDataControlState {
        &self.ext_data_control_state
    }
}

impl ClientDndGrabHandler for State {}

/// A drag from the shell (Files) into an app.
impl ServerDndGrabHandler for State {
    fn send(&mut self, mime_type: String, fd: OwnedFd, _seat: Seat<Self>) {
        if let Some(drag) = &self.drag {
            drag.send(&mime_type, fd);
        }
    }

    fn dropped(&mut self, _seat: Seat<Self>) {
        self.dragging = false;
    }

    fn cancelled(&mut self, _seat: Seat<Self>) {
        self.dragging = false;
    }
}

impl OutputHandler for State {}

impl XWaylandShellHandler for State {
    fn xwayland_shell_state(&mut self) -> &mut XWaylandShellState {
        &mut self.xwayland_shell_state
    }
}

delegate_compositor!(State);
delegate_shm!(State);
delegate_xdg_shell!(State);
delegate_xdg_decoration!(State);
delegate_seat!(State);
delegate_data_device!(State);
delegate_data_control!(State);
delegate_ext_data_control!(State);
delegate_output!(State);
delegate_cursor_shape!(State);
delegate_dmabuf!(State);
delegate_xwayland_shell!(State);
