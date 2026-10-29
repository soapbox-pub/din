//! The screen: the GPU's displays through DRM/KMS, and when frames go to them.
//!
//! One GPU drives everything: the seat's primary one (the one the firmware
//! showed the boot screen on), or failing that the first. Every connected
//! display on it is a head; enabled heads are outputs on the layout, each
//! with a DRM compositor that scans Din's buffer out directly when it can
//! and composites with GLES when it can't.
//!
//! Each output renders on demand. A commit, a moving pointer or a changed
//! cursor queues a frame, which is rendered and committed max_render_time
//! before the next refresh, extrapolated from the last one; while a frame
//! waits for its refresh, the next waits for that. At the refresh, clients
//! hear that their frame is on screen (frame callbacks and presentation
//! feedback), so they draw the next one in the time that's left.

use std::time::Duration;

use smithay::{
    backend::{
        allocator::{
            Fourcc,
            format::FormatSet,
            gbm::{GbmAllocator, GbmBufferFlags, GbmDevice},
        },
        drm::{
            DrmDevice, DrmDeviceFd, DrmEvent, DrmEventMetadata, DrmEventTime, DrmNode, NodeType,
            compositor::FrameFlags,
            exporter::gbm::GbmFramebufferExporter,
            output::{DrmOutput, DrmOutputManager, DrmOutputRenderElements},
        },
        egl::{EGLContext, EGLDevice, EGLDisplay, context::ContextPriority},
        input::InputEvent,
        libinput::{LibinputInputBackend, LibinputSessionInterface},
        renderer::{
            ImportDma,
            element::{
                RenderElementStates,
                utils::select_dmabuf_feedback,
            },
            gles::GlesRenderer,
        },
        session::{Event as SessionEvent, Session, libseat::LibSeatSession},
        udev::{UdevBackend, UdevEvent, all_gpus, primary_gpu},
    },
    desktop::{
        Space, Window,
        utils::{
            OutputPresentationFeedback, send_frames_surface_tree, surface_presentation_feedback_flags_from_states,
            surface_primary_scanout_output, update_surface_primary_scanout_output,
        },
    },
    input::pointer::CursorImageStatus,
    output::{Mode as WlMode, Output, PhysicalProperties, Scale, Subpixel},
    reexports::{
        calloop::{
            LoopHandle, RegistrationToken,
            timer::{TimeoutAction, Timer},
        },
        drm::control::{Device as ControlDevice, ModeTypeFlags, connector, crtc},
        input::{DeviceCapability, Libinput},
        rustix::fs::OFlags,
        wayland_protocols::wp::{
            linux_dmabuf::zv1::server::zwp_linux_dmabuf_feedback_v1, presentation_time::server::wp_presentation_feedback,
        },
        wayland_server::backend::GlobalId,
    },
    utils::{DeviceFd, Logical, Monotonic, Point, Time, Transform},
    wayland::{
        dmabuf::{DmabufFeedback, DmabufFeedbackBuilder},
        presentation::Refresh,
    },
};
use smithay_drm_extras::drm_scanner::{DrmScanEvent, DrmScanner};
use tracing::{debug, info, warn};

use super::{
    edid,
    render::{self, BACKDROP, OutputElement, Scene},
    state::State,
};

type Allocator = GbmAllocator<DrmDeviceFd>;
type Exporter = GbmFramebufferExporter<DrmDeviceFd>;
type Feedback = Option<OutputPresentationFeedback>;
type OutputManager = DrmOutputManager<Allocator, Exporter, Feedback, DrmDeviceFd>;
type Surface = DrmOutput<Allocator, Exporter, Feedback, DrmDeviceFd>;

/// Swapchain formats, in order of preference. 8-bit, like Din's own buffers.
const COLOR_FORMATS: [Fourcc; 2] = [Fourcc::Xrgb8888, Fourcc::Argb8888];

pub struct Backend {
    pub session: LibSeatSession,
    libinput: Libinput,
    /// For their LEDs (caps lock and the like).
    pub keyboards: Vec<smithay::reexports::input::Device>,
    node: DrmNode,
    pub render_node: DrmNode,
    pub renderer: GlesRenderer,
    drm: OutputManager,
    scanner: DrmScanner,
    pub heads: Vec<Head>,
    /// Whether the session has the GPU and input (not on another VT).
    pub active: bool,
    next_id: u64,
    /// How long before a refresh a frame is committed.
    max_render_time: Duration,
}

/// A connected display.
pub struct Head {
    /// Stays the same while the display is connected.
    pub id: u64,
    pub name: String,
    pub connector: connector::Handle,
    pub crtc: crtc::Handle,
    pub modes: Vec<smithay::reexports::drm::control::Mode>,
    pub info: edid::Info,
    /// Millimetres.
    pub physical_size: (i32, i32),
    pub output: Output,
    global: Option<GlobalId>,
    /// While enabled.
    pub screen: Option<Screen>,
    /// The configuration, kept while disabled.
    pub mode: smithay::reexports::drm::control::Mode,
    pub position: Point<i32, Logical>,
    pub scale: f64,
    pub transform: Transform,
    /// Entries per channel in the CRTC's gamma table; 0 without one.
    pub gamma_size: u32,
    /// A gamma table a client set (red, green, then blue), to restore after a VT switch.
    pub gamma: Option<Vec<u16>>,
}

/// An enabled head's DRM output and its frame schedule.
pub struct Screen {
    surface: Surface,
    feedback: Option<SurfaceFeedback>,
    redraw: Redraw,
    /// Stands in for the refresh after a frame that changed nothing.
    estimated_vblank: Option<RegistrationToken>,
    last_vblank: Option<Duration>,
    refresh: Duration,
}

impl Screen {
    /// When the next refresh after NOW is, from the last one.
    fn next_vblank(&self, now: Duration) -> Option<Duration> {
        let last = self.last_vblank.filter(|&last| now >= last)?;
        let refresh = self.refresh.max(Duration::from_micros(100));
        let periods = ((now - last).as_nanos() / refresh.as_nanos()) as u32 + 1;
        Some(last + refresh * periods)
    }

    fn cancel_timers(&mut self, handle: &LoopHandle<'static, State>) {
        if let Redraw::Scheduled(token) = std::mem::replace(&mut self.redraw, Redraw::Idle) {
            handle.remove(token);
        }
        if let Some(token) = self.estimated_vblank.take() {
            handle.remove(token);
        }
    }
}

/// Dmabuf feedback for surfaces drawn on an output: plain, or with a tranche
/// the display can scan out directly.
#[derive(Clone)]
struct SurfaceFeedback {
    render: DmabufFeedback,
    scanout: DmabufFeedback,
}

enum Redraw {
    Idle,
    /// A frame will be rendered when the timer fires.
    Scheduled(RegistrationToken),
    /// A frame waits for its refresh; AGAIN queues another after it.
    Flipping { again: bool },
}

impl Head {
    pub fn enabled(&self) -> bool {
        self.screen.is_some()
    }

    pub fn preferred(&self) -> Option<&smithay::reexports::drm::control::Mode> {
        self.modes.iter().find(|m| m.mode_type().contains(ModeTypeFlags::PREFERRED)).or(self.modes.first())
    }
}

impl Backend {
    pub fn new(handle: &LoopHandle<'static, State>) -> Result<Backend, String> {
        let (session, notifier) = LibSeatSession::new().map_err(|err| format!("no seat session: {err}"))?;
        let seat = session.seat();

        let path = primary_gpu(&seat)
            .ok()
            .flatten()
            .or_else(|| all_gpus(&seat).ok()?.into_iter().next())
            .ok_or("no GPU")?;
        let node = DrmNode::from_path(&path).map_err(|err| format!("{}: {err}", path.display()))?;
        let node = node.node_with_type(NodeType::Primary).and_then(Result::ok).unwrap_or(node);
        info!("using the GPU at {}", path.display());

        let mut session_handle = session.clone();
        let fd = session_handle
            .open(&path, OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOCTTY | OFlags::NONBLOCK)
            .map_err(|err| format!("opening {}: {err}", path.display()))?;
        let fd = DrmDeviceFd::new(DeviceFd::from(fd));
        // The boot screen's picture stays up until the first frame replaces it.
        let (drm, drm_notifier) = DrmDevice::new(fd.clone(), false).map_err(|err| format!("DRM: {err}"))?;
        let gbm = GbmDevice::new(fd).map_err(|err| format!("GBM: {err}"))?;

        // SAFETY: the display and context are only used on this thread.
        let egl = unsafe { EGLDisplay::new(gbm.clone()) }.map_err(|err| format!("EGL: {err}"))?;
        let render_node = EGLDevice::device_for_display(&egl)
            .ok()
            .and_then(|device| device.try_get_render_node().ok().flatten())
            .unwrap_or(node);
        let context =
            EGLContext::new_with_priority(&egl, ContextPriority::High).map_err(|err| format!("EGL context: {err}"))?;
        let renderer = unsafe { GlesRenderer::new(context) }.map_err(|err| format!("GLES: {err}"))?;
        let render_formats = renderer.egl_context().dmabuf_render_formats().clone();

        let allocator = GbmAllocator::new(gbm.clone(), GbmBufferFlags::RENDERING | GbmBufferFlags::SCANOUT);
        let exporter = GbmFramebufferExporter::new(gbm.clone(), Some(render_node));
        let drm = DrmOutputManager::new(drm, allocator, exporter, Some(gbm), COLOR_FORMATS, render_formats);

        handle
            .insert_source(drm_notifier, |event, metadata, state| match event {
                DrmEvent::VBlank(crtc) => state.on_vblank(crtc, metadata),
                DrmEvent::Error(err) => warn!("DRM: {err}"),
            })
            .map_err(|err| format!("DRM events: {err}"))?;

        let mut libinput =
            Libinput::new_with_udev::<LibinputSessionInterface<LibSeatSession>>(session.clone().into());
        libinput.udev_assign_seat(&seat).map_err(|()| "libinput couldn't take the seat".to_string())?;
        handle
            .insert_source(LibinputInputBackend::new(libinput.clone()), |mut event, _, state| {
                match &mut event {
                    InputEvent::DeviceAdded { device } => {
                        if device.has_capability(DeviceCapability::Keyboard) {
                            if let Some(keyboard) = state.seat.get_keyboard() {
                                device.led_update(keyboard.led_state().into());
                            }
                            state.backend.keyboards.push(device.clone());
                        }
                        if device.has_capability(DeviceCapability::Pointer) {
                            state.pointer_devices += 1;
                            state.queue_redraw_pointer();
                        }
                    }
                    InputEvent::DeviceRemoved { device } => {
                        state.backend.keyboards.retain(|k| k != device);
                        if device.has_capability(DeviceCapability::Pointer) {
                            state.pointer_devices = state.pointer_devices.saturating_sub(1);
                            state.queue_redraw_all();
                        }
                    }
                    _ => {}
                }
                state.process_input(event);
            })
            .map_err(|err| format!("libinput events: {err}"))?;

        handle
            .insert_source(notifier, |event, _, state| match event {
                SessionEvent::PauseSession => {
                    info!("the session is paused");
                    state.backend.active = false;
                    state.backend.libinput.suspend();
                    state.backend.drm.pause();
                    // Frames waiting for a refresh won't see it.
                    for head in &mut state.backend.heads {
                        if let Some(screen) = &mut head.screen {
                            screen.cancel_timers(&state.handle);
                        }
                    }
                }
                SessionEvent::ActivateSession => {
                    info!("the session is active again");
                    if state.backend.libinput.resume().is_err() {
                        warn!("libinput didn't resume");
                    }
                    if let Err(err) = state.backend.drm.activate(false) {
                        warn!("DRM didn't resume: {err}");
                    }
                    state.backend.active = true;
                    for head in &state.backend.heads {
                        if let Some(screen) = &head.screen {
                            screen.surface.reset_buffers();
                        }
                    }
                    state.restore_gamma();
                    state.scan_connectors();
                    state.queue_redraw_all();
                }
            })
            .map_err(|err| format!("session events: {err}"))?;

        let udev = UdevBackend::new(&seat).map_err(|err| format!("udev: {err}"))?;
        let dev_id = node.dev_id();
        handle
            .insert_source(udev, move |event, _, state| match event {
                UdevEvent::Changed { device_id } if device_id == dev_id => state.scan_connectors(),
                UdevEvent::Removed { device_id } if device_id == dev_id => warn!("the GPU went away"),
                _ => {}
            })
            .map_err(|err| format!("udev events: {err}"))?;

        let max_render_time = std::env::var("DIN_MAX_RENDER_TIME")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map_or(Duration::from_millis(4), Duration::from_millis);

        Ok(Backend {
            session,
            libinput,
            keyboards: Vec::new(),
            node,
            render_node,
            renderer,
            drm,
            scanner: DrmScanner::new(),
            heads: Vec::new(),
            active: true,
            next_id: 1,
            max_render_time,
        })
    }

    pub fn seat_name(&self) -> String {
        self.session.seat()
    }

    pub fn head(&self, id: u64) -> Option<&Head> {
        self.heads.iter().find(|h| h.id == id)
    }

    pub fn head_for_output(&self, output: &Output) -> Option<&Head> {
        self.heads.iter().find(|h| &h.output == output)
    }

    /// Sets a CRTC's gamma table, or the identity with RAMP None.
    pub fn set_gamma(&self, id: u64, ramp: Option<&[u16]>) -> Result<(), String> {
        let head = self.head(id).ok_or("no such display")?;
        let size = head.gamma_size as usize;
        if size == 0 {
            return Err("the display has no gamma table".into());
        }
        let identity: Vec<u16>;
        let ramp = match ramp {
            Some(ramp) if ramp.len() == size * 3 => ramp,
            Some(_) => return Err("the gamma table is the wrong size".into()),
            None => {
                let one: Vec<u16> =
                    (0..size).map(|i| ((i * 0xffff) / (size - 1).max(1)) as u16).collect();
                identity = [one.as_slice(), one.as_slice(), one.as_slice()].concat();
                &identity
            }
        };
        let (red, rest) = ramp.split_at(size);
        let (green, blue) = rest.split_at(size);
        self.drm.device().set_gamma(head.crtc, red, green, blue).map_err(|err| format!("setting gamma: {err}"))
    }

    fn surface_feedback(&mut self, surface: &Surface) -> Option<SurfaceFeedback> {
        let render_formats = self.renderer.dmabuf_formats();
        let scanout_formats = surface.with_compositor(|compositor| {
            let planes = compositor.surface().planes().clone();
            compositor
                .surface()
                .plane_info()
                .formats
                .iter()
                .copied()
                .chain(planes.overlay.into_iter().flat_map(|p| p.formats))
                .collect::<FormatSet>()
                .intersection(&render_formats)
                .copied()
                .collect::<FormatSet>()
        });
        let builder = DmabufFeedbackBuilder::new(self.render_node.dev_id(), render_formats);
        let render = builder.clone().build().ok()?;
        let scanout = builder
            .add_preference_tranche(
                self.node.dev_id(),
                Some(zwp_linux_dmabuf_feedback_v1::TrancheFlags::Scanout),
                scanout_formats,
            )
            .build()
            .ok()?;
        Some(SurfaceFeedback { render, scanout })
    }
}

fn mode_refresh(mode: &smithay::reexports::drm::control::Mode) -> Duration {
    let mhz = WlMode::from(*mode).refresh.max(1) as f64;
    Duration::from_secs_f64(1000.0 / mhz)
}

impl State {
    /// Picks up displays plugged in or unplugged.
    pub fn scan_connectors(&mut self) {
        let result = match self.backend.scanner.scan_connectors(self.backend.drm.device()) {
            Ok(result) => result,
            Err(err) => {
                warn!("scanning the displays: {err}");
                return;
            }
        };
        let mut changed = false;
        for event in result {
            match event {
                DrmScanEvent::Connected { connector, crtc: Some(crtc) } => {
                    self.add_head(connector, crtc);
                    changed = true;
                }
                DrmScanEvent::Connected { connector, crtc: None } => {
                    warn!("no CRTC is free for {:?}-{}", connector.interface(), connector.interface_id());
                }
                DrmScanEvent::Disconnected { connector, .. } => {
                    self.remove_head(connector.handle());
                    changed = true;
                }
            }
        }
        if changed {
            self.layout_changed();
        }
    }

    fn add_head(&mut self, connector: connector::Info, crtc: crtc::Handle) {
        let name = format!("{}-{}", connector.interface().as_str(), connector.interface_id());
        let modes = connector.modes().to_vec();
        if modes.is_empty() {
            warn!("{name} has no modes");
            return;
        }
        let device = self.backend.drm.device();
        let info = edid::for_connector(device, connector.handle());
        let gamma_size = device.get_crtc(crtc).map(|c| c.gamma_length()).unwrap_or(0);
        let (w, h) = connector.size().unwrap_or((0, 0));
        let output = Output::new(
            name.clone(),
            PhysicalProperties {
                size: (w as i32, h as i32).into(),
                subpixel: Subpixel::from(connector.subpixel()),
                make: info.make.clone(),
                model: info.model.clone(),
            },
        );
        let id = self.backend.next_id;
        self.backend.next_id += 1;
        let mode = *modes
            .iter()
            .find(|m| m.mode_type().contains(ModeTypeFlags::PREFERRED))
            .unwrap_or(&modes[0]);
        output.set_preferred(WlMode::from(mode));
        // To the right of the displays already on, as a new monitor goes;
        // Din puts back an arrangement it remembers.
        let x = self.layout_right();
        info!("{name} is connected ({} {}), at {}x{}", info.make, info.model, mode.size().0, mode.size().1);
        self.backend.heads.push(Head {
            id,
            name,
            connector: connector.handle(),
            crtc,
            modes,
            info,
            physical_size: (w as i32, h as i32),
            output,
            global: None,
            screen: None,
            mode,
            position: (x, 0).into(),
            scale: 1.0,
            transform: Transform::Normal,
            gamma_size,
            gamma: None,
        });
        if let Err(err) = self.enable_head(id) {
            warn!("{err}");
        }
    }

    fn remove_head(&mut self, connector: connector::Handle) {
        let Some(index) = self.backend.heads.iter().position(|h| h.connector == connector) else { return };
        let id = self.backend.heads[index].id;
        self.disable_head(id);
        let head = self.backend.heads.remove(index);
        info!("{} is disconnected", head.name);
        self.gamma.head_removed(id);
        self.screencopy.head_removed(id);
    }

    /// The right edge of the displays that are on.
    fn layout_right(&self) -> i32 {
        self.space
            .outputs()
            .filter_map(|o| self.space.output_geometry(o))
            .map(|g| g.loc.x + g.size.w)
            .max()
            .unwrap_or(0)
    }

    /// Lights head ID with its configuration (or applies it to a lit one).
    pub fn enable_head(&mut self, id: u64) -> Result<(), String> {
        let Some(index) = self.backend.heads.iter().position(|h| h.id == id) else {
            return Err("no such display".into());
        };
        let Backend { heads, drm, renderer, .. } = &mut self.backend;
        let head = &mut heads[index];
        let output = head.output.clone();
        output.change_current_state(
            Some(WlMode::from(head.mode)),
            Some(head.transform),
            Some(Scale::Fractional(head.scale)),
            Some(head.position),
        );
        let elements = DrmOutputRenderElements::<GlesRenderer, OutputElement>::default();
        if let Some(screen) = &mut head.screen {
            if screen.surface.with_compositor(|c| c.pending_mode()) != head.mode {
                screen
                    .surface
                    .use_mode(head.mode, renderer, &elements)
                    .map_err(|err| format!("{}: setting the mode: {err}", head.name))?;
                screen.refresh = mode_refresh(&head.mode);
                screen.last_vblank = None;
            }
        } else {
            let surface = drm
                .initialize_output::<_, OutputElement>(
                    head.crtc,
                    head.mode,
                    &[head.connector],
                    &output,
                    None,
                    renderer,
                    &elements,
                )
                .map_err(|err| format!("{}: lighting it: {err}", head.name))?;
            head.global = Some(output.create_global::<State>(&self.dh));
            head.screen = Some(Screen {
                surface,
                feedback: None,
                redraw: Redraw::Idle,
                estimated_vblank: None,
                last_vblank: None,
                refresh: mode_refresh(&head.mode),
            });
            info!("{} is on", head.name);
        }
        let position = head.position;
        // Which formats it can scan out may have changed with the mode.
        let screen = self.backend.heads[index].screen.take().unwrap();
        let feedback = self.backend.surface_feedback(&screen.surface);
        self.backend.heads[index].screen = Some(Screen { feedback, ..screen });
        self.space.map_output(&output, position);
        if let Some(gamma) = self.backend.heads[index].gamma.clone() {
            let _ = self.backend.set_gamma(id, Some(&gamma));
        }
        self.queue_redraw(id);
        Ok(())
    }

    /// Turns head ID off; it stays a head, for turning on again.
    pub fn disable_head(&mut self, id: u64) {
        let Some(head) = self.backend.heads.iter_mut().find(|h| h.id == id) else { return };
        let Some(mut screen) = head.screen.take() else { return };
        screen.cancel_timers(&self.handle);
        drop(screen);
        info!("{} is off", head.name);
        if let Some(global) = head.global.take() {
            // Clients get time to let go of the output before it's gone.
            self.dh.disable_global::<State>(global.clone());
            let dh = self.dh.clone();
            let _ = self.handle.insert_source(Timer::from_duration(Duration::from_secs(10)), move |_, _, _| {
                dh.remove_global::<State>(global.clone());
                TimeoutAction::Drop
            });
        }
        let output = head.output.clone();
        self.space.unmap_output(&output);
        self.screencopy.head_disabled(id);
    }

    /// Queues a frame for head ID.
    pub fn queue_redraw(&mut self, id: u64) {
        if !self.backend.active {
            return;
        }
        let now: Duration = self.clock.now().into();
        let max_render_time = self.backend.max_render_time;
        let Some(screen) = self.backend.heads.iter_mut().find(|h| h.id == id).and_then(|h| h.screen.as_mut()) else {
            return;
        };
        match &mut screen.redraw {
            Redraw::Scheduled(_) => {}
            Redraw::Flipping { again } => *again = true,
            Redraw::Idle => {
                let delay = screen
                    .next_vblank(now)
                    .map_or(Duration::ZERO, |next| next.saturating_sub(max_render_time).saturating_sub(now));
                let token = self
                    .handle
                    .insert_source(Timer::from_duration(delay), move |_, _, state| {
                        state.render(id);
                        TimeoutAction::Drop
                    })
                    .expect("frame timer");
                screen.redraw = Redraw::Scheduled(token);
            }
        }
    }

    pub fn queue_redraw_all(&mut self) {
        let ids: Vec<u64> = self.backend.heads.iter().filter(|h| h.enabled()).map(|h| h.id).collect();
        for id in ids {
            self.queue_redraw(id);
        }
    }

    /// Queues frames where the pointer is drawn.
    pub fn queue_redraw_pointer(&mut self) {
        let Some(pointer) = self.seat.get_pointer() else { return };
        let location = pointer.current_location();
        let ids: Vec<u64> = self
            .backend
            .heads
            .iter()
            .filter(|h| {
                self.space.output_geometry(&h.output).is_some_and(|g| g.to_f64().contains(location))
            })
            .map(|h| h.id)
            .collect();
        for id in ids {
            self.queue_redraw(id);
        }
    }

    /// Whether there's a pointer to draw: Din is up, with a mouse or touchpad.
    pub fn pointer_visible(&self) -> bool {
        self.space.elements().next().is_some() && self.pointer_devices > 0
    }

    fn render(&mut self, id: u64) {
        if !self.backend.active {
            return;
        }
        let pointer =
            self.pointer_visible().then(|| self.seat.get_pointer().map(|p| p.current_location())).flatten();
        let Some(index) = self.backend.heads.iter().position(|h| h.id == id) else { return };
        let Backend { heads, renderer, .. } = &mut self.backend;
        let head = &mut heads[index];
        let Some(screen) = head.screen.as_mut() else { return };
        screen.redraw = Redraw::Idle;
        let output = head.output.clone();
        let Some(area) = self.space.output_geometry(&output) else { return };
        let scale = output.current_scale().fractional_scale();
        let mut scene = Scene {
            space: &self.space,
            pointer,
            cursor_status: &self.cursor_status,
            cursors: &mut self.cursor,
            dnd_icon: self.dnd_icon.as_ref(),
        };
        let elements = render::elements(&mut scene, renderer, area, scale, true);
        let (damaged, states) = match screen.surface.render_frame(renderer, &elements, BACKDROP, FrameFlags::DEFAULT) {
            Ok(frame) => (!frame.is_empty, frame.states),
            Err(err) => {
                warn!("{}: rendering: {err}", head.name);
                return;
            }
        };
        update_primary_scanout_output(&self.space, &output, &self.cursor_status, self.dnd_icon.as_ref().map(|i| &i.surface), &states);
        if damaged {
            let feedback = presentation_feedback(&output, &self.space, &states);
            match screen.surface.queue_frame(Some(feedback)) {
                Ok(()) => screen.redraw = Redraw::Flipping { again: false },
                Err(err) => warn!("{}: queueing a frame: {err}", head.name),
            }
        } else {
            // Nothing changed on screen. Whoever drew hears at the refresh the
            // frame would have made, so a client committing nothing new
            // doesn't spin.
            let now: Duration = self.clock.now().into();
            let delay = screen.next_vblank(now).map_or(screen.refresh, |next| next - now);
            let token = self
                .handle
                .insert_source(Timer::from_duration(delay), move |_, _, state| {
                    state.on_estimated_vblank(id);
                    TimeoutAction::Drop
                })
                .expect("frame timer");
            screen.estimated_vblank = Some(token);
            screen.redraw = Redraw::Flipping { again: false };
        }
        let feedback = screen.feedback.clone();
        drop(elements);
        if let Some(feedback) = feedback {
            send_dmabuf_feedback(&self.space, &output, &states, &feedback);
        }
        self.after_render(id, damaged);
    }

    fn on_estimated_vblank(&mut self, id: u64) {
        let Some(head) = self.backend.heads.iter_mut().find(|h| h.id == id) else { return };
        let Some(screen) = head.screen.as_mut() else { return };
        screen.estimated_vblank = None;
        let again = matches!(screen.redraw, Redraw::Flipping { again: true });
        screen.redraw = Redraw::Idle;
        let output = head.output.clone();
        self.send_frames(&output);
        if again {
            self.queue_redraw(id);
        }
    }

    fn on_vblank(&mut self, crtc: crtc::Handle, metadata: &mut Option<DrmEventMetadata>) {
        let now: Duration = self.clock.now().into();
        let Some(head) = self.backend.heads.iter_mut().find(|h| h.crtc == crtc) else { return };
        let Some(screen) = head.screen.as_mut() else { return };
        let (time, flags) = match metadata.as_ref().map(|m| m.time) {
            Some(DrmEventTime::Monotonic(tp)) if !tp.is_zero() => (
                tp,
                wp_presentation_feedback::Kind::Vsync
                    | wp_presentation_feedback::Kind::HwClock
                    | wp_presentation_feedback::Kind::HwCompletion,
            ),
            _ => (now, wp_presentation_feedback::Kind::Vsync),
        };
        let sequence = metadata.as_ref().map_or(0, |m| m.sequence) as u64;
        match screen.surface.frame_submitted() {
            Ok(Some(Some(mut feedback))) => {
                feedback.presented::<_, Monotonic>(Time::from(time), Refresh::fixed(screen.refresh), sequence, flags)
            }
            Ok(_) => {}
            Err(err) => debug!("{}: {err}", head.name),
        }
        screen.last_vblank = Some(time);
        let again = matches!(screen.redraw, Redraw::Flipping { again: true });
        if matches!(screen.redraw, Redraw::Flipping { .. }) {
            screen.redraw = Redraw::Idle;
        }
        let id = head.id;
        let output = head.output.clone();
        self.send_frames(&output);
        if again {
            self.queue_redraw(id);
        }
    }

    /// Tells what's drawn on OUTPUT to draw its next frame.
    fn send_frames(&self, output: &Output) {
        let now = self.clock.now();
        let throttle = Some(Duration::from_secs(1));
        for window in self.space.elements() {
            if self.space.outputs_for_element(window).contains(output) {
                window.send_frame(output, now, throttle, surface_primary_scanout_output);
            }
        }
        if let CursorImageStatus::Surface(surface) = &self.cursor_status {
            send_frames_surface_tree(surface, output, now, throttle, |_, _| Some(output.clone()));
        }
        if let Some(icon) = &self.dnd_icon {
            send_frames_surface_tree(&icon.surface, output, now, throttle, |_, _| Some(output.clone()));
        }
    }

    /// Puts the gamma tables clients set back, after another VT had the GPU.
    fn restore_gamma(&mut self) {
        for head in &self.backend.heads {
            if let Some(gamma) = &head.gamma {
                let _ = self.backend.set_gamma(head.id, Some(gamma));
            }
        }
    }
}

fn update_primary_scanout_output(
    space: &Space<Window>,
    output: &Output,
    cursor: &CursorImageStatus,
    dnd_icon: Option<&smithay::reexports::wayland_server::protocol::wl_surface::WlSurface>,
    states: &RenderElementStates,
) {
    let compare = smithay::backend::renderer::element::default_primary_scanout_output_compare;
    for window in space.elements() {
        window.with_surfaces(|surface, data| {
            update_surface_primary_scanout_output(surface, output, data, states, compare);
        });
    }
    let surfaces = [
        match cursor {
            CursorImageStatus::Surface(surface) => Some(surface),
            _ => None,
        },
        dnd_icon,
    ];
    for surface in surfaces.into_iter().flatten() {
        smithay::desktop::utils::with_surfaces_surface_tree(surface, |surface, data| {
            update_surface_primary_scanout_output(surface, output, data, states, compare);
        });
    }
}

fn presentation_feedback(output: &Output, space: &Space<Window>, states: &RenderElementStates) -> OutputPresentationFeedback {
    let mut feedback = OutputPresentationFeedback::new(output);
    for window in space.elements() {
        if space.outputs_for_element(window).contains(output) {
            window.take_presentation_feedback(&mut feedback, surface_primary_scanout_output, |surface, _| {
                surface_presentation_feedback_flags_from_states(surface, states)
            });
        }
    }
    feedback
}

fn send_dmabuf_feedback(space: &Space<Window>, output: &Output, states: &RenderElementStates, feedback: &SurfaceFeedback) {
    for window in space.elements() {
        if space.outputs_for_element(window).contains(output) {
            window.send_dmabuf_feedback(output, surface_primary_scanout_output, |surface, _| {
                select_dmabuf_feedback(surface, states, &feedback.render, &feedback.scanout)
            });
        }
    }
}
