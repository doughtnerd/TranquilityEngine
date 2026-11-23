//! `anim-compress` (ADR 0350, 0351): the compressor. Uniform sampling, range reduction, a bit rate
//! per track chosen against an object-space error bound, as ACL does.
//!
//! Used by the editor's worker and by exports, never at runtime (it isn't linked into anim-wasm's
//! runtime module). It may allocate; it is deterministic (no hash maps, no libm, no threads: the
//! same input gives the same bytes on every target).
//!
//! Internal to the animation core: nothing here is engine public API (ADR 0010).
//!
//! # Pipeline ([`compress`])
//!
//! 1. **Uniform sampling.** The raw form is already uniform at the clip's rate; with
//!    [`Settings::sample_rate`] set to another rate it is resampled (linear, nlerp for rotations).
//! 2. **Channels.** Each bone track splits into rotation, translation and scale channels; any other
//!    sampled track is one value channel. Rotations are normalised; drop-w rotations are put on the
//!    `w ≥ 0` hemisphere, full rotations (and `quat` tracks) get sign continuity frame to frame.
//! 3. **Default and constant channels.** A bone channel equal to the rest pose within a tenth of
//!    the bound (measured at the shell distance) is *default*; one within a tenth of the bound of
//!    its mid-range value is *constant*. Property channels use their absolute bound (default only
//!    when [`Settings::property_defaults`] gives the field's default). If the final object-space
//!    error still exceeds the bound because of one of these, the worst one is made animated and the
//!    search runs again.
//! 4. **Range reduction** per animated channel over the clip (f32 minimum and extent), then per
//!    segment of [`Settings::segment_frames`] frames (8-bit minimum and extent within the clip range).
//! 5. **Bit rates**, per segment and animated channel, from {0, 3–16, 19, 23, 32}: each channel
//!    starts at the lowest rate that meets the bound on its own (in its parent's space); then, bone
//!    by bone (parents first), while a bone's object-space error exceeds the bound, the channel on
//!    its chain (itself and its ancestors) whose next rate lowers that error most is raised. The
//!    error is ACL's: the largest distance between the raw and lossy model-space images of the
//!    virtual vertices `(d,0,0)`, `(0,d,0)`, `(0,0,d)`, with `d` the bone's shell distance
//!    (`max(3 cm, bone length)`, the length being the longest child offset in the rest pose, or
//!    [`Settings::shell_distance`]). Property channels take the lowest rate whose largest absolute
//!    component error meets their bound.
//! 6. **Packing** (below), written with `anim-format`'s writer, which re-parses its output.
//!
//! The [`Report`] gives the sizes and the measured maximum errors.
//!
//! # The bitstream (`COMP_DATA`)
//!
//! `anim-format` leaves the segment bitstreams opaque; this is their contract, which `anim-sample`
//! and `anim-offline::sample` decode:
//!
//! - A segment's bitstream is **frame-major**: for each frame of the segment, for each animated
//!   channel in animated order, for each component, the code in that segment's bit rate for the
//!   channel. Bits are packed **least significant first** (bit `p` of the stream is bit `p % 8` of
//!   byte `p / 8`). A frame takes `Σ bits · width` bits.
//! - **Segment ranges** decode in value space as
//!   `seg_min = clip_min + (q_min / 255) · clip_extent` and
//!   `seg_extent = (q_extent / 255) · clip_extent` (`anim-math::quant::unpack_range` with 8 bits).
//! - **Samples:** rate 0 stores nothing and decodes to `seg_min`; rates 3..=23 store a unorm code
//!   decoding to `seg_min + code / (2^bits − 1) · seg_extent`; rate 32 stores the f32 bits as is.
//! - **Drop-w rotations** rebuild `w = sqrt(max(0, 1 − ((x·x + y·y) + z·z)))`.
//! - **Time** `t` maps to frames as `x = clamp(t · rate, 0, frames − 1)`, `f0 = floor(x)`,
//!   `f1 = min(f0 + 1, frames − 1)`, `alpha = x − f0`.
//! - Each segment's data size is the packed size in bytes plus 7 bytes of slack (when it holds any
//!   bits), so a decoder may read 8 bytes at the byte holding a code's first bit.

mod bits;
mod channels;
mod root;
mod search;
mod settings;

pub use settings::{
    CompressError, Output, Report, RootMotion, Settings, TrackError, DEFAULT_ERROR,
    DEFAULT_PROPERTY_ERROR, DEFAULT_SHELL_DISTANCE, ROOT_ALL, ROOT_X, ROOT_Y, ROOT_YAW, ROOT_Z,
};

pub use search::compress;

/// The bit rates the search may choose, lowest first (`anim-format`'s valid rates).
pub const BIT_RATES: [u8; 18] = [
    0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 23, 32,
];
