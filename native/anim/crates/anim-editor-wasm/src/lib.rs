//! `anim-editor-wasm` (ADR 0370, 0371; T19, decision D79): the editor's compile module. A separate
//! cdylib from the runtime core (`anim-wasm`), so games never download the compressor, the f64
//! reference it measures with, or the bakes. The editor's compile worker and the exporters (Node)
//! load it; its instance holds no assets and no state but the last call's report and error.
//!
//! Everything here is offline: it allocates freely and is deterministic (the same input gives the
//! same bytes on every target: no hash-map iteration order reaches the output, no libm, no threads).
//!
//! | Call | Does |
//! |---|---|
//! | `compiler_version()` | [`COMPILER_VERSION`]: part of every compiled clip's content key |
//! | `source_hash()` | the hash of `native/anim/` the module was built from (as the runtime module's) |
//! | `compress_clip(clip, skeleton, settings)` | a raw `myco.anim@1` clip → the compressed clip (empty on failure); the report in `last_report()` |
//! | `skeleton_compile(skeleton, roles, profile)` | a `myco.skel@1` file re-written canonically, with a role per bone and a profile name when given |
//! | `retarget_bake_compressed(…)` | a clip retargeted through a map built from two skeleton files, compressed for the target |
//! | `posedb_bake(…)` | a `myco.posedb@1` pose database from a skeleton and clips (`anim-match`'s bake) |
//! | `meter_node_module(bytes)` | a third-party node module validated and metered by `anim-meter` (T45t; empty on refusal) |
//! | `meter_version()` | `anim-meter`'s [`anim_meter::METER_VERSION`]: part of a metered module's cache key |
//! | `last_report()` | the last compression's [`REPORT_LEN`] numbers (layout: [`report`]) |
//! | `last_error()` | why the last call returned nothing ("" after a success) |
//!
//! Internal to the animation core: nothing here is engine public API (ADR 0010).

use std::cell::RefCell;

use anim_compress::{CompressError, Report, RootMotion, Settings};
use anim_format::clip::{ClipView, RotationFormat};
use anim_format::skeleton::SkeletonView;
use anim_format::NONE;
use anim_match::{BakeClip, BakeSettings, CustomFeature, FeatureSpec, Normalization, TaggedRange};
use anim_retarget::bake::{bake, compress_baked, SkeletonData};
use anim_retarget::{BoneMap, MapSettings, Profile, RetargetMap, RetargetOptions, RootAxis, Side};
use anim_sample::Form;
use wasm_bindgen::prelude::wasm_bindgen;

/// The compiler's version: bump it whenever the same inputs would compile to other bytes (a
/// compressor change, a new default), so every cached and built clip is compiled again. The
/// editor's content keys (`src/engine/animation/compile/keys.ts`) hash it.
pub const COMPILER_VERSION: u32 = 1;

static SOURCE_HASH: [u8; 16] = *include_bytes!(concat!(env!("OUT_DIR"), "/source_hash.bin"));

/// Settings record length (f32 values).
pub const SETTINGS_LEN: usize = 8;

/// The compression settings record, one f32 each:
///
/// | index | value |
/// |---|---|
/// | 0 | object-space error bound for bone tracks, metres (> 0) |
/// | 1 | absolute error bound for property tracks (> 0) |
/// | 2 | resample rate, Hz (0: keep the clip's) |
/// | 3 | highest bit rate (a valid rate; 32 = raw) |
/// | 4 | frames per segment (0: the default, 16) |
/// | 5 | root-motion bone (< 0: no root curve) |
/// | 6 | root curve axes (`ROOT_X` 1, `ROOT_Y` 2, `ROOT_Z` 4, `ROOT_YAW` 8) |
/// | 7 | keep the raw form too (1) or not (0) |
///
/// A shorter record takes the defaults for the missing values.
pub mod settings {
    pub const ERROR: usize = 0;
    pub const PROPERTY_ERROR: usize = 1;
    pub const SAMPLE_RATE: usize = 2;
    pub const MAX_BIT_RATE: usize = 3;
    pub const SEGMENT_FRAMES: usize = 4;
    pub const ROOT_BONE: usize = 5;
    pub const ROOT_AXES: usize = 6;
    pub const KEEP_RAW: usize = 7;
}

/// Report record length (f64 values).
pub const REPORT_LEN: usize = 13;

/// The report record, one f64 each (sizes in bytes, errors in metres or track units):
///
/// | index | value |
/// |---|---|
/// | 0 | raw form size at the compressed rate |
/// | 1 | compressed sections' size |
/// | 2 | output file size |
/// | 3 | largest object-space bone error |
/// | 4 | bone of that error (−1: none) |
/// | 5 | frame of that error (−1: none) |
/// | 6 | largest property-track error |
/// | 7 | track of that error (−1: none) |
/// | 8, 9, 10 | channels: default, constant, animated |
/// | 11 | every error met its bound (1) or not (0) |
/// | 12 | rotation format (0 drop-w, 1 full) |
pub mod report {
    pub const RAW_SIZE: usize = 0;
    pub const COMPRESSED_SIZE: usize = 1;
    pub const FILE_SIZE: usize = 2;
    pub const MAX_ERROR: usize = 3;
    pub const WORST_BONE: usize = 4;
    pub const WORST_FRAME: usize = 5;
    pub const MAX_PROPERTY_ERROR: usize = 6;
    pub const WORST_TRACK: usize = 7;
    pub const CHANNELS: usize = 8;
    pub const WITHIN_BOUNDS: usize = 11;
    pub const ROTATION_FORMAT: usize = 12;
}

/// A third-party node module (ADR 0370, "Third-party graph and rig nodes") checked against the node
/// ABI and the allowed proposals and rewritten with its fuel counter by `anim-meter`, at the default
/// load limits. The editor's loader meters project modules with it (caching by content), and exports
/// write the result into the build, so games load metered bytes and never this module.
pub fn meter_module(bytes: &[u8]) -> Result<Vec<u8>, CompileError> {
    anim_meter::meter(bytes, &anim_meter::Limits::default())
        .map_err(|e| err(format_args!("node module: {e}")))
}

/// Why a compile failed (the text `last_error()` returns).
#[derive(Clone, Debug, PartialEq)]
pub struct CompileError(pub String);

impl core::fmt::Display for CompileError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CompileError {}

fn err(what: impl core::fmt::Display) -> CompileError {
    CompileError(what.to_string())
}

/// The compressor settings a settings record describes.
pub fn settings_from(record: &[f32]) -> Result<Settings, CompileError> {
    let at = |i: usize| record.get(i).copied();
    let mut s = Settings::default();
    if let Some(v) = at(settings::ERROR) {
        s.error = v;
    }
    if let Some(v) = at(settings::PROPERTY_ERROR) {
        s.property_error = v;
    }
    if let Some(v) = at(settings::SAMPLE_RATE) {
        s.sample_rate = (v > 0.0).then_some(v);
    }
    if let Some(v) = at(settings::MAX_BIT_RATE) {
        if !(v.is_finite() && (0.0..=32.0).contains(&v)) {
            return Err(err("bad setting: max bit rate"));
        }
        s.max_bit_rate = v as u8;
    }
    if let Some(v) = at(settings::SEGMENT_FRAMES) {
        if v.is_finite() && v >= 1.0 {
            s.segment_frames = v as u32;
        }
    }
    if let Some(bone) = at(settings::ROOT_BONE) {
        if bone.is_finite() && bone >= 0.0 {
            let axes = at(settings::ROOT_AXES).unwrap_or(15.0);
            s.root_motion = Some(RootMotion {
                bone: bone as u32,
                axes: (axes as u32 & 15) as u8,
            });
        }
    }
    if let Some(v) = at(settings::KEEP_RAW) {
        s.keep_raw = v != 0.0;
    }
    Ok(s)
}

/// The report as its record.
pub fn report_record(r: &Report) -> Vec<f64> {
    let mut out = vec![0.0; REPORT_LEN];
    out[report::RAW_SIZE] = r.raw_size as f64;
    out[report::COMPRESSED_SIZE] = r.compressed_size as f64;
    out[report::FILE_SIZE] = r.file_size as f64;
    out[report::MAX_ERROR] = r.max_error as f64;
    let (bone, frame) = r
        .worst_bone
        .map_or((-1.0, -1.0), |(b, f)| (b as f64, f as f64));
    out[report::WORST_BONE] = bone;
    out[report::WORST_FRAME] = frame;
    let (perr, track) = r
        .worst_track()
        .map_or((0.0, -1.0), |t| (t.error as f64, t.track as f64));
    out[report::MAX_PROPERTY_ERROR] = perr;
    out[report::WORST_TRACK] = track;
    for (i, &n) in r.channels.iter().enumerate() {
        out[report::CHANNELS + i] = n as f64;
    }
    out[report::WITHIN_BOUNDS] = r.within_bounds as u8 as f64;
    out[report::ROTATION_FORMAT] = match r.rotation_format {
        RotationFormat::QuatDropW => 0.0,
        RotationFormat::QuatFull => 1.0,
    };
    out
}

fn compress_error(e: CompressError) -> CompileError {
    err(e)
}

/// Compresses a raw `myco.anim@1` clip (`skeleton`: its skeleton's `myco.skel@1` file, empty for a
/// clip without bone tracks) with a settings record. Returns the compressed file and the report.
pub fn compile_clip(
    clip: &[u8],
    skeleton: &[u8],
    record: &[f32],
) -> Result<(Vec<u8>, Report), CompileError> {
    let view = ClipView::parse(clip).map_err(|e| err(format_args!("clip: {e}")))?;
    let skel = if skeleton.is_empty() {
        None
    } else {
        Some(
            SkeletonView::parse(skeleton)
                .map_err(|e| err(format_args!("skeleton: {e}")))?
                .to_skeleton(),
        )
    };
    let s = settings_from(record)?;
    let out =
        anim_compress::compress(&view.to_clip(), skel.as_ref(), &s).map_err(compress_error)?;
    Ok((out.bytes, out.report))
}

/// A skeleton file re-written canonically (parsed and validated first), with `roles` (one profile
/// role per bone, `0xFFFF` none; empty: keep the file's) and `profile` (a profile reference; "":
/// keep the file's).
pub fn compile_skeleton(
    skeleton: &[u8],
    roles: &[u16],
    profile: &str,
) -> Result<Vec<u8>, CompileError> {
    let view = SkeletonView::parse(skeleton).map_err(|e| err(format_args!("skeleton: {e}")))?;
    let mut s = view.to_skeleton();
    if !roles.is_empty() {
        if roles.len() != s.bones.len() {
            return Err(err("roles: one per bone is needed"));
        }
        s.roles = Some(roles.to_vec());
    }
    if !profile.is_empty() {
        let id = match s.strings.iter().position(|x| x == profile) {
            Some(i) => i as u32,
            None => {
                s.strings.push(profile.to_owned());
                (s.strings.len() - 1) as u32
            }
        };
        s.profile = id;
    }
    s.write().map_err(|e| err(format_args!("skeleton: {e}")))
}

fn root_axis(bits: u32) -> RootAxis {
    match bits & 3 {
        1 => RootAxis::Unscaled,
        2 => RootAxis::Locked,
        _ => RootAxis::Scaled,
    }
}

/// One side of a retarget: a skeleton file, a profile (`anim-retarget`'s encoded layout; empty:
/// the built-in Humanoid) and its bone map (one `u16` per role, `0xFFFF` unmapped).
#[derive(Clone, Copy)]
pub struct RetargetInput<'a> {
    pub skeleton: &'a [u8],
    pub profile: &'a [u8],
    pub map: &'a [u16],
}

/// Retargets `clip` (made for the source skeleton) to the target skeleton through a map built from
/// both sides (`flags` 1: align chains, D47), then compresses it for the target with a settings
/// record. `root_axes` packs the three axes two bits each, x first: 0 scaled, 1 unscaled, 2 locked.
pub fn compile_retarget(
    source: RetargetInput<'_>,
    target: RetargetInput<'_>,
    flags: u32,
    clip: &[u8],
    root_axes: u32,
    ik_weights: &[f32],
    record: &[f32],
) -> Result<(Vec<u8>, Report), CompileError> {
    let profile = |b: &[u8]| -> Result<Profile, CompileError> {
        if b.is_empty() {
            Ok(Profile::humanoid())
        } else {
            anim_retarget::encode::decode(b).map_err(|e| err(format_args!("profile: {e:?}")))
        }
    };
    let (sp, tp) = (profile(source.profile)?, profile(target.profile)?);
    let sv = SkeletonView::parse(source.skeleton)
        .map_err(|e| err(format_args!("source skeleton: {e}")))?;
    let tv = SkeletonView::parse(target.skeleton)
        .map_err(|e| err(format_args!("target skeleton: {e}")))?;
    let (sd, td) = (SkeletonData::from_view(&sv), SkeletonData::from_view(&tv));
    let bone_map = |m: &[u16], p: &Profile| -> Result<BoneMap, CompileError> {
        if m.len() != p.roles.len() {
            return Err(err("bone map: one entry per profile role is needed"));
        }
        let mut b = BoneMap::new(m.len());
        for (r, &bone) in m.iter().enumerate() {
            b.set(r as u16, bone);
        }
        Ok(b)
    };
    let (sm, tm) = (bone_map(source.map, &sp)?, bone_map(target.map, &tp)?);
    let map = RetargetMap::new(
        Side {
            skeleton: sd.skeleton(),
            profile: &sp,
            map: &sm,
        },
        Side {
            skeleton: td.skeleton(),
            profile: &tp,
            map: &tm,
        },
        &MapSettings {
            align_chains: flags & 1 != 0,
        },
    )
    .map_err(|e| err(format_args!("retarget map: {e:?}")))?;
    let view = ClipView::parse(clip).map_err(|e| err(format_args!("clip: {e}")))?;
    let opts = RetargetOptions {
        root_axes: [
            root_axis(root_axes),
            root_axis(root_axes >> 2),
            root_axis(root_axes >> 4),
        ],
        ik_weights,
    };
    let baked = bake(&map, &view, &sd.rest, &opts).map_err(err)?;
    let s = settings_from(record)?;
    let out = compress_baked(&baked, &tv.to_skeleton(), &s).map_err(compress_error)?;
    Ok((out.bytes, out.report))
}

/// Custom feature record stride (f32 values): dims (1–4), weight.
pub const CUSTOM_LEN: usize = 2;

/// T70: a pose database bake's mirrored copies and custom features.
#[derive(Clone, Copy, Debug, Default)]
pub struct PosedbExtras<'a> {
    /// Per clip, flags (bit 0: also bake a mirrored copy); empty: none.
    pub clip_flags: &'a [u32],
    /// The mirror table: the axis (0 X, 1 Y, 2 Z), then a `MIRROR`-node word per skeleton bone
    /// (`retarget_mirror_table` with the skeleton's profile); needed when a clip is mirrored.
    pub mirror: &'a [u32],
    /// [`CUSTOM_LEN`] f32 per custom feature; each reads the clips' curve track named by the
    /// matching line of `custom_names`.
    pub custom: &'a [f32],
    pub custom_names: &'a str,
}

/// Ranges record stride (f32 values): clip index, start, end, tag count.
pub const RANGE_LEN: usize = 4;
/// Schema record stride (f32 values): kind (`FeatureKind` id), bone, weight, time offset.
pub const FEATURE_LEN: usize = 4;

/// Bakes a pose database (`anim-match`'s bake). `clips` holds the clip files back to back
/// (`clip_lengths` bytes each), `assets` their asset references one per line; `ranges` is
/// [`RANGE_LEN`] f32 per tagged range, whose tags are the next `tag count` lines of `tags`;
/// `schema` is [`FEATURE_LEN`] f32 per feature; `bake` is sample rate, std floor,
/// normalization (0 per dimension, 1 per feature), KD-tree (0/1), leaf size and root bone (< 0:
/// none), missing values taking the bake's defaults. `skeleton_name`: "" for none. `extras`:
/// T70's mirrored copies and custom features.
#[allow(clippy::too_many_arguments)]
pub fn compile_posedb(
    skeleton: &[u8],
    skeleton_name: &str,
    clips: &[u8],
    clip_lengths: &[u32],
    assets: &str,
    ranges: &[f32],
    tags: &str,
    schema: &[f32],
    bake_settings: &[f32],
    extras: &PosedbExtras<'_>,
) -> Result<Vec<u8>, CompileError> {
    use anim_format::posedb::FeatureKind;
    let skel = SkeletonView::parse(skeleton).map_err(|e| err(format_args!("skeleton: {e}")))?;
    let names: Vec<&str> = if assets.is_empty() {
        Vec::new()
    } else {
        assets.split('\n').collect()
    };
    if names.len() != clip_lengths.len() {
        return Err(err("assets: one line per clip is needed"));
    }
    let mut views = Vec::with_capacity(clip_lengths.len());
    let mut at = 0usize;
    for (i, &n) in clip_lengths.iter().enumerate() {
        let end = at
            .checked_add(n as usize)
            .filter(|&e| e <= clips.len())
            .ok_or_else(|| err("clips: lengths run past the bytes"))?;
        views.push(
            ClipView::parse(&clips[at..end]).map_err(|e| err(format_args!("clip {i}: {e}")))?,
        );
        at = end;
    }
    let tag_lines: Vec<&str> = if tags.is_empty() {
        Vec::new()
    } else {
        tags.split('\n').collect()
    };
    if !ranges.len().is_multiple_of(RANGE_LEN) {
        return Err(err("ranges: 4 values per range"));
    }
    // Per range: clip, start, end and its slice of tag lines.
    let mut parsed: Vec<(usize, f32, f32, Vec<&str>)> = Vec::new();
    let mut next_tag = 0usize;
    for r in ranges.as_chunks::<RANGE_LEN>().0 {
        let clip = r[0] as usize;
        let count = r[3] as usize;
        if clip >= views.len() || next_tag + count > tag_lines.len() {
            return Err(err("ranges: a range names a missing clip or tags"));
        }
        parsed.push((
            clip,
            r[1],
            r[2],
            tag_lines[next_tag..next_tag + count].to_vec(),
        ));
        next_tag += count;
    }
    let range_lists: Vec<Vec<TaggedRange<'_>>> = (0..views.len())
        .map(|c| {
            parsed
                .iter()
                .filter(|p| p.0 == c)
                .map(|p| TaggedRange {
                    start: p.1,
                    end: p.2,
                    tags: &p.3,
                })
                .collect()
        })
        .collect();
    let bake_clips: Vec<BakeClip<'_>> = views
        .iter()
        .enumerate()
        .map(|(i, v)| BakeClip {
            view: *v,
            form: if v.compressed().is_some() {
                Form::Compressed
            } else {
                Form::Raw
            },
            asset: names[i],
            ranges: &range_lists[i],
            mirror: extras.clip_flags.get(i).is_some_and(|f| f & 1 != 0),
        })
        .collect();
    let custom_names: Vec<&str> = if extras.custom_names.is_empty() {
        Vec::new()
    } else {
        extras.custom_names.split('\n').collect()
    };
    if !extras.custom.len().is_multiple_of(CUSTOM_LEN)
        || extras.custom.len() / CUSTOM_LEN != custom_names.len()
    {
        return Err(err("custom: 2 values and a name per custom feature"));
    }
    let custom: Vec<CustomFeature<'_>> = extras
        .custom
        .as_chunks::<CUSTOM_LEN>()
        .0
        .iter()
        .zip(&custom_names)
        .map(|(c, name)| CustomFeature {
            name,
            dims: if c[0] >= 1.0 && c[0] <= 4.0 {
                c[0] as u16
            } else {
                0
            },
            weight: c[1],
        })
        .collect();
    if !schema.len().is_multiple_of(FEATURE_LEN) {
        return Err(err("schema: 4 values per feature"));
    }
    let features: Vec<FeatureSpec> = schema
        .as_chunks::<FEATURE_LEN>()
        .0
        .iter()
        .map(|f| FeatureSpec {
            kind: FeatureKind::from_u8(f[0] as u8).unwrap_or(FeatureKind::Custom),
            bone: if f[1] >= 0.0 { f[1] as u32 } else { NONE },
            weight: f[2],
            time_offset: f[3],
        })
        .collect();
    let mut s = BakeSettings::default();
    let g = |i: usize| bake_settings.get(i).copied();
    if let Some(v) = g(0) {
        s.sample_rate = v;
    }
    if let Some(v) = g(1) {
        s.std_floor = v;
    }
    if let Some(v) = g(2) {
        s.normalization = if v == 1.0 {
            Normalization::PerFeature
        } else {
            Normalization::PerDimension
        };
    }
    if let Some(v) = g(3) {
        s.kd_tree = v != 0.0;
    }
    if let Some(v) = g(4) {
        if v >= 1.0 {
            s.leaf_size = v as usize;
        }
    }
    if let Some(v) = g(5) {
        s.root_bone = (v >= 0.0).then_some(v as u32);
    }
    if !skeleton_name.is_empty() {
        s.skeleton = Some(skeleton_name);
    }
    s.mirror = extras.mirror;
    s.custom = &custom;
    anim_match::bake(&skel, &bake_clips, &features, &s)
        .map(|b| b.bytes)
        .map_err(|e| err(format_args!("pose database: {e:?}")))
}

// ---------------------------------------------------------------------------------------------
// The wasm boundary: thin wrappers that keep the last report and error.
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Last {
    report: Vec<f64>,
    error: String,
}

thread_local! {
    static LAST: RefCell<Last> = RefCell::new(Last::default());
}

fn finish<T: Default>(r: Result<T, CompileError>, report: Option<Vec<f64>>) -> T {
    LAST.with(|l| {
        let mut l = l.borrow_mut();
        l.report = report.unwrap_or_default();
        match r {
            Ok(v) => {
                l.error.clear();
                v
            }
            Err(e) => {
                l.error = e.0;
                T::default()
            }
        }
    })
}

fn with_report(r: Result<(Vec<u8>, Report), CompileError>) -> Vec<u8> {
    match r {
        Ok((bytes, rep)) => finish(Ok(bytes), Some(report_record(&rep))),
        Err(e) => finish(Err(e), None),
    }
}

/// [`COMPILER_VERSION`].
#[wasm_bindgen]
pub fn compiler_version() -> u32 {
    COMPILER_VERSION
}

/// The source hash the module was built from, as 32 lowercase hex digits.
#[wasm_bindgen]
pub fn source_hash() -> String {
    SOURCE_HASH.iter().map(|b| format!("{b:02x}")).collect()
}

/// [`compile_clip`]: the compressed file, or empty (`last_error`); the report in `last_report`.
#[wasm_bindgen]
pub fn compress_clip(clip: &[u8], skeleton: &[u8], settings: &[f32]) -> Vec<u8> {
    with_report(compile_clip(clip, skeleton, settings))
}

/// [`compile_skeleton`]: the skeleton file, or empty (`last_error`).
#[wasm_bindgen]
pub fn skeleton_compile(skeleton: &[u8], roles: &[u16], profile: &str) -> Vec<u8> {
    finish(compile_skeleton(skeleton, roles, profile), None)
}

/// [`compile_retarget`]: the compressed target clip, or empty (`last_error`); the report in `last_report`.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn retarget_bake_compressed(
    source_skeleton: &[u8],
    source_profile: &[u8],
    source_map: &[u16],
    target_skeleton: &[u8],
    target_profile: &[u8],
    target_map: &[u16],
    flags: u32,
    clip: &[u8],
    root_axes: u32,
    ik_weights: &[f32],
    settings: &[f32],
) -> Vec<u8> {
    with_report(compile_retarget(
        RetargetInput {
            skeleton: source_skeleton,
            profile: source_profile,
            map: source_map,
        },
        RetargetInput {
            skeleton: target_skeleton,
            profile: target_profile,
            map: target_map,
        },
        flags,
        clip,
        root_axes,
        ik_weights,
        settings,
    ))
}

/// [`compile_posedb`]: the database file, or empty (`last_error`). `clip_flags`, `mirror`,
/// `custom` and `custom_names` are [`PosedbExtras`]'s fields (T70; empty for none).
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn posedb_bake(
    skeleton: &[u8],
    skeleton_name: &str,
    clips: &[u8],
    clip_lengths: &[u32],
    assets: &str,
    ranges: &[f32],
    tags: &str,
    schema: &[f32],
    settings: &[f32],
    clip_flags: &[u32],
    mirror: &[u32],
    custom: &[f32],
    custom_names: &str,
) -> Vec<u8> {
    finish(
        compile_posedb(
            skeleton,
            skeleton_name,
            clips,
            clip_lengths,
            assets,
            ranges,
            tags,
            schema,
            settings,
            &PosedbExtras {
                clip_flags,
                mirror,
                custom,
                custom_names,
            },
        ),
        None,
    )
}

/// [`meter_module`]: the metered module, or empty (`last_error` says why it was refused).
#[wasm_bindgen]
pub fn meter_node_module(bytes: &[u8]) -> Vec<u8> {
    finish(meter_module(bytes), None)
}

/// The fuel pass's version ([`anim_meter::METER_VERSION`]): a metered module's cache key includes it.
#[wasm_bindgen]
pub fn meter_version() -> u32 {
    anim_meter::METER_VERSION
}

/// The last compression's report record ([`REPORT_LEN`] values; empty after a failure or another call).
#[wasm_bindgen]
pub fn last_report() -> Vec<f64> {
    LAST.with(|l| l.borrow().report.clone())
}

/// Why the last call returned nothing ("" after a success).
#[wasm_bindgen]
pub fn last_error() -> String {
    LAST.with(|l| l.borrow().error.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_hash_is_32_hex_digits() {
        let h = source_hash();
        assert_eq!(h.len(), 32);
        assert!(h.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn settings_record_defaults_and_values() {
        let s = settings_from(&[]).unwrap();
        assert_eq!(s, Settings::default());
        let s = settings_from(&[2e-4, 1e-3, 24.0, 16.0, 8.0, 0.0, 9.0, 1.0]).unwrap();
        assert_eq!(s.error, 2e-4);
        assert_eq!(s.property_error, 1e-3);
        assert_eq!(s.sample_rate, Some(24.0));
        assert_eq!(s.max_bit_rate, 16);
        assert_eq!(s.segment_frames, 8);
        assert_eq!(s.root_motion, Some(RootMotion { bone: 0, axes: 9 }));
        assert!(s.keep_raw);
        assert!(settings_from(&[1e-4, 1e-4, 0.0, 40.0]).is_err());
        assert_eq!(
            settings_from(&[1e-4, 1e-4, 0.0, 32.0, 0.0, -1.0])
                .unwrap()
                .root_motion,
            None
        );
    }

    #[test]
    fn refused_node_modules_set_the_error() {
        assert!(meter_node_module(&[0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).is_empty());
        assert!(last_error().starts_with("node module:"), "{}", last_error());
        assert_eq!(meter_version(), anim_meter::METER_VERSION);
    }

    #[test]
    fn failures_set_the_error_and_clear_the_report() {
        assert!(compress_clip(&[1, 2, 3], &[], &[]).is_empty());
        assert!(last_error().starts_with("clip:"));
        assert!(last_report().is_empty());
    }
}
