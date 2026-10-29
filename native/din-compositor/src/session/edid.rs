//! A display's make, model and serial number, from its EDID: what wlr-randr
//! and Din's display settings show for it.

use smithay::reexports::drm::control::{Device as ControlDevice, connector, property};

#[derive(Clone, Debug, Default)]
pub struct Info {
    /// The manufacturer's three-letter PNP id ("SAM", "AUO").
    pub make: String,
    pub model: String,
    pub serial: String,
}

pub fn for_connector(device: &impl ControlDevice, connector: connector::Handle) -> Info {
    edid(device, connector).map(|edid| parse(&edid)).unwrap_or_default()
}

fn edid(device: &impl ControlDevice, connector: connector::Handle) -> Option<Vec<u8>> {
    let props = device.get_properties(connector).ok()?;
    let (handles, values) = props.as_props_and_values();
    for (handle, value) in handles.iter().zip(values) {
        let info = device.get_property(*handle).ok()?;
        if info.name().to_str() != Ok("EDID") {
            continue;
        }
        let property::Value::Blob(blob) = info.value_type().convert_value(*value) else { return None };
        if blob == 0 {
            return None;
        }
        return device.get_property_blob(blob).ok();
    }
    None
}

fn parse(edid: &[u8]) -> Info {
    if edid.len() < 128 || edid[..8] != [0, 255, 255, 255, 255, 255, 255, 0] {
        return Info::default();
    }
    let id = u16::from_be_bytes([edid[8], edid[9]]);
    let make: String = [(id >> 10) & 31, (id >> 5) & 31, id & 31]
        .iter()
        .filter(|&&c| (1..=26).contains(&c))
        .map(|&c| (b'A' + c as u8 - 1) as char)
        .collect();
    let mut info = Info { make, ..Info::default() };
    // Four 18-byte descriptors; display descriptors start with three zeros.
    for d in edid[54..126].chunks(18) {
        if d[..3] != [0, 0, 0] {
            continue;
        }
        let text = || {
            let raw = &d[5..18];
            let end = raw.iter().position(|&b| b == b'\n').unwrap_or(raw.len());
            String::from_utf8_lossy(&raw[..end]).trim().to_owned()
        };
        match d[3] {
            0xfc => info.model = text(),
            0xff => info.serial = text(),
            _ => {}
        }
    }
    if info.model.is_empty() {
        info.model = format!("{:#06x}", u16::from_le_bytes([edid[10], edid[11]]));
    }
    if info.serial.is_empty() {
        let serial = u32::from_le_bytes([edid[12], edid[13], edid[14], edid[15]]);
        if serial != 0 {
            info.serial = serial.to_string();
        }
    }
    info
}
