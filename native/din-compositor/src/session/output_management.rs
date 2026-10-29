//! wlr-output-management: the displays, their modes and arrangement, for
//! whoever arranges them: wlr-randr, through which Din's display settings
//! and lid handling work, and deckmon, which sizes the display it adds for
//! an AirPlay receiver.
//!
//! Every connected display is a head, on or off. A configuration names every
//! head, on (with a mode, position, scale and rotation) or off, and is
//! applied as a whole.

use std::sync::{Arc, Mutex};

use smithay::{
    output::Mode as WlMode,
    reexports::{
        wayland_protocols_wlr::output_management::v1::server::{
            zwlr_output_configuration_head_v1::{self, ZwlrOutputConfigurationHeadV1},
            zwlr_output_configuration_v1::{self, ZwlrOutputConfigurationV1},
            zwlr_output_head_v1::{self, AdaptiveSyncState, ZwlrOutputHeadV1},
            zwlr_output_manager_v1::{self, ZwlrOutputManagerV1},
            zwlr_output_mode_v1::{self, ZwlrOutputModeV1},
        },
        wayland_server::{
            Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource, WEnum, backend::ClientId,
            protocol::wl_output,
        },
    },
    utils::{Logical, Point, Transform},
};
use tracing::{info, warn};

use super::{drm::Head, state::State};

pub struct OutputManagement {
    serial: u32,
    managers: Vec<Manager>,
}

/// A client's view of the heads.
struct Manager {
    resource: ZwlrOutputManagerV1,
    heads: Vec<(u64, ZwlrOutputHeadV1, Vec<ZwlrOutputModeV1>)>,
}

#[derive(Clone, Copy)]
enum ModeChoice {
    Index(usize),
    Custom { width: i32, height: i32, refresh: i32 },
}

#[derive(Clone, Copy, Default)]
struct HeadChange {
    mode: Option<ModeChoice>,
    position: Option<Point<i32, Logical>>,
    transform: Option<Transform>,
    scale: Option<f64>,
}

#[derive(Default)]
struct Configuration {
    /// Each head named, on with its changes or off.
    heads: Vec<(u64, Option<HeadChange>)>,
    used: bool,
}

pub struct ConfigurationData {
    serial: u32,
    inner: Arc<Mutex<Configuration>>,
}

pub struct ConfigurationHeadData {
    head: u64,
    inner: Arc<Mutex<Configuration>>,
}

impl OutputManagement {
    pub fn new(dh: &DisplayHandle) -> OutputManagement {
        dh.create_global::<State, ZwlrOutputManagerV1, _>(4, ());
        OutputManagement { serial: 1, managers: Vec::new() }
    }
}

impl State {
    /// Tells every client what changed about the heads.
    pub fn output_management_changed(&mut self) {
        self.output_management.serial += 1;
        let serial = self.output_management.serial;
        let mut managers = std::mem::take(&mut self.output_management.managers);
        for manager in &mut managers {
            manager.heads.retain(|(id, head, modes)| {
                let present = self.backend.head(*id).is_some();
                if !present {
                    for mode in modes {
                        mode.finished();
                    }
                    head.finished();
                }
                present
            });
            for head in &self.backend.heads {
                if let Some((_, resource, modes)) = manager.heads.iter().find(|(id, ..)| *id == head.id) {
                    send_state(head, resource, modes);
                } else {
                    self.send_head(manager, head);
                }
            }
            manager.resource.done(serial);
        }
        self.output_management.managers = managers;
    }

    fn send_head(&self, manager: &mut Manager, head: &Head) {
        let Some(client) = manager.resource.client() else { return };
        let version = manager.resource.version();
        let Ok(resource) = client.create_resource::<ZwlrOutputHeadV1, u64, State>(&self.dh, version, head.id) else {
            return;
        };
        manager.resource.head(&resource);
        resource.name(head.name.clone());
        let description = [head.info.make.as_str(), head.info.model.as_str()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        resource.description(if description.is_empty() { head.name.clone() } else { format!("{description} ({})", head.name) });
        if head.physical_size.0 > 0 && head.physical_size.1 > 0 {
            resource.physical_size(head.physical_size.0, head.physical_size.1);
        }
        let preferred = head.preferred().copied();
        let mut modes = Vec::new();
        for (index, mode) in head.modes.iter().enumerate() {
            let Ok(mode_resource) =
                client.create_resource::<ZwlrOutputModeV1, (u64, usize), State>(&self.dh, version, (head.id, index))
            else {
                continue;
            };
            resource.mode(&mode_resource);
            let (w, h) = mode.size();
            mode_resource.size(w as i32, h as i32);
            mode_resource.refresh(WlMode::from(*mode).refresh);
            if Some(*mode) == preferred {
                mode_resource.preferred();
            }
            modes.push(mode_resource);
        }
        if version >= 2 {
            if !head.info.make.is_empty() {
                resource.make(head.info.make.clone());
            }
            if !head.info.model.is_empty() {
                resource.model(head.info.model.clone());
            }
            if !head.info.serial.is_empty() {
                resource.serial_number(head.info.serial.clone());
            }
        }
        if version >= 4 {
            resource.adaptive_sync(AdaptiveSyncState::Disabled);
        }
        send_state(head, &resource, &modes);
        manager.heads.push((head.id, resource, modes));
    }

    /// Applies (or with TEST, only checks) a configuration naming every head.
    fn apply_configuration(&mut self, heads: Vec<(u64, Option<HeadChange>)>, test: bool) -> Result<(), String> {
        let mut plan = Vec::new();
        for (id, change) in heads {
            let head = self.backend.head(id).ok_or("a display is gone")?;
            let Some(change) = change else {
                plan.push((id, None));
                continue;
            };
            let mode = match change.mode {
                None => head.mode,
                Some(ModeChoice::Index(index)) => *head.modes.get(index).ok_or("no such mode")?,
                Some(ModeChoice::Custom { width, height, refresh }) => *head
                    .modes
                    .iter()
                    .filter(|m| m.size() == (width as u16, height as u16))
                    .min_by_key(|m| if refresh > 0 { (WlMode::from(**m).refresh - refresh).abs() } else { 0 })
                    .ok_or_else(|| format!("{} has no {width}x{height} mode", head.name))?,
            };
            let scale = change.scale.unwrap_or(head.scale);
            if !(0.25..=8.0).contains(&scale) {
                return Err(format!("scale {scale} is out of range"));
            }
            let position = change.position.unwrap_or(head.position);
            let transform = change.transform.unwrap_or(head.transform);
            plan.push((id, Some((mode, position, scale, transform))));
        }
        if plan.iter().all(|(_, c)| c.is_none()) {
            return Err("at least one display has to stay on".into());
        }
        if test {
            return Ok(());
        }
        for (id, change) in &plan {
            if change.is_none() {
                self.disable_head(*id);
            }
        }
        let mut result = Ok(());
        for (id, change) in plan {
            let Some((mode, position, scale, transform)) = change else { continue };
            if let Some(head) = self.backend.heads.iter_mut().find(|h| h.id == id) {
                head.mode = mode;
                head.position = position;
                head.scale = scale;
                head.transform = transform;
            }
            if let Err(err) = self.enable_head(id) {
                warn!("{err}");
                result = Err(err);
            }
        }
        self.layout_changed();
        result
    }
}

/// What can change about a head.
fn send_state(head: &Head, resource: &ZwlrOutputHeadV1, modes: &[ZwlrOutputModeV1]) {
    resource.enabled(head.enabled() as i32);
    if !head.enabled() {
        return;
    }
    if let Some(mode) = head.modes.iter().position(|m| *m == head.mode).and_then(|i| modes.get(i)) {
        resource.current_mode(mode);
    }
    resource.position(head.position.x, head.position.y);
    resource.transform(head.transform.into());
    resource.scale(head.scale);
}

impl GlobalDispatch<ZwlrOutputManagerV1, ()> for State {
    fn bind(
        state: &mut State,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<ZwlrOutputManagerV1>,
        _data: &(),
        data_init: &mut DataInit<'_, State>,
    ) {
        let resource = data_init.init(resource, ());
        let mut manager = Manager { resource, heads: Vec::new() };
        for head in &state.backend.heads {
            state.send_head(&mut manager, head);
        }
        manager.resource.done(state.output_management.serial);
        state.output_management.managers.push(manager);
    }
}

impl Dispatch<ZwlrOutputManagerV1, ()> for State {
    fn request(
        state: &mut State,
        _client: &Client,
        resource: &ZwlrOutputManagerV1,
        request: zwlr_output_manager_v1::Request,
        _data: &(),
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, State>,
    ) {
        match request {
            zwlr_output_manager_v1::Request::CreateConfiguration { id, serial } => {
                data_init.init(id, ConfigurationData { serial, inner: Arc::default() });
            }
            zwlr_output_manager_v1::Request::Stop => {
                state.output_management.managers.retain(|m| &m.resource != resource);
                resource.finished();
            }
            _ => {}
        }
    }

    fn destroyed(state: &mut State, _client: ClientId, resource: &ZwlrOutputManagerV1, _data: &()) {
        state.output_management.managers.retain(|m| &m.resource != resource);
    }
}

impl Dispatch<ZwlrOutputHeadV1, u64> for State {
    fn request(
        state: &mut State,
        _client: &Client,
        resource: &ZwlrOutputHeadV1,
        request: zwlr_output_head_v1::Request,
        _data: &u64,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, State>,
    ) {
        if let zwlr_output_head_v1::Request::Release = request {
            for manager in &mut state.output_management.managers {
                manager.heads.retain(|(_, head, _)| head != resource);
            }
        }
    }
}

impl Dispatch<ZwlrOutputModeV1, (u64, usize)> for State {
    fn request(
        _state: &mut State,
        _client: &Client,
        _resource: &ZwlrOutputModeV1,
        _request: zwlr_output_mode_v1::Request,
        _data: &(u64, usize),
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, State>,
    ) {
    }
}

impl Dispatch<ZwlrOutputConfigurationV1, ConfigurationData> for State {
    fn request(
        state: &mut State,
        _client: &Client,
        resource: &ZwlrOutputConfigurationV1,
        request: zwlr_output_configuration_v1::Request,
        data: &ConfigurationData,
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, State>,
    ) {
        let mut inner = data.inner.lock().unwrap();
        let used = || {
            resource.post_error(zwlr_output_configuration_v1::Error::AlreadyUsed, "the configuration was already used");
        };
        match request {
            zwlr_output_configuration_v1::Request::EnableHead { id, head } => {
                let head_id = *head.data::<u64>().unwrap_or(&0);
                if inner.used {
                    return used();
                }
                if inner.heads.iter().any(|(h, _)| *h == head_id) {
                    resource.post_error(zwlr_output_configuration_v1::Error::AlreadyConfiguredHead, "the head is configured twice");
                    return;
                }
                inner.heads.push((head_id, Some(HeadChange::default())));
                data_init.init(id, ConfigurationHeadData { head: head_id, inner: data.inner.clone() });
            }
            zwlr_output_configuration_v1::Request::DisableHead { head } => {
                let head_id = *head.data::<u64>().unwrap_or(&0);
                if inner.used {
                    return used();
                }
                if inner.heads.iter().any(|(h, _)| *h == head_id) {
                    resource.post_error(zwlr_output_configuration_v1::Error::AlreadyConfiguredHead, "the head is configured twice");
                    return;
                }
                inner.heads.push((head_id, None));
            }
            request @ (zwlr_output_configuration_v1::Request::Apply | zwlr_output_configuration_v1::Request::Test) => {
                if inner.used {
                    return used();
                }
                inner.used = true;
                let test = matches!(request, zwlr_output_configuration_v1::Request::Test);
                if data.serial != state.output_management.serial {
                    resource.cancelled();
                    return;
                }
                if state.backend.heads.iter().any(|h| !inner.heads.iter().any(|(id, _)| *id == h.id)) {
                    resource.post_error(zwlr_output_configuration_v1::Error::UnconfiguredHead, "a head isn't configured");
                    return;
                }
                let heads = inner.heads.clone();
                drop(inner);
                match state.apply_configuration(heads, test) {
                    Ok(()) => {
                        if !test {
                            info!("applied a display configuration");
                        }
                        resource.succeeded();
                    }
                    Err(err) => {
                        warn!("a display configuration failed: {err}");
                        resource.failed();
                    }
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<ZwlrOutputConfigurationHeadV1, ConfigurationHeadData> for State {
    fn request(
        _state: &mut State,
        _client: &Client,
        resource: &ZwlrOutputConfigurationHeadV1,
        request: zwlr_output_configuration_head_v1::Request,
        data: &ConfigurationHeadData,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, State>,
    ) {
        let mut inner = data.inner.lock().unwrap();
        let Some(change) = inner.heads.iter_mut().find(|(id, _)| *id == data.head).and_then(|(_, c)| c.as_mut()) else {
            return;
        };
        let already = || {
            resource.post_error(zwlr_output_configuration_head_v1::Error::AlreadySet, "the property was already set");
        };
        match request {
            zwlr_output_configuration_head_v1::Request::SetMode { mode } => {
                if change.mode.is_some() {
                    return already();
                }
                match mode.data::<(u64, usize)>() {
                    Some((head, index)) if *head == data.head => change.mode = Some(ModeChoice::Index(*index)),
                    _ => resource.post_error(zwlr_output_configuration_head_v1::Error::InvalidMode, "the mode isn't the head's"),
                }
            }
            zwlr_output_configuration_head_v1::Request::SetCustomMode { width, height, refresh } => {
                if change.mode.is_some() {
                    return already();
                }
                if width <= 0 || height <= 0 || refresh < 0 {
                    resource.post_error(zwlr_output_configuration_head_v1::Error::InvalidCustomMode, "invalid custom mode");
                    return;
                }
                change.mode = Some(ModeChoice::Custom { width, height, refresh });
            }
            zwlr_output_configuration_head_v1::Request::SetPosition { x, y } => {
                if change.position.is_some() {
                    return already();
                }
                change.position = Some((x, y).into());
            }
            zwlr_output_configuration_head_v1::Request::SetTransform { transform } => {
                if change.transform.is_some() {
                    return already();
                }
                match transform {
                    WEnum::Value(t) => change.transform = Some(transform_from(t)),
                    WEnum::Unknown(_) => resource.post_error(zwlr_output_configuration_head_v1::Error::InvalidTransform, "invalid transform"),
                }
            }
            zwlr_output_configuration_head_v1::Request::SetScale { scale } => {
                if change.scale.is_some() {
                    return already();
                }
                if scale <= 0.0 {
                    resource.post_error(zwlr_output_configuration_head_v1::Error::InvalidScale, "invalid scale");
                    return;
                }
                change.scale = Some(scale);
            }
            _ => {}
        }
    }
}

fn transform_from(t: wl_output::Transform) -> Transform {
    match t {
        wl_output::Transform::_90 => Transform::_90,
        wl_output::Transform::_180 => Transform::_180,
        wl_output::Transform::_270 => Transform::_270,
        wl_output::Transform::Flipped => Transform::Flipped,
        wl_output::Transform::Flipped90 => Transform::Flipped90,
        wl_output::Transform::Flipped180 => Transform::Flipped180,
        wl_output::Transform::Flipped270 => Transform::Flipped270,
        _ => Transform::Normal,
    }
}
