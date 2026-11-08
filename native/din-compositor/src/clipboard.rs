//! What the clipboard (or a drag) carries between Din and apps: text, files,
//! and images.
//!
//! Files travel the way file managers pass them: as a text/uri-list of
//! file:// URIs, plus GNOME's x-special/gnome-copied-files, which also says
//! whether they were cut, and their paths as text for apps that only paste
//! text (terminals, editors). Images are PNG.
//!
//! The shell speaks JSON: `{ text, files: [paths], cut, image: base64 PNG }`,
//! any of them absent.

use std::{
    io::{Read, Write},
    os::fd::OwnedFd,
    sync::{Arc, mpsc},
};

use serde_json::{Value, json};

/// Text and file lists larger than this aren't bridged.
pub const MAX_TEXT_BYTES: u64 = 256 * 1024;
/// Nor are images larger than this.
pub const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// The text types offered to Wayland apps, in order of preference.
const TEXT_MIME_TYPES: [&str; 5] = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING", "STRING", "TEXT"];
/// The text types offered to X apps: UTF8_STRING and TEXT (which the window
/// manager maps to these), and plain STRING for older clients.
const X11_TEXT_TYPES: [&str; 3] = ["text/plain;charset=utf-8", "text/plain", "STRING"];

/// How files are dragged (GNOME's type is for the clipboard only).
pub const URI_LIST: &str = "text/uri-list";
const GNOME_FILES: &str = "x-special/gnome-copied-files";
const PNG: &str = "image/png";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Contents {
    pub text: Option<String>,
    /// Absolute paths.
    pub files: Vec<String>,
    /// The files were cut rather than copied.
    pub cut: bool,
    pub image: Option<Vec<u8>>,
}

impl Contents {
    /// Files to drag into an app.
    pub fn files(paths: Vec<String>) -> Self {
        Self { files: paths, ..Self::default() }
    }

    /// The clipboard the shell sent, or None if it carries nothing usable.
    pub fn from_shell(message: &Value) -> Option<Self> {
        let text = message
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty() && text.len() as u64 <= MAX_TEXT_BYTES)
            .map(String::from);
        let files = paths(message.get("files"));
        let image = message
            .get("image")
            .and_then(Value::as_str)
            .and_then(|data| data_encoding::BASE64.decode(data.as_bytes()).ok())
            .filter(|png| !png.is_empty() && png.len() as u64 <= MAX_IMAGE_BYTES);
        let contents = Self { text, files, cut: message["cut"] == true, image };
        (!contents.is_empty()).then_some(contents)
    }

    fn is_empty(&self) -> bool {
        self.text.is_none() && self.files.is_empty() && self.image.is_none()
    }

    /// The message telling the shell what an app copied.
    pub fn to_shell(&self) -> Value {
        let mut message = json!({ "type": "clipboard" });
        if let Some(text) = &self.text {
            message["text"] = json!(text);
        }
        if !self.files.is_empty() {
            message["files"] = json!(self.files);
            message["cut"] = json!(self.cut);
        }
        if let Some(image) = &self.image {
            message["image"] = json!(data_encoding::BASE64.encode(image));
        }
        message
    }

    /// The types it's offered as, best first.
    pub fn mime_types(&self, x11: bool) -> Vec<String> {
        let mut mimes = Vec::new();
        if !self.files.is_empty() {
            mimes.extend([URI_LIST, GNOME_FILES]);
        }
        if self.image.is_some() {
            mimes.push(PNG);
        }
        if self.text.is_some() {
            mimes.extend(if x11 { &X11_TEXT_TYPES[..] } else { &TEXT_MIME_TYPES[..] });
        }
        mimes.into_iter().map(String::from).collect()
    }

    /// The contents as `mime`, if they come in that type.
    pub fn bytes(&self, mime: &str) -> Option<Vec<u8>> {
        let uris = || self.files.iter().map(|path| file_uri(path)).collect::<Vec<_>>();
        match mime {
            _ if self.files.is_empty() && (mime == URI_LIST || mime == GNOME_FILES) => None,
            URI_LIST => Some(uris().iter().map(|uri| format!("{uri}\r\n")).collect::<String>().into_bytes()),
            GNOME_FILES => {
                let op = if self.cut { "cut" } else { "copy" };
                Some(std::iter::once(op.to_string()).chain(uris()).collect::<Vec<_>>().join("\n").into_bytes())
            }
            PNG => self.image.clone(),
            // STRING is Latin-1 (ICCCM).
            "STRING" => {
                let text = self.text.as_ref()?;
                Some(text.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect())
            }
            _ if TEXT_MIME_TYPES.contains(&mime) => self.text.as_ref().map(|text| text.as_bytes().to_vec()),
            _ => None,
        }
    }

    /// Write the contents as `mime` to an app that's pasting or dropping
    /// them, off the event loop: the app reads at its own pace.
    pub fn send(self: &Arc<Self>, mime: &str, fd: OwnedFd) {
        let Some(bytes) = self.bytes(mime) else { return };
        std::thread::spawn(move || {
            let _ = std::fs::File::from(fd).write_all(&bytes);
        });
    }

    /// What an app copied, from the types it offered as they read.
    fn from_app(parts: Vec<(String, Vec<u8>)>) -> Option<Self> {
        let part = |mime: &str| parts.iter().find(|(m, _)| m == mime).map(|(_, bytes)| bytes.as_slice());
        let mut contents = Self::default();
        if let Some(list) = part(GNOME_FILES).and_then(|bytes| std::str::from_utf8(bytes).ok()) {
            let mut lines = list.lines();
            contents.cut = lines.next() == Some("cut");
            contents.files = parse_uris(lines).unwrap_or_default();
        }
        if let Some(files) = part(URI_LIST).and_then(|bytes| std::str::from_utf8(bytes).ok()).and_then(|list| parse_uris(list.lines())) {
            contents.files = files;
        }
        contents.image = part(PNG).map(<[u8]>::to_vec);
        contents.text = parts.iter().find_map(|(mime, bytes)| match mime.as_str() {
            "STRING" => Some(bytes.iter().map(|&b| char::from(b)).collect()),
            m if TEXT_MIME_TYPES.contains(&m) => String::from_utf8(bytes.clone()).ok(),
            _ => None,
        });
        (!contents.is_empty()).then_some(contents)
    }
}

/// An app copied something offered as `offered`: read what Din can use.
///
/// `request` asks the app for one type, into a pipe; each is read on a
/// thread of its own (an X app's transfers are pumped by the event loop, so
/// nothing here may block it), and `done` gets the result.
pub fn read_from_app(
    offered: &[String],
    text_types: &[&str],
    mut request: impl FnMut(&str, OwnedFd) -> bool,
    done: impl FnOnce(Contents) + Send + 'static,
) {
    let has = |mime: &str| offered.iter().any(|m| m == mime);
    let mut wanted: Vec<&str> = [URI_LIST, GNOME_FILES, PNG].into_iter().filter(|m| has(m)).collect();
    wanted.extend(text_types.iter().copied().find(|m| has(m)));

    let (tx, rx) = mpsc::channel();
    let mut count = 0;
    for mime in wanted {
        let Ok((mut reader, writer)) = std::io::pipe() else { continue };
        if !request(mime, OwnedFd::from(writer)) {
            continue;
        }
        count += 1;
        let limit = if mime == PNG { MAX_IMAGE_BYTES } else { MAX_TEXT_BYTES };
        let (tx, mime) = (tx.clone(), mime.to_string());
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let ok = reader.by_ref().take(limit + 1).read_to_end(&mut bytes).is_ok();
            // Too big is left out, rather than cut short.
            let _ = tx.send((ok && bytes.len() as u64 <= limit && !bytes.is_empty()).then_some((mime, bytes)));
        });
    }
    drop(tx);
    if count == 0 {
        return;
    }
    std::thread::spawn(move || {
        let parts: Vec<_> = rx.iter().take(count).flatten().collect();
        if let Some(contents) = Contents::from_app(parts) {
            done(contents);
        }
    });
}

/// Absolute paths from a JSON array.
fn paths(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).filter(|p| p.starts_with('/')).map(String::from).collect())
        .unwrap_or_default()
}

/// A path as a file:// URI.
fn file_uri(path: &str) -> String {
    let mut uri = String::from("file://");
    for &byte in path.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~!$&'()*+,;=:@".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

/// Local paths from a URI list, or None if it lists anything else (web
/// links are text, not files).
fn parse_uris<'a>(lines: impl Iterator<Item = &'a str>) -> Option<Vec<String>> {
    let mut files = Vec::new();
    for line in lines.map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let rest = line.strip_prefix("file://")?;
        let path = rest.strip_prefix("localhost").unwrap_or(rest);
        if !path.starts_with('/') {
            return None;
        }
        files.push(percent_decode(path)?);
    }
    (!files.is_empty()).then_some(files)
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_round_trip() {
        let contents = Contents::files(vec!["/home/din/a b/ü#.png".into()]);
        let list = String::from_utf8(contents.bytes(URI_LIST).unwrap()).unwrap();
        assert_eq!(list, "file:///home/din/a%20b/%C3%BC%23.png\r\n");
        let copied = String::from_utf8(contents.bytes(GNOME_FILES).unwrap()).unwrap();
        let parsed = Contents::from_app(vec![(GNOME_FILES.into(), format!("cut\n{}", list.trim()).into_bytes())]).unwrap();
        assert_eq!(parsed.files, contents.files);
        assert!(parsed.cut);
        assert!(copied.starts_with("copy\n"));
    }

    #[test]
    fn web_links_are_text() {
        let parts = vec![
            (URI_LIST.into(), b"https://example.com/\r\n".to_vec()),
            ("text/plain;charset=utf-8".into(), b"https://example.com/".to_vec()),
        ];
        let contents = Contents::from_app(parts).unwrap();
        assert!(contents.files.is_empty());
        assert_eq!(contents.text.as_deref(), Some("https://example.com/"));
    }
}
