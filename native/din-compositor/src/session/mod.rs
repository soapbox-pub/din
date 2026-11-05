//! The session compositor: Din's own screen, in place of a kiosk compositor.
//!
//! It drives the GPU's displays through DRM/KMS (drm.rs) and the keyboard,
//! pointer and touchscreen through libinput (input.rs), from a seat session
//! (libseat, through logind), and runs one program: Din. Din's one window
//! spans every display, at the top-left of their layout, and anything else
//! that opens a window is asked to close (shell.rs); its menus and the like
//! show as popups over it.
//!
//! Frames are paced the way a game's are: Din hears that its last frame is on
//! screen right after the refresh, and the compositor commits the next one
//! DIN_MAX_RENDER_TIME ms (4 by default) before the following refresh, so a
//! frame Din finishes in time is on screen at that refresh. Din's buffers
//! are usually scanned out as they are; the compositor composites only when
//! a popup, the pointer or a second display needs it.
//!
//! For everything else on the computer it speaks the wlroots protocols:
//! output management (wlr-randr, Din's display settings and deckmon's AirPlay
//! displays), screencopy (grim and deckmon) and gamma control (night light),
//! and one of its own for displays with no screen, which deckmon adds to
//! extend the desktop onto a TV (virtual_output.rs).
//!
//! Settings → Accessibility's zoom, colour filters and keyboard aids are
//! the compositor's, so they reach every app (accessibility.rs), as are
//! Settings → Keyboard's layouts and which of them is typing (layouts.rs).
//!
//! A native app in full screen (a game) skips Din's window: Din's embedded
//! compositor hands its frames here, drawn over Din's window on their monitor
//! and paced by its refresh (direct.rs). On a display that can vary its
//! refresh (FreeSync, Adaptive-Sync), it does while a game is on it: each of
//! the game's frames goes to the screen as soon as it's done.
//!
//! The Wayland socket is `din-shell` in XDG_RUNTIME_DIR. The compositor exits
//! when Din does, with its exit status.

mod accessibility;
mod cursor;
mod direct;
mod drm;
mod edid;
mod gamma;
mod input;
mod keys;
mod layouts;
mod magic_mouse;
mod mouse;
mod output_management;
mod render;
mod screencopy;
mod shake;
mod shell;
mod state;
mod virtual_output;
mod virtual_pointer;

use std::{process::Command, sync::Arc};

use smithay::{
    reexports::{
        calloop::{EventLoop, Interest, Mode, PostAction, channel, generic::Generic},
        wayland_server::Display,
    },
    wayland::socket::ListeningSocketSource,
};
use tracing::{error, info, warn};

use state::{ClientState, State};

/// The Wayland socket's name: only Din and what it starts are told it, so
/// nothing that guesses wayland-0 opens a window in place of Din.
pub const SOCKET: &str = "din-shell";

/// How far behind on its events a client may fall before it's cut off: a
/// few seconds of a fast mouse. The buffer only grows to it as needed.
const CLIENT_BUFFER: usize = 16 << 20;

/// Runs the screen until the program in ARGS (after an optional `--`) exits,
/// and returns its exit status.
pub fn run(args: &[String]) -> i32 {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("DIN_COMPOSITOR_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,smithay=warn")),
        )
        .with_ansi(false)
        .without_time()
        .with_writer(std::io::stderr)
        .init();

    let program: Vec<String> = match args.first().map(String::as_str) {
        Some("--") => args[1..].to_vec(),
        _ => args.to_vec(),
    };
    if program.is_empty() {
        eprintln!("usage: din-compositor session -- PROGRAM [ARGS...]");
        return 2;
    }

    let mut event_loop: EventLoop<'static, State> = match EventLoop::try_new() {
        Ok(event_loop) => event_loop,
        Err(err) => {
            error!("event loop: {err}");
            return 1;
        }
    };
    let display: Display<State> = Display::new().expect("wayland display");
    // Din reads its Wayland events on Node's thread, which a busy moment
    // keeps from them; past the default 4 KiB unread, Din was cut off, and
    // the session with it.
    display.handle().set_default_max_buffer_size(CLIENT_BUFFER);
    let mut state = match State::new(&display, event_loop.handle(), event_loop.get_signal()) {
        Ok(state) => state,
        Err(err) => {
            // A GPU whose driver isn't loaded yet; systemd tries again.
            error!("{err}");
            return 1;
        }
    };

    cursor::watch_settings(&event_loop.handle(), &mut state);

    event_loop
        .handle()
        .insert_source(Generic::new(display, Interest::READ, Mode::Level), |_, display, state| {
            // SAFETY: the display is never dropped while the loop runs.
            unsafe {
                let _ = display.get_mut().dispatch_clients(state);
            }
            Ok(PostAction::Continue)
        })
        .expect("display source");

    // The socket appears once the screen is lit with the first frame, which
    // is what tells the boot screen it can go.
    let socket = match ListeningSocketSource::with_name(SOCKET) {
        Ok(socket) => socket,
        Err(err) => {
            error!("the Wayland socket {SOCKET}: {err}");
            return 1;
        }
    };
    event_loop
        .handle()
        .insert_source(socket, |stream, _, state| {
            match state.dh.insert_client(stream, Arc::new(ClientState::default())) {
                Ok(client) => {
                    if let (Ok(credentials), Some(data)) = (client.get_credentials(&state.dh), client.get_data::<ClientState>()) {
                        let _ = data.pid.set(credentials.pid);
                    }
                }
                Err(err) => warn!("adding a client: {err}"),
            }
        })
        .expect("socket source");

    // Full-screen games' frames, from Din's embedded compositor (direct.rs).
    let direct_socket = match state.direct.listener() {
        Ok(listener) => {
            event_loop
                .handle()
                .insert_source(Generic::new(listener, Interest::READ, Mode::Level), |_, _, state| {
                    state.direct_accept();
                    Ok(PostAction::Continue)
                })
                .expect("direct socket source");
            Some(state.direct.path.clone())
        }
        Err(_) => None,
    };

    let mut command = Command::new(&program[0]);
    command.args(&program[1..]).env("WAYLAND_DISPLAY", SOCKET);
    if let Some(path) = &direct_socket {
        command.env("DIN_DIRECT_SOCKET", path);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            error!("starting {}: {err}", program[0]);
            return 1;
        }
    };
    state.din_pid = child.id();
    info!("started {} on {SOCKET}", program[0]);

    let name = program[0].clone();
    let (exit_tx, exit_rx) = channel::channel::<i32>();
    std::thread::spawn(move || {
        use std::os::unix::process::ExitStatusExt;
        let code = match child.wait() {
            Ok(status) => status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
            Err(_) => 1,
        };
        let _ = exit_tx.send(code);
    });
    event_loop
        .handle()
        .insert_source(exit_rx, move |event, _, state| {
            if let channel::Event::Msg(code) = event {
                info!("{name} exited with {code}");
                state.exit_code = code;
                state.signal.stop();
            }
        })
        .expect("child source");

    if let Err(err) = event_loop.run(None, &mut state, |state| state.refresh()) {
        error!("event loop: {err}");
        return 1;
    }
    state.exit_code
}
