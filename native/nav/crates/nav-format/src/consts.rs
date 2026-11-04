//! Area and gate ids as they appear on polygons (Foxfire's `NavAreas`, `NavGates`).

/// Area ids (`NavPoly::area`). Recast keeps the higher id where surfaces overlap.
pub struct NavAreas;
impl NavAreas {
    pub const NULL: i32 = 0; // not walkable
    pub const WALKABLE: i32 = 1; // default ground
    pub const FIRST_CUSTOM: i32 = 2; // NavigationSetup.Areas[i] has id FIRST_CUSTOM + i
    pub const MAX: i32 = 63; // Recast's area ids are 6 bits
    pub const MAX_CUSTOM: i32 = Self::MAX - Self::FIRST_CUSTOM + 1; // 62
}

/// Gate indices as baked into polygons (`NavPoly::gate`): 0 = none, 1..=MAX = a gate. During the bake a gate's
/// index rides in the high bits of the span's area code (`area | gate << SHIFT`).
pub struct NavGates;
impl NavGates {
    pub const NONE: i32 = 0;
    pub const SHIFT: i32 = 6; // above the 6-bit area id
    pub const AREA_MASK: i32 = (1 << Self::SHIFT) - 1;
    pub const MAX: i32 = 511; // area | gate << 6 must stay below 2^15

    /// `area | gate << SHIFT`.
    pub const fn encode(area: i32, gate: i32) -> i32 {
        (area & Self::AREA_MASK) | (gate << Self::SHIFT)
    }
    pub const fn area_of(code: i32) -> i32 {
        code & Self::AREA_MASK
    }
    pub const fn gate_of(code: i32) -> i32 {
        code >> Self::SHIFT
    }
    /// True if `gate` is closed in `closed` (indexed by gate). No gate, or an index past the end, counts as open.
    pub fn is_closed(gate: i32, closed: &[bool]) -> bool {
        gate != Self::NONE && gate > 0 && (gate as usize) < closed.len() && closed[gate as usize]
    }
}
