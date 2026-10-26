//! din-fd: the one thing Node can't do for Din's embedded display -
//! receive file descriptors over a Unix socket (SCM_RIGHTS) - and the
//! datagram it can't send to systemd's watchdog (`notify`).
//!
//! The Wayland compositor (native/din-compositor) renders each window on the
//! GPU into dmabufs. Electron can show a dmabuf without copying it
//! (`sharedTexture.importSharedTexture`), but only if its file descriptor is
//! open in the main process. This addon connects to the compositor's buffer
//! socket and delivers each message, with any descriptors attached, to a JS
//! callback. A reader thread does the blocking I/O; the callback runs on the
//! main thread through a threadsafe function.
//!
//! Messages are a little-endian u32 length and that many payload bytes;
//! descriptors ride on the first byte of their message.

use std::{
    io,
    os::{fd::RawFd, unix::net::UnixStream},
    os::fd::AsRawFd,
    thread,
};

use napi::{
    bindgen_prelude::*,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

/// Most descriptors one message may carry (one per plane of a buffer).
const MAX_FDS: usize = 4;

/// Read exactly `buf.len()` bytes, collecting any descriptors that arrive.
fn read_with_fds(socket: RawFd, buf: &mut [u8], fds: &mut Vec<i32>) -> io::Result<()> {
    let mut filled = 0;
    while filled < buf.len() {
        let mut iov = libc::iovec {
            iov_base: buf[filled..].as_mut_ptr().cast(),
            iov_len: buf.len() - filled,
        };
        // SAFETY: CMSG_SPACE is a pure size computation.
        let space = unsafe { libc::CMSG_SPACE((MAX_FDS * size_of::<i32>()) as u32) } as usize;
        let mut control = vec![0u8; space];
        // SAFETY: zeroed msghdr is a valid empty header; fields set below.
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = control.as_mut_ptr().cast();
        msg.msg_controllen = space as _;
        // SAFETY: msg points at live buffers sized as declared.
        let n = unsafe { libc::recvmsg(socket, &mut msg, libc::MSG_CMSG_CLOEXEC) };
        if n < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        // SAFETY: walking the control buffer recvmsg just filled.
        unsafe {
            let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
            while !cmsg.is_null() {
                if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                    let data = libc::CMSG_DATA(cmsg).cast::<i32>();
                    let count = ((*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize) / size_of::<i32>();
                    for i in 0..count {
                        fds.push(std::ptr::read_unaligned(data.add(i)));
                    }
                }
                cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
            }
        }
        filled += n as usize;
    }
    Ok(())
}

/// One message: its payload and the descriptors it carried (now open in
/// this process; the receiver owns them).
#[napi(object)]
pub struct FdMessage {
    pub payload: Buffer,
    pub fds: Vec<i32>,
}

/// Connect to `path` and call `on_message` for every message, then
/// `on_close` once when the socket closes. Returns nothing; the reader
/// thread lives as long as the connection.
#[napi]
pub fn connect(
    path: String,
    on_message: ThreadsafeFunction<FdMessage, (), FdMessage, Status, false>,
    on_close: ThreadsafeFunction<(), (), (), Status, false>,
) -> Result<()> {
    let stream = UnixStream::connect(&path)
        .map_err(|e| Error::from_reason(format!("din-fd: connect {path}: {e}")))?;
    thread::spawn(move || {
        let fd = stream.as_raw_fd();
        loop {
            let mut fds = Vec::new();
            let mut header = [0u8; 4];
            if read_with_fds(fd, &mut header, &mut fds).is_err() {
                break;
            }
            let mut payload = vec![0u8; u32::from_le_bytes(header) as usize];
            if read_with_fds(fd, &mut payload, &mut fds).is_err() {
                break;
            }
            let message = FdMessage { payload: payload.into(), fds };
            on_message.call(message, ThreadsafeFunctionCallMode::Blocking);
        }
        on_close.call((), ThreadsafeFunctionCallMode::Blocking);
        drop(stream);
    });
    Ok(())
}

/// Send `state` (e.g. "WATCHDOG=1") to systemd's notify socket at `socket`,
/// the value of $NOTIFY_SOCKET. Node has no Unix datagram sockets, and a
/// `systemd-notify` child exits before systemd can tell whose message it was.
#[napi]
pub fn notify(socket: String, state: String) -> Result<()> {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::{SocketAddr, UnixDatagram};
    let fail = |e: io::Error| Error::from_reason(format!("din-fd: notify {socket}: {e}"));
    let address = match socket.strip_prefix('@') {
        Some(name) => SocketAddr::from_abstract_name(name),
        None => SocketAddr::from_pathname(&socket),
    }
    .map_err(fail)?;
    let datagram = UnixDatagram::unbound().map_err(fail)?;
    datagram.send_to_addr(state.as_bytes(), &address).map_err(fail)?;
    Ok(())
}

/// Close a descriptor this addon handed out, once nothing needs it.
#[napi]
pub fn close(fd: i32) {
    // SAFETY: closing a descriptor the caller owns.
    unsafe {
        libc::close(fd);
    }
}
