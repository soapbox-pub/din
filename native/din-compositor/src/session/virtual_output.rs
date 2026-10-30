//! din-virtual-output (protocols/din-virtual-output-v1.xml): displays with no
//! screen behind them, which deckmon adds to extend the desktop onto an
//! AirPlay receiver. Each is a virtual head (drm.rs), on the layout and in
//! output management like a monitor plugged in, and drawn only into the
//! screen copies the client takes of it. It goes when its object does, so a
//! client that dies doesn't leave one behind.

use std::sync::Mutex;

use smithay::reexports::wayland_server::{
    Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, Resource, backend::ClientId,
};
use tracing::warn;

use super::state::State;

#[allow(dead_code, non_camel_case_types, non_upper_case_globals, unused_imports, clippy::all)]
pub mod protocol {
    use smithay::reexports::wayland_server;
    use smithay::reexports::wayland_server::protocol::*;

    pub mod __interfaces {
        use smithay::reexports::wayland_server::backend as wayland_backend;
        use smithay::reexports::wayland_server::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("protocols/din-virtual-output-v1.xml");
    }
    use self::__interfaces::*;

    wayland_scanner::generate_server_code!("protocols/din-virtual-output-v1.xml");
}

use protocol::{
    din_virtual_output_manager_v1::{self, DinVirtualOutputManagerV1},
    din_virtual_output_v1::{self, DinVirtualOutputV1},
};

/// Its head, while it has one.
#[derive(Default)]
pub struct VirtualOutputData {
    head: Mutex<Option<u64>>,
}

pub fn create_global(dh: &DisplayHandle) {
    dh.create_global::<State, DinVirtualOutputManagerV1, _>(1, ());
}

impl GlobalDispatch<DinVirtualOutputManagerV1, ()> for State {
    fn bind(
        _state: &mut State,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<DinVirtualOutputManagerV1>,
        _data: &(),
        data_init: &mut DataInit<'_, State>,
    ) {
        data_init.init(resource, ());
    }
}

impl Dispatch<DinVirtualOutputManagerV1, ()> for State {
    fn request(
        state: &mut State,
        _client: &Client,
        _resource: &DinVirtualOutputManagerV1,
        request: din_virtual_output_manager_v1::Request,
        _data: &(),
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, State>,
    ) {
        let din_virtual_output_manager_v1::Request::Create { id, make, model, width, height, refresh } = request else {
            return;
        };
        let output = data_init.init(id, VirtualOutputData::default());
        if !(1..=8192).contains(&width) || !(1..=8192).contains(&height) || refresh < 0 {
            output.failed(format!("{width}x{height} at {refresh} mHz isn't a display size"));
            return;
        }
        match state.add_virtual_head(make, model, width as u16, height as u16, refresh as u32) {
            Ok((head, name)) => {
                *output.data::<VirtualOutputData>().unwrap().head.lock().unwrap() = Some(head);
                output.name(name);
            }
            Err(err) => {
                warn!("adding a virtual display: {err}");
                output.failed(err);
            }
        }
    }
}

impl Dispatch<DinVirtualOutputV1, VirtualOutputData> for State {
    fn request(
        _state: &mut State,
        _client: &Client,
        _resource: &DinVirtualOutputV1,
        _request: din_virtual_output_v1::Request,
        _data: &VirtualOutputData,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, State>,
    ) {
    }

    fn destroyed(state: &mut State, _client: ClientId, _resource: &DinVirtualOutputV1, data: &VirtualOutputData) {
        if let Some(head) = data.head.lock().unwrap().take() {
            state.remove_head_id(head);
            state.layout_changed();
        }
    }
}
