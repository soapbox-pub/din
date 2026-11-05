//! The session's state, and the protocol handlers that aren't about windows
//! (shell.rs) or the wlroots extras (their own modules).

use std::{os::fd::OwnedFd, sync::OnceLock};

use smithay::{
    backend::{
        allocator::dmabuf::Dmabuf,
        renderer::{ImportDma, ImportMemWl},
    },
    delegate_data_control, delegate_data_device, delegate_dmabuf, delegate_fractional_scale, delegate_output,
    delegate_pointer_constraints, delegate_pointer_gestures, delegate_presentation, delegate_primary_selection,
    delegate_relative_pointer, delegate_seat, delegate_virtual_keyboard_manager, delegate_shm, delegate_single_pixel_buffer, delegate_viewporter,
    desktop::{PopupManager, Space, Window},
    input::{
        Seat, SeatHandler, SeatState,
        keyboard::{Keysym, XkbConfig},
        pointer::{CursorImageStatus, CursorImageSurfaceData, PointerHandle},
    },
    reexports::{
        calloop::{LoopHandle, LoopSignal},
        wayland_server::{
            Display, DisplayHandle, Resource,
            backend::{ClientData, ClientId, DisconnectReason},
            protocol::{wl_data_source::WlDataSource, wl_surface::WlSurface},
        },
    },
    utils::{Clock, Logical, Monotonic, Point, Rectangle},
    wayland::{
        buffer::BufferHandler,
        compositor::{CompositorClientState, CompositorState, with_states},
        dmabuf::{DmabufFeedbackBuilder, DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
        fractional_scale::{FractionalScaleHandler, FractionalScaleManagerState},
        output::{OutputHandler, OutputManagerState},
        pointer_constraints::{PointerConstraintsHandler, PointerConstraintsState, with_pointer_constraint},
        pointer_gestures::PointerGesturesState,
        presentation::PresentationState,
        relative_pointer::RelativePointerManagerState,
        selection::{
            SelectionHandler,
            data_device::{
                ClientDndGrabHandler, DataDeviceHandler, DataDeviceState, ServerDndGrabHandler,
                set_data_device_focus,
            },
            primary_selection::{PrimarySelectionHandler, PrimarySelectionState, set_primary_focus},
            wlr_data_control::{DataControlHandler, DataControlState},
        },
        shell::xdg::{XdgShellState, decoration::XdgDecorationState},
        shm::{ShmHandler, ShmState},
        single_pixel_buffer::SinglePixelBufferState,
        viewporter::ViewporterState,
        virtual_keyboard::VirtualKeyboardManagerState,
    },
};

use tracing::{info, warn};

use super::{accessibility, cursor, direct, drm, gamma, layouts, mouse, output_management, screencopy, shake, shell, virtual_output, virtual_pointer};

/// CLOCK_MONOTONIC, the clock presentation times are in.
const CLOCK_MONOTONIC: u32 = 1;

#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
    /// Its process, for the log when it goes.
    pub pid: OnceLock<i32>,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}

    /// Logged, as losing Din's connection takes the whole session with it.
    /// "Closed" is either the client hanging up or this side giving up on
    /// it (events it didn't read past the buffer's limit, see mod.rs).
    fn disconnected(&self, _client_id: ClientId, reason: DisconnectReason) {
        let pid = self.pid.get().copied().unwrap_or(0);
        match reason {
            DisconnectReason::ConnectionClosed => info!("client {pid}: connection closed"),
            DisconnectReason::ProtocolError(err) => warn!("client {pid}: disconnected for a protocol error: {err}"),
        }
    }
}

/// A drag's icon, drawn under the pointer, OFFSET from its hotspot.
pub struct DndIcon {
    pub surface: WlSurface,
    pub offset: Point<i32, Logical>,
}

// Some protocol states are only kept for the globals they hold.
#[allow(dead_code)]
pub struct State {
    pub dh: DisplayHandle,
    pub handle: LoopHandle<'static, State>,
    pub signal: LoopSignal,
    pub clock: Clock<Monotonic>,
    /// The session program's exit status, once it has exited.
    pub exit_code: i32,

    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
    pub xdg_decoration_state: XdgDecorationState,
    pub shm_state: ShmState,
    pub dmabuf_state: DmabufState,
    pub dmabuf_global: Option<DmabufGlobal>,
    pub output_manager_state: OutputManagerState,
    pub seat_state: SeatState<State>,
    pub data_device_state: DataDeviceState,
    pub primary_selection_state: PrimarySelectionState,
    pub data_control_state: DataControlState,
    pub presentation_state: PresentationState,
    pub fractional_scale_state: FractionalScaleManagerState,
    pub viewporter_state: ViewporterState,
    pub single_pixel_buffer_state: SinglePixelBufferState,
    pub pointer_gestures_state: PointerGesturesState,
    pub relative_pointer_state: RelativePointerManagerState,
    pub pointer_constraints_state: PointerConstraintsState,

    pub seat: Seat<State>,
    /// Din's window (the only one) and the displays, in layout coordinates.
    pub space: Space<Window>,
    pub popups: PopupManager,
    /// Toplevels not shown yet, and what Din asked for.
    pub pending: shell::Pending,
    pub cursor_status: CursorImageStatus,
    pub cursor: cursor::Cursors,
    pub shake: shake::Shake,
    pub mouse: mouse::Mouse,
    pub accessibility: accessibility::Accessibility,
    /// The keymap the keyboard has, as XKB_DEFAULT_* has it (layouts.rs).
    pub keymap: layouts::Keymap,
    pub dnd_icon: Option<DndIcon>,
    /// Keys the compositor took (a VT switch), whose release it takes too.
    pub suppressed_keys: Vec<Keysym>,
    /// Mice and touchpads plugged in; with none, there's no pointer to draw.
    pub pointer_devices: usize,

    pub backend: drm::Backend,
    pub output_management: output_management::OutputManagement,
    pub screencopy: screencopy::Screencopy,
    pub gamma: gamma::GammaControl,
    /// A full-screen game's frames, shown over Din's window (direct.rs).
    pub direct: direct::Direct,
    /// The session program's process: Din.
    pub din_pid: u32,
}

impl State {
    pub fn new(
        display: &Display<State>,
        handle: LoopHandle<'static, State>,
        signal: LoopSignal,
    ) -> Result<State, String> {
        let dh = display.handle();
        let backend = drm::Backend::new(&handle)?;

        let compositor_state = CompositorState::new::<State>(&dh);
        let xdg_shell_state = XdgShellState::new::<State>(&dh);
        let xdg_decoration_state = XdgDecorationState::new::<State>(&dh);
        let shm_state = ShmState::new::<State>(&dh, Vec::new());
        let output_manager_state = OutputManagerState::new_with_xdg_output::<State>(&dh);
        let mut seat_state = SeatState::new();
        let data_device_state = DataDeviceState::new::<State>(&dh);
        let primary_selection_state = PrimarySelectionState::new::<State>(&dh);
        let data_control_state = DataControlState::new::<State, _>(&dh, Some(&primary_selection_state), |_| true);
        let presentation_state = PresentationState::new::<State>(&dh, CLOCK_MONOTONIC);
        let fractional_scale_state = FractionalScaleManagerState::new::<State>(&dh);
        let viewporter_state = ViewporterState::new::<State>(&dh);
        let single_pixel_buffer_state = SinglePixelBufferState::new::<State>(&dh);
        let pointer_gestures_state = PointerGesturesState::new::<State>(&dh);
        let relative_pointer_state = RelativePointerManagerState::new::<State>(&dh);
        let pointer_constraints_state = PointerConstraintsState::new::<State>(&dh);
        // For wtype and wlrctl, in the debug image alone (os/debug.nix). Every
        // process of the user's can open the socket, and a keyboard and pointer
        // it drives could type into a Terminal or press Allow on a sudo prompt.
        if std::env::var_os("DIN_COMPOSITOR_VIRTUAL_INPUT").is_some_and(|value| value == "1") {
            VirtualKeyboardManagerState::new::<State, _>(&dh, |_| true);
            virtual_pointer::create_global(&dh);
        }
        virtual_output::create_global(&dh);

        let mut seat = seat_state.new_wl_seat(&dh, backend.seat_name());
        let xkb = xkb_config();
        seat.add_keyboard(
            XkbConfig {
                rules: &xkb[0],
                model: &xkb[1],
                layout: &xkb[2],
                variant: &xkb[3],
                options: if xkb[4].is_empty() { None } else { Some(xkb[4].clone()) },
            },
            600,
            25,
        )
        .map_err(|err| format!("the keyboard layout: {err}"))?;
        seat.add_pointer();
        seat.add_touch();

        let output_management = output_management::OutputManagement::new(&dh);
        let screencopy = screencopy::Screencopy::new(&dh);
        let gamma = gamma::GammaControl::new(&dh);

        let mut state = State {
            dh: dh.clone(),
            handle,
            signal,
            clock: Clock::new(),
            exit_code: 0,
            compositor_state,
            xdg_shell_state,
            xdg_decoration_state,
            shm_state,
            dmabuf_state: DmabufState::new(),
            dmabuf_global: None,
            output_manager_state,
            seat_state,
            data_device_state,
            primary_selection_state,
            data_control_state,
            presentation_state,
            fractional_scale_state,
            viewporter_state,
            single_pixel_buffer_state,
            pointer_gestures_state,
            relative_pointer_state,
            pointer_constraints_state,
            seat,
            space: Space::default(),
            popups: PopupManager::default(),
            pending: shell::Pending::default(),
            cursor_status: CursorImageStatus::default_named(),
            cursor: cursor::Cursors::load(),
            shake: shake::Shake::default(),
            mouse: mouse::Mouse::default(),
            accessibility: accessibility::Accessibility::default(),
            keymap: xkb,
            dnd_icon: None,
            suppressed_keys: Vec::new(),
            pointer_devices: 0,
            backend,
            output_management,
            screencopy,
            gamma,
            direct: direct::Direct::bind(),
            din_pid: 0,
        };

        let formats = state.backend.renderer.shm_formats();
        state.shm_state.update_formats(formats);
        let feedback = DmabufFeedbackBuilder::new(state.backend.render_node.dev_id(), state.backend.renderer.dmabuf_formats())
            .build()
            .map_err(|err| format!("dmabuf feedback: {err}"))?;
        state.dmabuf_global =
            Some(state.dmabuf_state.create_global_with_default_feedback::<State>(&dh, &feedback));

        state.scan_connectors();
        Ok(state)
    }

    /// After each round of events: what the loop does between dispatches.
    pub fn refresh(&mut self) {
        self.space.refresh();
        self.popups.cleanup();
        let _ = self.dh.flush_clients();
    }

    /// Queues frames where the pointer is, once the current event is done:
    /// for handlers smithay calls with the pointer locked.
    pub fn redraw_pointer_later(&self) {
        self.handle.insert_idle(|state| state.queue_redraw_pointer());
    }

    /// The layout's bounding box: what Din's window covers.
    pub fn layout_box(&self) -> Rectangle<i32, Logical> {
        self.space
            .outputs()
            .filter_map(|o| self.space.output_geometry(o))
            .reduce(|a, b| a.merge(b))
            .unwrap_or_else(|| Rectangle::from_size((1, 1).into()))
    }

    /// Where on the layout a surface of Din's (the window or a popup) is.
    pub fn surface_origin(&self, surface: &WlSurface) -> Option<Point<i32, Logical>> {
        let window = self.space.elements().next()?;
        let root = window.toplevel()?.wl_surface().clone();
        let location = self.space.element_location(window)?;
        if &root == surface {
            return Some(location - window.geometry().loc);
        }
        PopupManager::popups_for_surface(&root)
            .find(|(popup, _)| popup.wl_surface() == surface)
            .map(|(popup, offset)| location + offset - popup.geometry().loc)
    }
}

/// The keyboard layout, as XKB_DEFAULT_* (os/din-keyboard.sh writes them to
/// the unit's environment): rules, model, layout, variant, options.
fn xkb_config() -> [String; 5] {
    ["RULES", "MODEL", "LAYOUT", "VARIANT", "OPTIONS"].map(|name| std::env::var(format!("XKB_DEFAULT_{name}")).unwrap_or_default())
}

impl BufferHandler for State {
    fn buffer_destroyed(&mut self, _buffer: &smithay::reexports::wayland_server::protocol::wl_buffer::WlBuffer) {}
}

impl ShmHandler for State {
    fn shm_state(&self) -> &ShmState {
        &self.shm_state
    }
}

impl DmabufHandler for State {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf_state
    }

    fn dmabuf_imported(&mut self, _global: &DmabufGlobal, dmabuf: Dmabuf, notifier: ImportNotifier) {
        if self.backend.renderer.import_dmabuf(&dmabuf, None).is_ok() {
            dmabuf.set_node(self.backend.render_node);
            let _ = notifier.successful::<State>();
        } else {
            notifier.failed();
        }
    }
}

impl OutputHandler for State {}

impl SeatHandler for State {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<State> {
        &mut self.seat_state
    }

    fn focus_changed(&mut self, seat: &Seat<State>, focused: Option<&WlSurface>) {
        let client = focused.and_then(|s| self.dh.get_client(s.id()).ok());
        set_data_device_focus(&self.dh, seat, client.clone());
        set_primary_focus(&self.dh, seat, client);
    }

    fn cursor_image(&mut self, _seat: &Seat<State>, image: CursorImageStatus) {
        // Its commits so far weren't uploaded: it wasn't the cursor yet.
        if let CursorImageStatus::Surface(surface) = &image {
            self.import_pointer_image(surface);
        }
        self.cursor_status = image;
        self.redraw_pointer_later();
    }

    fn led_state_changed(&mut self, _seat: &Seat<State>, led_state: smithay::input::keyboard::LedState) {
        for keyboard in &mut self.backend.keyboards {
            keyboard.led_update(led_state.into());
        }
    }
}

impl SelectionHandler for State {
    type SelectionUserData = ();
}

impl DataDeviceHandler for State {
    fn data_device_state(&self) -> &DataDeviceState {
        &self.data_device_state
    }
}

impl ClientDndGrabHandler for State {
    fn started(&mut self, _source: Option<WlDataSource>, icon: Option<WlSurface>, _seat: Seat<State>) {
        let offset = match &self.cursor_status {
            CursorImageStatus::Surface(surface) => with_states(surface, |states| {
                let hotspot = states
                    .data_map
                    .get::<CursorImageSurfaceData>()
                    .map(|data| data.lock().unwrap().hotspot)
                    .unwrap_or_default();
                Point::from((-hotspot.x, -hotspot.y))
            }),
            _ => (0, 0).into(),
        };
        self.dnd_icon = icon.map(|surface| DndIcon { surface, offset });
        self.redraw_pointer_later();
    }

    fn dropped(&mut self, _target: Option<WlSurface>, _validated: bool, _seat: Seat<State>) {
        self.dnd_icon = None;
        self.redraw_pointer_later();
    }
}

impl ServerDndGrabHandler for State {
    fn send(&mut self, _mime_type: String, _fd: OwnedFd, _seat: Seat<State>) {}
}

impl PrimarySelectionHandler for State {
    fn primary_selection_state(&self) -> &PrimarySelectionState {
        &self.primary_selection_state
    }
}

impl DataControlHandler for State {
    fn data_control_state(&self) -> &DataControlState {
        &self.data_control_state
    }
}

impl FractionalScaleHandler for State {}

impl PointerConstraintsHandler for State {
    fn new_constraint(&mut self, surface: &WlSurface, pointer: &PointerHandle<State>) {
        if pointer.current_focus().as_ref() == Some(surface) {
            with_pointer_constraint(surface, pointer, |constraint| {
                if let Some(constraint) = constraint {
                    constraint.activate();
                }
            });
            // A locked pointer isn't drawn (drm.rs, pointer_locked).
            self.redraw_pointer_later();
        }
    }

    fn cursor_position_hint(&mut self, surface: &WlSurface, pointer: &PointerHandle<State>, location: Point<f64, Logical>) {
        let active = with_pointer_constraint(surface, pointer, |constraint| constraint.is_some_and(|c| c.is_active()));
        if let (true, Some(origin)) = (active, self.surface_origin(surface)) {
            pointer.set_location(origin.to_f64() + location);
            self.queue_redraw_pointer();
        }
    }
}

delegate_shm!(State);
delegate_dmabuf!(State);
delegate_output!(State);
delegate_seat!(State);
delegate_data_device!(State);
delegate_primary_selection!(State);
delegate_data_control!(State);
delegate_presentation!(State);
delegate_fractional_scale!(State);
delegate_viewporter!(State);
delegate_single_pixel_buffer!(State);
delegate_pointer_gestures!(State);
delegate_relative_pointer!(State);
delegate_pointer_constraints!(State);
delegate_virtual_keyboard_manager!(State);
