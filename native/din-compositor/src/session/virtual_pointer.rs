//! wlr-virtual-pointer: a pointer a client drives (wlrctl, in the debug
//! image), moving and clicking like a mouse would.

use std::sync::Mutex;

use smithay::{
    backend::input::{Axis, AxisSource, ButtonState},
    input::pointer::{AxisFrame, ButtonEvent},
    output::Output,
    reexports::{
        wayland_protocols_wlr::virtual_pointer::v1::server::{
            zwlr_virtual_pointer_manager_v1::{self, ZwlrVirtualPointerManagerV1},
            zwlr_virtual_pointer_v1::{self, ZwlrVirtualPointerV1},
        },
        wayland_server::{
            Client, DataInit, Dispatch, DisplayHandle, GlobalDispatch, New, WEnum,
            protocol::wl_pointer,
        },
    },
    utils::{Point, SERIAL_COUNTER},
};

use super::state::State;

pub fn create_global(dh: &DisplayHandle) {
    dh.create_global::<State, ZwlrVirtualPointerManagerV1, _>(2, ());
}

/// A virtual pointer's output (absolute motion maps onto it; None: the
/// whole layout) and the scroll frame it's building.
pub struct VirtualPointer {
    output: Option<Output>,
    frame: Mutex<Option<AxisFrame>>,
}

impl GlobalDispatch<ZwlrVirtualPointerManagerV1, ()> for State {
    fn bind(
        _state: &mut State,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<ZwlrVirtualPointerManagerV1>,
        _data: &(),
        data_init: &mut DataInit<'_, State>,
    ) {
        data_init.init(resource, ());
    }
}

impl Dispatch<ZwlrVirtualPointerManagerV1, ()> for State {
    fn request(
        _state: &mut State,
        _client: &Client,
        _resource: &ZwlrVirtualPointerManagerV1,
        request: zwlr_virtual_pointer_manager_v1::Request,
        _data: &(),
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, State>,
    ) {
        let (id, output) = match request {
            zwlr_virtual_pointer_manager_v1::Request::CreateVirtualPointer { id, .. } => (id, None),
            zwlr_virtual_pointer_manager_v1::Request::CreateVirtualPointerWithOutput { id, output, .. } => {
                (id, output.as_ref().and_then(Output::from_resource))
            }
            _ => return,
        };
        data_init.init(id, VirtualPointer { output, frame: Mutex::new(None) });
    }
}

impl Dispatch<ZwlrVirtualPointerV1, VirtualPointer> for State {
    fn request(
        state: &mut State,
        _client: &Client,
        _resource: &ZwlrVirtualPointerV1,
        request: zwlr_virtual_pointer_v1::Request,
        data: &VirtualPointer,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, State>,
    ) {
        let Some(pointer) = state.seat.get_pointer() else { return };
        let mut frame = data.frame.lock().unwrap();
        match request {
            zwlr_virtual_pointer_v1::Request::Motion { time, dx, dy } => {
                let location = pointer.current_location() + Point::from((dx, dy));
                state.move_pointer(location, time);
            }
            zwlr_virtual_pointer_v1::Request::MotionAbsolute { time, x, y, x_extent, y_extent } => {
                if x_extent == 0 || y_extent == 0 {
                    return;
                }
                let area = data
                    .output
                    .as_ref()
                    .and_then(|o| state.space.output_geometry(o))
                    .unwrap_or_else(|| state.layout_box())
                    .to_f64();
                let location = area.loc
                    + Point::from((area.size.w * x as f64 / x_extent as f64, area.size.h * y as f64 / y_extent as f64));
                state.move_pointer(location, time);
            }
            zwlr_virtual_pointer_v1::Request::Button { time, button, state: button_state } => {
                let button_state = match button_state {
                    WEnum::Value(wl_pointer::ButtonState::Pressed) => ButtonState::Pressed,
                    _ => ButtonState::Released,
                };
                let serial = SERIAL_COUNTER.next_serial();
                pointer.button(state, &ButtonEvent { serial, time, button, state: button_state });
            }
            zwlr_virtual_pointer_v1::Request::Axis { time, axis, value } => {
                let axis = axis_from(axis);
                *frame = Some(frame.take().unwrap_or_else(|| AxisFrame::new(time)).value(axis, value));
            }
            zwlr_virtual_pointer_v1::Request::AxisSource { axis_source } => {
                let source = match axis_source {
                    WEnum::Value(wl_pointer::AxisSource::Finger) => AxisSource::Finger,
                    WEnum::Value(wl_pointer::AxisSource::Continuous) => AxisSource::Continuous,
                    WEnum::Value(wl_pointer::AxisSource::WheelTilt) => AxisSource::WheelTilt,
                    _ => AxisSource::Wheel,
                };
                *frame = Some(frame.take().unwrap_or_else(|| AxisFrame::new(0)).source(source));
            }
            zwlr_virtual_pointer_v1::Request::AxisStop { time, axis } => {
                *frame = Some(frame.take().unwrap_or_else(|| AxisFrame::new(time)).stop(axis_from(axis)));
            }
            zwlr_virtual_pointer_v1::Request::AxisDiscrete { time, axis, value, discrete } => {
                let axis = axis_from(axis);
                *frame = Some(frame.take().unwrap_or_else(|| AxisFrame::new(time)).value(axis, value).v120(axis, discrete * 120));
            }
            zwlr_virtual_pointer_v1::Request::Frame => {
                if let Some(axis) = frame.take() {
                    pointer.axis(state, axis);
                }
                pointer.frame(state);
            }
            _ => {}
        }
    }
}

fn axis_from(axis: WEnum<wl_pointer::Axis>) -> Axis {
    match axis {
        WEnum::Value(wl_pointer::Axis::HorizontalScroll) => Axis::Horizontal,
        _ => Axis::Vertical,
    }
}
