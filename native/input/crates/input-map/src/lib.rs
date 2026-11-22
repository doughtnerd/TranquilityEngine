//! Gamepad identification and mapping for Myco's input system (ADR 0335), shared by the web
//! (compiled to wasm by `input-wasm`) and, by the same rules, the desktop SDL3 adapter.
//!
//! * [`Family`] and [`family_of`]: which kind of controller a vendor id, product id and name
//!   describe (glyph sets and defaults key on it).
//! * [`parse_web_gamepad_id`]: vendor and product from a browser `Gamepad.id`.
//! * [`web_mapping`]: for a browser gamepad without the `"standard"` mapping, where each of the
//!   engine's controls ([`BUTTONS`], [`AXES`], in wire order) comes from in its raw buttons, axes
//!   and hats, from the SDL controller database (`db/gamecontrollerdb.txt`, zlib licence,
//!   <https://github.com/mdqinc/SDL_GameControllerDB>).
//!
//! Wire order is the W3C "standard" gamepad's (buttons 0..16, axes 0..3, +Y down) followed by the
//! extra buttons SDL knows (misc1, paddles, touchpad press).
use std::sync::OnceLock;

/// The engine's gamepad buttons, in wire order (W3C standard order, then extras).
pub const BUTTONS: [&str; 23] = [
    "buttonSouth",
    "buttonEast",
    "buttonWest",
    "buttonNorth",
    "leftShoulder",
    "rightShoulder",
    "leftTrigger",
    "rightTrigger",
    "select",
    "start",
    "leftStickPress",
    "rightStickPress",
    "dpadUp",
    "dpadDown",
    "dpadLeft",
    "dpadRight",
    "home",
    "misc1",
    "rightPaddle1",
    "leftPaddle1",
    "rightPaddle2",
    "leftPaddle2",
    "touchpadPress",
];

/// The engine's gamepad axes, in wire order (-1..1, +X right, +Y down).
pub const AXES: [&str; 4] = ["leftStickX", "leftStickY", "rightStickX", "rightStickY"];

/// Every control in wire order: the buttons, then the axes.
pub const CONTROL_COUNT: usize = BUTTONS.len() + AXES.len();

/// The SDL mapping-string name of each control in wire order ([`BUTTONS`] then [`AXES`]).
const SDL_NAMES: [&str; CONTROL_COUNT] = [
    "a",
    "b",
    "x",
    "y",
    "leftshoulder",
    "rightshoulder",
    "lefttrigger",
    "righttrigger",
    "back",
    "start",
    "leftstick",
    "rightstick",
    "dpup",
    "dpdown",
    "dpleft",
    "dpright",
    "guide",
    "misc1",
    "paddle1",
    "paddle2",
    "paddle3",
    "paddle4",
    "touchpad",
    "leftx",
    "lefty",
    "rightx",
    "righty",
];

/// A controller family: which glyphs and conventions apply. The discriminants are the wire values.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Family {
    Generic = 0,
    Xbox = 1,
    PlayStation = 2,
    Switch = 3,
}

/// The family of a controller from its USB vendor and product ids and its name. First-party
/// vendors decide it (Microsoft, Sony, Nintendo); third-party pads go by name.
pub fn family_of(vendor: u16, _product: u16, name: &str) -> Family {
    match vendor {
        0x045e => return Family::Xbox,
        0x054c => return Family::PlayStation,
        0x057e => return Family::Switch,
        _ => {}
    }
    let name = name.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| name.contains(w));
    if has(&["xbox", "xinput", "x-box"]) {
        Family::Xbox
    } else if has(&["dualshock", "dualsense", "playstation", "ps3", "ps4", "ps5"]) {
        Family::PlayStation
    } else if has(&["pro controller", "joy-con", "joycon", "nintendo", "switch"]) {
        Family::Switch
    } else {
        Family::Generic
    }
}

/// Vendor and product ids from a browser's `Gamepad.id`: Chrome and Edge write
/// `"Name (STANDARD GAMEPAD Vendor: 045e Product: 028e)"`, Firefox and Safari `"45e-28e-Name"`
/// (zero-padded or not). `None` when the id names neither (Chrome's bare XInput ids, for one).
pub fn parse_web_gamepad_id(id: &str) -> Option<(u16, u16)> {
    if let (Some(v), Some(p)) = (id.find("Vendor: "), id.find("Product: ")) {
        let vendor = leading_hex(&id[v + 8..])?;
        let product = leading_hex(&id[p + 9..])?;
        return Some((vendor, product));
    }
    let mut parts = id.splitn(3, '-');
    let (vendor, product) = (parts.next()?, parts.next()?);
    parts.next()?; // the name: a bare "045e-028e" isn't the Firefox form
    Some((hex_u16(vendor)?, hex_u16(product)?))
}

/// The 1–4 hex digits at the start of `s`.
fn leading_hex(s: &str) -> Option<u16> {
    let end = s.find(|c: char| !c.is_ascii_hexdigit()).unwrap_or(s.len());
    hex_u16(&s[..end.min(4)])
}

/// A whole string of 1–4 hex digits.
fn hex_u16(s: &str) -> Option<u16> {
    if s.is_empty() || s.len() > 4 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(s, 16).ok()
}

/// The platform a browser runs on, which decides how it numbers a raw gamepad's buttons and axes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Platform {
    Windows = 0,
    MacOs = 1,
    Linux = 2,
    Other = 3,
}

impl Platform {
    /// From the wire value; anything unknown is [`Platform::Other`].
    pub fn from_u8(value: u8) -> Platform {
        match value {
            0 => Platform::Windows,
            1 => Platform::MacOs,
            2 => Platform::Linux,
            _ => Platform::Other,
        }
    }

    /// The `platform:` names in the database this platform reads, most specific first. Other
    /// platforms (ChromeOS, Android browsers) read Linux's: both number evdev devices the same way.
    fn db_names(self) -> &'static [&'static str] {
        match self {
            Platform::Windows => &["Windows"],
            Platform::MacOs => &["Mac OS X"],
            Platform::Linux => &["Linux"],
            Platform::Other => &["Linux", "Android"],
        }
    }
}

/// Where one control's value comes from in a raw browser gamepad.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Source {
    /// The pad doesn't have the control.
    #[default]
    None,
    /// `buttons[i]`.
    Button(u8),
    /// `axes[i]`, -1..1.
    Axis(u8),
    /// `axes[i]` from 0 to 1 (the negative half reads 0).
    AxisPositive(u8),
    /// `-axes[i]` from 0 to 1 (the positive half reads 0).
    AxisNegative(u8),
    /// `-axes[i]`, -1..1.
    AxisInverted(u8),
    /// A hat's direction: hat number and SDL hat mask (1 up, 2 right, 4 down, 8 left).
    Hat(u8, u8),
}

impl Source {
    /// The wire form `[kind, index]` (see the `input-wasm` crate).
    pub fn wire(self) -> [i16; 2] {
        match self {
            Source::None => [0, 0],
            Source::Button(i) => [1, i as i16],
            Source::Axis(i) => [2, i as i16],
            Source::AxisPositive(i) => [3, i as i16],
            Source::AxisNegative(i) => [4, i as i16],
            Source::AxisInverted(i) => [5, i as i16],
            Source::Hat(hat, mask) => [6, hat as i16 * 16 + mask as i16],
        }
    }
}

/// A raw gamepad's layout: the source of each control in wire order ([`BUTTONS`] then [`AXES`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mapping {
    /// The controller's name in the database.
    pub name: String,
    pub controls: [Source; CONTROL_COUNT],
}

impl Mapping {
    /// The source of a control by its engine name (`"buttonSouth"`, `"leftStickX"`…).
    pub fn control(&self, name: &str) -> Option<Source> {
        let i = BUTTONS.iter().chain(AXES.iter()).position(|n| *n == name)?;
        Some(self.controls[i])
    }
}

/// One database line, indexed by what matching needs; the mapping text is parsed on use.
struct Entry {
    vendor: u16,
    product: u16,
    /// The GUID's driver signature byte (0 for plain HID/DirectInput/evdev devices; `h` HIDAPI,
    /// `x` XInput, `v` virtual…): browsers see plain devices, so those entries are preferred.
    driver: u8,
    platform: &'static str,
    line: &'static str,
}

static DB_TEXT: &str = include_str!("../db/gamecontrollerdb.txt");
static DB: OnceLock<Vec<Entry>> = OnceLock::new();

/// The database's entries that carry a vendor and product id, parsed on first use.
fn db() -> &'static [Entry] {
    DB.get_or_init(|| DB_TEXT.lines().filter_map(index_line).collect())
}

/// `guid,name,mapping…,platform:X,` → an [`Entry`], if the GUID has the standard SDL layout
/// (16-bit bus, CRC, vendor, 0, product, 0, version, driver signature, driver data) with a vendor.
fn index_line(line: &'static str) -> Option<Entry> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let guid = parse_guid(line.split(',').next()?)?;
    let word = |i: usize| u16::from_le_bytes([guid[i * 2], guid[i * 2 + 1]]);
    if word(3) != 0 || word(5) != 0 || word(2) == 0 {
        return None;
    }
    let platform = line.split(',').find_map(|f| f.strip_prefix("platform:"))?;
    Some(Entry { vendor: word(2), product: word(4), driver: guid[14], platform, line })
}

fn parse_guid(text: &str) -> Option<[u8; 16]> {
    if text.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

/// The layout of a raw browser gamepad on `platform` from the SDL database, matched by vendor and
/// product id. `None` when the database doesn't know the controller there.
pub fn web_mapping(vendor: u16, product: u16, platform: Platform) -> Option<Mapping> {
    for name in platform.db_names() {
        let candidates = || db().iter().filter(|e| e.vendor == vendor && e.product == product && e.platform == *name);
        if let Some(entry) = candidates().find(|e| e.driver == 0).or_else(|| candidates().next()) {
            return parse_mapping(entry.line);
        }
    }
    None
}

/// A database line's mapping. Controls driven by half-axis targets (`+leftx:b3,-leftx:b2`: buttons
/// or hats acting as a stick) need two sources, which a [`Source`] can't say, so they read as none.
pub fn parse_mapping(line: &str) -> Option<Mapping> {
    let mut fields = line.trim().split(',');
    fields.next()?; // GUID
    let name = fields.next()?.to_string();
    let mut controls = [Source::None; CONTROL_COUNT];
    for field in fields {
        let Some((target, input)) = field.split_once(':') else { continue };
        let Some(i) = SDL_NAMES.iter().position(|n| *n == target) else { continue };
        if let Some(source) = parse_source(input) {
            controls[i] = source;
        }
    }
    Some(Mapping { name, controls })
}

/// `b3`, `a2`, `+a2`, `-a2`, `a2~`, `h0.4`.
fn parse_source(input: &str) -> Option<Source> {
    let (sign, rest) = match input.as_bytes().first()? {
        b'+' => (1, &input[1..]),
        b'-' => (-1, &input[1..]),
        _ => (0, input),
    };
    let (inverted, rest) = match rest.strip_suffix('~') {
        Some(r) => (true, r),
        None => (false, rest),
    };
    let kind = rest.as_bytes().first()?;
    let body = &rest[1..];
    match kind {
        b'b' => Some(Source::Button(body.parse().ok()?)),
        b'h' => {
            let (hat, mask) = body.split_once('.')?;
            let mask: u8 = mask.parse().ok()?;
            if !matches!(mask, 1 | 2 | 4 | 8) {
                return None;
            }
            Some(Source::Hat(hat.parse().ok()?, mask))
        }
        b'a' => {
            let i: u8 = body.parse().ok()?;
            Some(match (sign, inverted) {
                (1, false) | (-1, true) => Source::AxisPositive(i),
                (-1, false) | (1, true) => Source::AxisNegative(i),
                (_, true) => Source::AxisInverted(i),
                _ => Source::Axis(i),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_from_first_party_vendors() {
        assert_eq!(family_of(0x045e, 0x028e, "Controller"), Family::Xbox);
        assert_eq!(family_of(0x054c, 0x0ce6, ""), Family::PlayStation);
        assert_eq!(family_of(0x057e, 0x2009, "Wireless Gamepad"), Family::Switch);
    }

    #[test]
    fn families_from_third_party_names() {
        assert_eq!(family_of(0x0e6f, 0x02a0, "PDP Xbox One Controller"), Family::Xbox);
        assert_eq!(family_of(0, 0, "XInput Controller"), Family::Xbox);
        assert_eq!(family_of(0x0f0d, 0x00ee, "HORI Wired DualShock 4"), Family::PlayStation);
        assert_eq!(family_of(0x2dc8, 0x6001, "8BitDo Pro Controller"), Family::Switch);
        assert_eq!(family_of(0x20d6, 0xa711, "PowerA Joy-Con style"), Family::Switch);
        assert_eq!(family_of(0x2dc8, 0x3106, "8BitDo SN30 Pro"), Family::Generic);
        assert_eq!(Family::Switch as u8, 3);
    }

    #[test]
    fn web_ids() {
        assert_eq!(parse_web_gamepad_id("Xbox 360 Controller (XInput STANDARD GAMEPAD Vendor: 045e Product: 028e)"), Some((0x045e, 0x028e)));
        assert_eq!(parse_web_gamepad_id("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"), Some((0x054c, 0x0ce6)));
        assert_eq!(parse_web_gamepad_id("USB Joystick (Vendor: 0079 Product: 0006)"), Some((0x0079, 0x0006)));
        assert_eq!(parse_web_gamepad_id("045e-028e-Xbox 360 Controller"), Some((0x045e, 0x028e)));
        assert_eq!(parse_web_gamepad_id("45e-2e0-Xbox Wireless Controller"), Some((0x045e, 0x02e0)));
        assert_eq!(parse_web_gamepad_id("054c-09cc-Wireless Controller"), Some((0x054c, 0x09cc)));
        assert_eq!(parse_web_gamepad_id("xinput"), None);
        assert_eq!(parse_web_gamepad_id("Some-Pad-Name"), None);
        assert_eq!(parse_web_gamepad_id("045e-028e"), None);
        assert_eq!(parse_web_gamepad_id(""), None);
    }

    #[test]
    fn sources() {
        assert_eq!(parse_source("b3"), Some(Source::Button(3)));
        assert_eq!(parse_source("a2"), Some(Source::Axis(2)));
        assert_eq!(parse_source("+a2"), Some(Source::AxisPositive(2)));
        assert_eq!(parse_source("-a5"), Some(Source::AxisNegative(5)));
        assert_eq!(parse_source("a1~"), Some(Source::AxisInverted(1)));
        assert_eq!(parse_source("h0.4"), Some(Source::Hat(0, 4)));
        assert_eq!(parse_source("h1.8"), Some(Source::Hat(1, 8)));
        assert_eq!(parse_source("h0.3"), None);
        assert_eq!(parse_source("q"), None);
        assert_eq!(Source::Hat(1, 8).wire(), [6, 24]);
        assert_eq!(Source::AxisNegative(4).wire(), [4, 4]);
    }

    #[test]
    fn parses_a_line() {
        let m = parse_mapping("03000000300f00000a01000000000000,3 In 1 Conversion Box,a:b2,b:b1,back:b9,dpdown:h0.4,dpleft:h0.8,dpright:h0.2,dpup:h0.1,leftshoulder:b6,leftstick:b10,lefttrigger:b4,leftx:a0,lefty:a1,rightshoulder:b7,rightstick:b11,righttrigger:b5,rightx:a3,righty:a2,start:b8,x:b3,y:b0,platform:Windows,").unwrap();
        assert_eq!(m.name, "3 In 1 Conversion Box");
        assert_eq!(m.control("buttonSouth"), Some(Source::Button(2)));
        assert_eq!(m.control("buttonNorth"), Some(Source::Button(0)));
        assert_eq!(m.control("select"), Some(Source::Button(9)));
        assert_eq!(m.control("dpadLeft"), Some(Source::Hat(0, 8)));
        assert_eq!(m.control("rightStickY"), Some(Source::Axis(2)));
        assert_eq!(m.control("home"), Some(Source::None));
        assert_eq!(m.control("nope"), None);
    }

    #[test]
    fn half_axis_targets_read_as_none() {
        let m = parse_mapping("x,N64,a:b0,+rightx:b9,-rightx:b8,lefttrigger:+a2,platform:Linux,").unwrap();
        assert_eq!(m.control("rightStickX"), Some(Source::None));
        assert_eq!(m.control("leftTrigger"), Some(Source::AxisPositive(2)));
    }

    #[test]
    fn indexes_standard_guids_only() {
        let e = index_line("03000000300f00000a01000000000000,Box,a:b2,platform:Windows,").unwrap();
        assert_eq!((e.vendor, e.product, e.driver, e.platform), (0x0f30, 0x010a, 0, "Windows"));
        assert!(index_line("# Windows").is_none());
        assert!(index_line("78696e70757401000000000000000000,XInput,a:b0,platform:Windows,").is_none());
    }

    #[test]
    fn the_database_loads() {
        assert!(db().len() > 1500, "{} entries", db().len());
    }

    #[test]
    fn maps_known_pads_per_platform() {
        // The DualShock 4 (v1) on Linux: evdev order puts the triggers on axes 2 and 5.
        let m = web_mapping(0x054c, 0x05c4, Platform::Linux).expect("DualShock 4 on Linux");
        assert_ne!(m.control("buttonSouth"), Some(Source::None));
        assert!(matches!(m.control("leftStickX"), Some(Source::Axis(0))));
        assert!(matches!(m.control("leftStickY"), Some(Source::Axis(1))));
        // The same pad on Windows and macOS is also known, numbered as each platform numbers it.
        assert!(web_mapping(0x054c, 0x05c4, Platform::Windows).is_some());
        assert!(web_mapping(0x054c, 0x05c4, Platform::MacOs).is_some());
        // Other falls back to Linux's entries.
        assert_eq!(web_mapping(0x054c, 0x05c4, Platform::Other), Some(m));
        assert_eq!(web_mapping(0xfffe, 0xfffe, Platform::Windows), None);
        assert_eq!(Platform::from_u8(9), Platform::Other);
    }

    #[test]
    fn every_indexed_entry_parses() {
        for entry in db() {
            assert!(parse_mapping(entry.line).is_some(), "{}", entry.line);
        }
    }

    #[test]
    fn names_line_up() {
        assert_eq!(SDL_NAMES.len(), CONTROL_COUNT);
        assert_eq!(BUTTONS[6], "leftTrigger");
        assert_eq!(BUTTONS[16], "home");
        assert_eq!(AXES[3], "rightStickY");
    }
}
