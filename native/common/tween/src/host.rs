//! The codes the tween table shares with its host's boundary: status codes, the two evaluation
//! passes and the handle layout. They are the values of `anim-wire`'s `core` family (the animation
//! core's boundary, which also generates their TypeScript); `anim-wire` asserts the two equal at
//! compile time, so the standalone tween module answers exactly as the animation core does.

/// Status: done.
pub const STATUS_OK: u32 = 0;
/// Status: the record was short, or of another opcode or version.
pub const STATUS_BAD_RECORD: u32 = 1;
/// Status: too large.
pub const STATUS_TOO_LARGE: u32 = 2;
/// Status: the curve keys aren't valid.
pub const STATUS_BAD_ASSET: u32 = 4;
/// Status: the table is full.
pub const STATUS_FULL: u32 = 5;
/// Status: the handle was released, destroyed, or never existed.
pub const STATUS_STALE_HANDLE: u32 = 6;

/// The normal pass (`TIME_SCALED` and `TIME_UNSCALED` tweens).
pub const PASS_NORMAL: u32 = 0;
/// The fixed pass (`TIME_FIXED` tweens).
pub const PASS_FIXED: u32 = 1;

/// Handles: the index bits.
pub const HANDLE_INDEX_MASK: u32 = 0xFFFF;
/// Handles: the generation is above this shift (so a handle is at least `1 << 16`, above every
/// easing id: an `ease` field tells an easing id from a curve handle by value).
pub const HANDLE_GENERATION_SHIFT: u32 = 16;

/// The handle of slot `index` at `generation` (never 0: generations start at 1).
#[inline]
pub fn handle(index: usize, generation: u16) -> u32 {
    ((generation as u32) << HANDLE_GENERATION_SHIFT) | index as u32
}

/// A handle's index and generation.
#[inline]
pub fn split(handle: u32) -> (usize, u16) {
    (
        (handle & HANDLE_INDEX_MASK) as usize,
        (handle >> HANDLE_GENERATION_SHIFT) as u16,
    )
}
