//! din-compositor: a headless Wayland compositor for Din's embedded display.
//!
//! Native Linux apps connect to it like to any Wayland desktop; nothing
//! reaches a screen. Each toplevel and popup is composited offscreen with
//! pixman, and the rectangles that changed are streamed straight to the
//! shell renderer (frames.rs), where they're painted into ordinary Din
//! windows. Din's display worker drives everything else over stdin/stdout
//! (wire.rs): window announcements, input, geometry, focus, clipboard. Apps
//! are paced by the renderer's acks: frame callbacks go out only once Din
//! has shown the last frame. X11 apps come in through a rootless Xwayland
//! the compositor manages (xwayland.rs).
//!
//! Spawned by electron/wayland-bridge.mts; exits when stdin closes.

mod canvas;
mod constraints;
mod frames;
mod gpu;
mod logic;
mod state;
mod stats;
mod wire;
mod xwayland;

use std::{
    io::Read,
    os::fd::FromRawFd,
    sync::Arc,
    time::Duration,
};

use smithay::reexports::{
    calloop::{EventLoop, Interest, Mode, PostAction, channel, generic::Generic},
    wayland_server::Display,
};
use smithay::wayland::socket::ListeningSocketSource;

use state::{ClientState, State};

fn env_size(name: &str, fallback: i32) -> i32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).filter(|v| *v > 0).unwrap_or(fallback)
}

fn main() {
    let mut event_loop: EventLoop<'static, State> = EventLoop::try_new().expect("event loop");
    let display: Display<State> = Display::new().expect("wayland display");
    let dh = display.handle();
    let screen = (env_size("DIN_SCREEN_WIDTH", 1920), env_size("DIN_SCREEN_HEIGHT", 1080)).into();

    let (clipboard_tx, clipboard_rx) = channel::channel::<(String, bool)>();
    let (connected_tx, connected_rx) = channel::channel::<()>();
    let frames = frames::FrameServer::start(connected_tx).expect("frame stream");
    let frames_url = frames.url.clone();
    let gpu = gpu::Gpu::open();
    let buffers = gpu.as_ref().and_then(|_| gpu::BufferChannel::bind().ok());
    let buffers_path = buffers.as_ref().map(|b| b.path.to_string_lossy().into_owned());
    let listener = buffers.as_ref().and_then(|b| b.listener.try_clone().ok());
    let handle = event_loop.handle();
    let mut state = State::new(&dh, handle.clone(), screen, frames, gpu, buffers, clipboard_tx);

    // Din's main process connects here to receive GPU buffers (gpu.rs).
    if let Some(listener) = listener {
        handle
            .insert_source(Generic::new(listener, Interest::READ, Mode::Level), |_, _, state| {
                if state.buffers.as_mut().is_some_and(|b| b.accept()) {
                    state.stream_connected();
                }
                Ok(PostAction::Continue)
            })
            .expect("buffer socket source");
    }

    handle
        .insert_source(connected_rx, |event, _, state| {
            if let channel::Event::Msg(()) = event {
                state.stream_connected();
            }
        })
        .expect("frame stream source");

    let socket = ListeningSocketSource::new_auto().expect("wayland socket");
    let socket_name = socket.socket_name().to_string_lossy().into_owned();
    handle
        .insert_source(socket, |stream, _, state| {
            let _ = state.dh.insert_client(stream, Arc::new(ClientState::default()));
        })
        .expect("socket source");

    handle
        .insert_source(Generic::new(display, Interest::READ, Mode::Level), |_, display, state| {
            // SAFETY: the display is never dropped while the loop runs.
            unsafe {
                let _ = display.get_mut().dispatch_clients(state);
            }
            Ok(PostAction::Continue)
        })
        .expect("display source");

    // SAFETY: fd 0 is stdin, owned by this process for its whole life.
    let stdin = unsafe { std::fs::File::from_raw_fd(0) };
    let mut reader = wire::Reader::default();
    let signal = event_loop.get_signal();
    handle
        .insert_source(Generic::new(stdin, Interest::READ, Mode::Level), move |_, stdin, state| {
            let mut buf = [0u8; 64 * 1024];
            // SAFETY: the file stays owned by the source.
            match unsafe { stdin.get_mut() }.read(&mut buf) {
                Ok(0) | Err(_) => {
                    // Din went away; so do its windows.
                    signal.stop();
                    return Ok(PostAction::Remove);
                }
                Ok(n) => reader.push(&buf[..n]),
            }
            while let Some(message) = reader.next() {
                state.handle_message(&message);
            }
            Ok(PostAction::Continue)
        })
        .expect("stdin source");

    handle
        .insert_source(clipboard_rx, |event, _, state| {
            if let channel::Event::Msg((text, from_x11)) = event {
                // So the text coming back from Din leaves the X app owning it.
                if from_x11 {
                    state.x11_clipboard = Some(Arc::new(text.clone()));
                }
                state.wire.json(serde_json::json!({ "type": "clipboard", "text": text }));
            }
        })
        .expect("clipboard source");

    let xdisplay = xwayland::start(&mut state);

    state.wire.json(serde_json::json!({
        "type": "ready",
        "socket": socket_name,
        // DISPLAY for X11 apps, when Xwayland runs.
        "xwayland": xdisplay.map(|n| format!(":{n}")),
        // One path or the other: buffers with a GPU, the stream without.
        "frames": if buffers_path.is_some() { None } else { Some(frames_url) },
        "buffers": buffers_path,
    }));
    state.wire.flush();

    event_loop
        .run(Some(Duration::from_millis(16)), &mut state, |state| {
            state.flush();
            let _ = state.dh.flush_clients();
        })
        .expect("event loop");
}
