//! Settings, the report and errors.

use anim_format::clip::{Clip, RotationFormat};
use anim_format::FormatError;

/// The default object-space error bound for bone tracks: 0.1 mm (ADR 0371's `compression.error`).
pub const DEFAULT_ERROR: f32 = 1e-4;
/// The default absolute error for property tracks without a field `quantize` (ADR 0371).
pub const DEFAULT_PROPERTY_ERROR: f32 = 1e-4;
/// The smallest shell distance: 3 cm (ACL's default).
pub const DEFAULT_SHELL_DISTANCE: f32 = 0.03;

/// Root curve axis flag: translation x.
pub const ROOT_X: u8 = 1;
/// Root curve axis flag: translation y.
pub const ROOT_Y: u8 = 2;
/// Root curve axis flag: translation z.
pub const ROOT_Z: u8 = 4;
/// Root curve axis flag: yaw about +Y.
pub const ROOT_YAW: u8 = 8;
/// Every root curve axis.
pub const ROOT_ALL: u8 = ROOT_X | ROOT_Y | ROOT_Z | ROOT_YAW;

/// Root-curve extraction (ADR 0370's prediction curve, `rootMotion: { bone, axes }` in 0371).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RootMotion {
    /// The root-motion bone.
    pub bone: u32,
    /// Which axes the curve keeps ([`ROOT_X`] … [`ROOT_YAW`]); the others are written as 0.
    pub axes: u8,
}

/// Compression settings (the sidecar's `compression` block plus the clip's options).
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    /// Object-space error bound for bone tracks, metres (> 0).
    pub error: f32,
    /// Absolute error bound for property tracks without an override (> 0).
    pub property_error: f32,
    /// Per-track absolute error overrides `(track index, error)`, from the field's `quantize`.
    pub track_errors: Vec<(u32, f32)>,
    /// Field defaults `(track index, value)` for property tracks; a track within its bound of its
    /// default becomes a default channel (the runtime leaves the field at its default).
    pub property_defaults: Vec<(u32, Vec<f32>)>,
    /// One shell distance for every bone, metres, instead of `max(3 cm, bone length)`.
    pub shell_distance: Option<f32>,
    /// The highest bit rate the search may use (a valid rate; 32 = raw).
    pub max_bit_rate: u8,
    /// Resample to this rate first (Hz); `None` keeps the clip's rate.
    pub sample_rate: Option<f32>,
    /// Frames per segment (≥ 1).
    pub segment_frames: u32,
    /// Force a rotation format; `None` chooses (drop-w, or the smaller of both when a rotation
    /// comes near 180°, where drop-w loses precision).
    pub rotation_format: Option<RotationFormat>,
    /// Keep the raw form in the output (for preview).
    pub keep_raw: bool,
    /// Extract the root curve.
    pub root_motion: Option<RootMotion>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            error: DEFAULT_ERROR,
            property_error: DEFAULT_PROPERTY_ERROR,
            track_errors: Vec::new(),
            property_defaults: Vec::new(),
            shell_distance: None,
            max_bit_rate: 32,
            sample_rate: None,
            segment_frames: anim_format::clip::SEGMENT_FRAMES,
            rotation_format: None,
            keep_raw: false,
            root_motion: None,
        }
    }
}

/// One property track's measured error.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackError {
    /// The track index.
    pub track: u32,
    /// The largest absolute component error.
    pub error: f32,
    /// Its bound.
    pub bound: f32,
    /// The frame where it occurs.
    pub frame: u32,
}

/// What the compressor measured.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    /// Bytes of the raw form (`RAW` section) at the compressed rate.
    pub raw_size: usize,
    /// Bytes of the eight compressed sections.
    pub compressed_size: usize,
    /// Bytes of the output file.
    pub file_size: usize,
    /// Largest object-space bone error, metres (0 without bone tracks).
    pub max_error: f32,
    /// The bone and frame of `max_error`.
    pub worst_bone: Option<(u32, u32)>,
    /// Per property track (sampled non-bone tracks), in track order.
    pub tracks: Vec<TrackError>,
    /// The rotation format used.
    pub rotation_format: RotationFormat,
    /// Channels by mode: default, constant, animated.
    pub channels: [u32; 3],
    /// Whether every error met its bound.
    pub within_bounds: bool,
}

impl Report {
    /// `raw_size / compressed_size`.
    pub fn ratio(&self) -> f64 {
        self.raw_size as f64 / self.compressed_size.max(1) as f64
    }
    /// The worst property track, if any.
    pub fn worst_track(&self) -> Option<TrackError> {
        self.tracks
            .iter()
            .copied()
            .max_by(|a, b| a.error.total_cmp(&b.error))
    }
}

/// The compressor's result.
#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    /// The clip with its compressed form (and raw form when kept).
    pub clip: Clip,
    /// `clip` written as `myco.anim@1`.
    pub bytes: Vec<u8>,
    /// Sizes and errors.
    pub report: Report,
}

/// Why a clip can't be compressed.
#[derive(Clone, Debug, PartialEq)]
pub enum CompressError {
    /// The clip has no raw form to compress.
    NoRawForm,
    /// The clip has bone tracks but no skeleton was given, or the bone counts differ.
    SkeletonMismatch,
    /// A setting is out of range.
    BadSetting(&'static str),
    /// The output didn't write (a bug, or an input the format refuses).
    Format(FormatError),
}

impl From<FormatError> for CompressError {
    fn from(e: FormatError) -> Self {
        CompressError::Format(e)
    }
}

impl core::fmt::Display for CompressError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            CompressError::NoRawForm => write!(f, "the clip has no raw form"),
            CompressError::SkeletonMismatch => write!(f, "the skeleton doesn't match the clip"),
            CompressError::BadSetting(s) => write!(f, "bad setting: {s}"),
            CompressError::Format(e) => write!(f, "format: {e}"),
        }
    }
}

impl std::error::Error for CompressError {}
