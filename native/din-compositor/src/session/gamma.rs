//! wlr-gamma-control: a display's gamma table, which night light (gammastep)
//! sets to tint the screen. One client per display; when it goes, the table
//! goes back to the identity.

use std::{io::Read, os::unix::fs::FileExt};

use smithay::{
    output::Output,
    reexports::{
        wayland_protocols_wlr::gamma_control::v1::server::{
            zwlr_gamma_control_manager_v1::{self, ZwlrGammaControlManagerV1},
            zwlr_gamma_control_v1::{self, ZwlrGammaControlV1},
        },
        wayland_server::{
            Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, backend::ClientId,
        },
    },
};
use tracing::warn;

use super::state::State;

pub struct GammaControl {
    /// Which display each control is for.
    controls: Vec<(u64, ZwlrGammaControlV1)>,
}

impl GammaControl {
    pub fn new(dh: &DisplayHandle) -> GammaControl {
        dh.create_global::<State, ZwlrGammaControlManagerV1, _>(1, ());
        GammaControl { controls: Vec::new() }
    }

    pub fn head_removed(&mut self, id: u64) {
        self.controls.retain(|(head, control)| {
            if *head == id {
                control.failed();
            }
            *head != id
        });
    }
}

impl GlobalDispatch<ZwlrGammaControlManagerV1, ()> for State {
    fn bind(
        _state: &mut State,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<ZwlrGammaControlManagerV1>,
        _data: &(),
        data_init: &mut DataInit<'_, State>,
    ) {
        data_init.init(resource, ());
    }
}

impl Dispatch<ZwlrGammaControlManagerV1, ()> for State {
    fn request(
        state: &mut State,
        _client: &Client,
        _resource: &ZwlrGammaControlManagerV1,
        request: zwlr_gamma_control_manager_v1::Request,
        _data: &(),
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, State>,
    ) {
        if let zwlr_gamma_control_manager_v1::Request::GetGammaControl { id, output } = request {
            let head = Output::from_resource(&output)
                .and_then(|o| state.backend.head_for_output(&o))
                .map(|h| (h.id, h.gamma_size));
            let control = data_init.init(id, head.map_or(0, |(id, _)| id));
            match head {
                Some((id, size)) if size > 0 && !state.gamma.controls.iter().any(|(h, _)| *h == id) => {
                    control.gamma_size(size);
                    state.gamma.controls.push((id, control));
                }
                _ => control.failed(),
            }
        }
    }
}

impl Dispatch<ZwlrGammaControlV1, u64> for State {
    fn request(
        state: &mut State,
        _client: &Client,
        resource: &ZwlrGammaControlV1,
        request: zwlr_gamma_control_v1::Request,
        id: &u64,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, State>,
    ) {
        let zwlr_gamma_control_v1::Request::SetGamma { fd } = request else { return };
        if !state.gamma.controls.iter().any(|(_, c)| c == resource) {
            return;
        }
        let Some(size) = state.backend.head(*id).map(|h| h.gamma_size as usize) else { return };
        let mut bytes = vec![0u8; size * 3 * 2];
        let mut file = std::fs::File::from(fd);
        let read = file.read_exact_at(&mut bytes, 0).or_else(|_| file.read_exact(&mut bytes));
        let ramp: Vec<u16> = bytes.chunks_exact(2).map(|b| u16::from_ne_bytes([b[0], b[1]])).collect();
        let result = read.map_err(|err| err.to_string()).and_then(|()| state.backend.set_gamma(*id, Some(&ramp)));
        match result {
            Ok(()) => {
                if let Some(head) = state.backend.heads.iter_mut().find(|h| h.id == *id) {
                    head.gamma = Some(ramp);
                }
            }
            Err(err) => {
                warn!("gamma: {err}");
                resource.failed();
                state.gamma.controls.retain(|(_, c)| c != resource);
                let _ = state.backend.set_gamma(*id, None);
            }
        }
    }

    fn destroyed(state: &mut State, _client: ClientId, resource: &ZwlrGammaControlV1, id: &u64) {
        let before = state.gamma.controls.len();
        state.gamma.controls.retain(|(_, c)| c != resource);
        if state.gamma.controls.len() != before {
            if let Some(head) = state.backend.heads.iter_mut().find(|h| h.id == *id) {
                head.gamma = None;
            }
            let _ = state.backend.set_gamma(*id, None);
        }
    }
}
