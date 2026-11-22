//! The WebAssembly boundary of Myco's gamepad mapping (ADR 0335). The web's gamepad adapter
//! (`src/engine/input/`) loads it to name controllers and to read raw (non-"standard") browser
//! gamepads through the SDL controller database. Control order everywhere is the wire order of
//! [`control_names`]: 23 buttons, then 4 axes.
use input_map::{Platform, AXES, BUTTONS};
use wasm_bindgen::prelude::*;

/// The controller family: 0 generic, 1 Xbox, 2 PlayStation, 3 Switch.
#[wasm_bindgen]
pub fn family_of(vendor: u16, product: u16, name: &str) -> u8 {
    input_map::family_of(vendor, product, name) as u8
}

/// Vendor and product from a browser `Gamepad.id` as `vendor << 16 | product` (read it with
/// `>>> 16` and `& 0xffff`: a vendor from 0x8000 up makes the number negative), or -1 if the id
/// names neither.
#[wasm_bindgen]
pub fn parse_web_gamepad_id(id: &str) -> i32 {
    match input_map::parse_web_gamepad_id(id) {
        Some((0xffff, 0xffff)) | None => -1,
        Some((vendor, product)) => ((vendor as u32) << 16 | product as u32) as i32,
    }
}

/// A raw browser gamepad's layout from the SDL database, for `platform` (0 Windows, 1 macOS,
/// 2 Linux, 3 other), or `undefined` if the controller isn't known there. 27 `[kind, index]` pairs
/// in wire order; kind 0 none, 1 raw button, 2 raw axis (-1..1), 3 raw axis positive half (0..1),
/// 4 raw axis negative half (0..1), 5 raw axis inverted (-1..1), 6 hat (index = hat * 16 + SDL hat
/// mask: 1 up, 2 right, 4 down, 8 left).
#[wasm_bindgen]
pub fn web_mapping(vendor: u16, product: u16, platform: u8) -> Option<Vec<i16>> {
    let mapping = input_map::web_mapping(vendor, product, Platform::from_u8(platform))?;
    Some(mapping.controls.iter().flat_map(|s| s.wire()).collect())
}

/// The 23 button names, then the 4 axis names, comma-separated, in wire order.
#[wasm_bindgen]
pub fn control_names() -> String {
    BUTTONS.iter().chain(AXES.iter()).copied().collect::<Vec<_>>().join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_pack_vendor_and_product() {
        assert_eq!(parse_web_gamepad_id("045e-028e-Xbox 360 Controller"), 0x045e_028e);
        assert_eq!(parse_web_gamepad_id("8bad-0001-Pad") as u32, 0x8bad_0001);
        assert_eq!(parse_web_gamepad_id("ffff-ffff-Pad"), -1);
        assert_eq!(parse_web_gamepad_id("xinput"), -1);
    }

    #[test]
    fn mappings_are_27_pairs() {
        let m = web_mapping(0x054c, 0x05c4, 2).unwrap();
        assert_eq!(m.len(), 27 * 2);
        assert_eq!(&m[23 * 2..23 * 2 + 2], &[2, 0]); // leftStickX ← axes[0]
        assert!(web_mapping(0xfffe, 0xfffe, 0).is_none());
    }

    #[test]
    fn names() {
        let names = control_names();
        assert_eq!(names.split(',').count(), 27);
        assert!(names.starts_with("buttonSouth,buttonEast,"));
        assert!(names.ends_with(",touchpadPress,leftStickX,leftStickY,rightStickX,rightStickY"));
        assert_eq!(family_of(0x057e, 0x2009, ""), 3);
    }
}
