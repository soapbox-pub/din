//! wl_data_device for both compositors: Smithay's, except that a drag it
//! refuses is cancelled.
//!
//! Smithay refuses a start_drag whose serial isn't a button or touch still
//! held, which a client sends when the button came up before its drag got
//! going (Chromium does, after a quick click with a twitch on a draggable
//! row), and only logs it: the source never hears `cancelled`, so the client
//! waits on the drag for good. In Chromium the page it began in then ignores
//! the pointer's moves (no hover, only clicks) until it's reloaded. wlroots
//! cancels the source there, as the protocol has it.

/// `delegate_data_device!`, but with a wl_data_device handler that cancels
/// the drags Smithay refuses. `$ty` must have a `seat: Seat<$ty>` field.
macro_rules! delegate_data_device_cancelling_refused_drags {
    ($ty:ty) => {
        smithay::reexports::wayland_server::delegate_global_dispatch!($ty: [
            smithay::reexports::wayland_server::protocol::wl_data_device_manager::WlDataDeviceManager: ()
        ] => smithay::wayland::selection::data_device::DataDeviceState);
        smithay::reexports::wayland_server::delegate_dispatch!($ty: [
            smithay::reexports::wayland_server::protocol::wl_data_device_manager::WlDataDeviceManager: ()
        ] => smithay::wayland::selection::data_device::DataDeviceState);
        smithay::reexports::wayland_server::delegate_dispatch!($ty: [
            smithay::reexports::wayland_server::protocol::wl_data_source::WlDataSource:
                smithay::wayland::selection::data_device::DataSourceUserData
        ] => smithay::wayland::selection::data_device::DataDeviceState);

        impl smithay::reexports::wayland_server::Dispatch<
            smithay::reexports::wayland_server::protocol::wl_data_device::WlDataDevice,
            smithay::wayland::selection::data_device::DataDeviceUserData,
        > for $ty
        {
            fn request(
                state: &mut Self,
                client: &smithay::reexports::wayland_server::Client,
                resource: &smithay::reexports::wayland_server::protocol::wl_data_device::WlDataDevice,
                request: smithay::reexports::wayland_server::protocol::wl_data_device::Request,
                data: &smithay::wayland::selection::data_device::DataDeviceUserData,
                dh: &smithay::reexports::wayland_server::DisplayHandle,
                data_init: &mut smithay::reexports::wayland_server::DataInit<'_, Self>,
            ) {
                use smithay::reexports::wayland_server::{Dispatch, Resource, protocol::wl_data_device};
                let refused = match &request {
                    wl_data_device::Request::StartDrag { source: Some(source), serial, .. } => {
                        let serial = smithay::utils::Serial::from(*serial);
                        let held = state.seat.get_pointer().is_some_and(|p| p.has_grab(serial))
                            || state.seat.get_touch().is_some_and(|t| t.has_grab(serial));
                        (!held).then(|| source.clone())
                    }
                    _ => None,
                };
                <smithay::wayland::selection::data_device::DataDeviceState as Dispatch<
                    wl_data_device::WlDataDevice,
                    smithay::wayland::selection::data_device::DataDeviceUserData,
                    Self,
                >>::request(state, client, resource, request, data, dh, data_init);
                if let Some(source) = refused {
                    if source.is_alive() {
                        source.cancelled();
                    }
                }
            }

            fn destroyed(
                state: &mut Self,
                client: smithay::reexports::wayland_server::backend::ClientId,
                resource: &smithay::reexports::wayland_server::protocol::wl_data_device::WlDataDevice,
                data: &smithay::wayland::selection::data_device::DataDeviceUserData,
            ) {
                <smithay::wayland::selection::data_device::DataDeviceState as smithay::reexports::wayland_server::Dispatch<
                    smithay::reexports::wayland_server::protocol::wl_data_device::WlDataDevice,
                    smithay::wayland::selection::data_device::DataDeviceUserData,
                    Self,
                >>::destroyed(state, client, resource, data);
            }
        }
    };
}

pub(crate) use delegate_data_device_cancelling_refused_drags;
