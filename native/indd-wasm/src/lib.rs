//! InDesign documents to IDML, for Page Layout: `indd::convert` behind a
//! plain WebAssembly interface that needs nothing from its host.
//!
//! The host asks `alloc` for room, copies the INDD bytes and the document
//! name in, and calls `convert`. The result waits in `output` until the next
//! call: on success the package, the previews of linked graphics and the
//! warnings, each length-prefixed (u32, little-endian); on failure the error
//! message as UTF-8.

use std::sync::Mutex;

static OUTPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// Room for `len` bytes, for the host to fill and pass to `convert`.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    std::mem::ManuallyDrop::new(Vec::<u8>::with_capacity(len)).as_mut_ptr()
}

fn put(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

/// Convert the `len` bytes at `input`, named by the `name_len` bytes at
/// `name` (both from `alloc`, and taken back here). Returns the length of
/// the output, positive for a conversion and negative for an error.
///
/// # Safety
///
/// Both buffers come from `alloc` with these lengths and are filled.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn convert(input: *mut u8, len: usize, name: *mut u8, name_len: usize) -> isize {
    let input = unsafe { Vec::from_raw_parts(input, len, len) };
    let name = unsafe { Vec::from_raw_parts(name, name_len, name_len) };
    let Ok(mut out) = OUTPUT.lock() else { return 0 };
    out.clear();
    match indd::convert(&input, &String::from_utf8_lossy(&name)) {
        Ok(c) => {
            put(&mut out, &c.idml);
            out.extend_from_slice(&(c.previews.len() as u32).to_le_bytes());
            for p in &c.previews {
                out.extend_from_slice(&(p.graphics.len() as u32).to_le_bytes());
                for g in &p.graphics {
                    put(&mut out, g.as_bytes());
                }
                put(&mut out, &p.data);
            }
            out.extend_from_slice(&(c.warnings.len() as u32).to_le_bytes());
            for w in &c.warnings {
                put(&mut out, w.message().as_bytes());
            }
            out.len() as isize
        }
        Err(e) => {
            out.extend_from_slice(e.to_string().as_bytes());
            -(out.len() as isize).max(1)
        }
    }
}

/// The output of the last `convert`.
#[unsafe(no_mangle)]
pub extern "C" fn output() -> *const u8 {
    OUTPUT.lock().map_or(std::ptr::null(), |o| o.as_ptr())
}
