//! Shared test helpers: synthetic skeletons and compressed clips (anim-compress's generators),
//! driving the [`Core`] through its calls and views, and the f64 reference (`anim-offline`) of what
//! it should show.
#![allow(dead_code)]

#[path = "../../../anim-compress/tests/common/mod.rs"]
pub mod synth;

pub mod graph;
pub mod rig;

use anim_compress::{compress, RootMotion, Settings, ROOT_ALL};
use anim_format::clip::ClipView;
use anim_format::skeleton::{Skeleton, SkeletonView};
use anim_offline::math::{Mat3x4, Transform};
use anim_offline::pose as offline;
use anim_offline::sample as osample;
use anim_wasm::init::Core;
use anim_wire::core::{
    Init, Play, SetLayer, StateChange, Stop, INPUT_FLAGS, INPUT_LAYER_WEIGHTS, INPUT_LOD_STEP,
    INPUT_STRIDE, INPUT_TIME_SCALE, MATRIX_FLOATS, ROOT_STRIDE, STATUS_OK,
};
use anim_wire::WireRecord;
pub use synth::{Rng, Shape};

/// A skeleton of `shape` whose inverse bind matrices invert its rest pose's model space (so the
/// rest pose skins to identity), and its file.
pub fn skeleton(shape: Shape, seed: u64) -> (Skeleton, Vec<u8>) {
    let mut rng = Rng::new(seed);
    let mut skel = synth::skeleton(shape, &mut rng);
    let (rest, parents) = synth::rest_and_parents(&skel);
    let model = offline::model_space(&parents, &rest);
    let inv = offline::inverse_bind_matrices(&model);
    for (b, m) in skel.bones.iter_mut().zip(&inv) {
        for (o, v) in b.inverse_bind.iter_mut().zip(m.m) {
            *o = v as f32;
        }
    }
    let bytes = skel.write().unwrap();
    (skel, bytes)
}

/// A compressed clip over `skel` (`seconds` long, 30 Hz, the root walking and turning), with its
/// root curve on bone 0.
pub fn clip(skel: &Skeleton, seconds: f64, looping: bool, seed: u64) -> Vec<u8> {
    let mut rng = Rng::new(seed);
    let clip = synth::clip(skel, seconds, looping, &mut rng);
    let settings = Settings {
        root_motion: Some(RootMotion {
            bone: 0,
            axes: ROOT_ALL,
        }),
        ..Settings::default()
    };
    compress(&clip, Some(skel), &settings).unwrap().bytes
}

/// [`clip`] plus an `event` track: one notify (method string 0, `"footstep"`) at `at` seconds,
/// threshold 0.5.
pub fn clip_with_event(
    skel: &Skeleton,
    seconds: f64,
    looping: bool,
    seed: u64,
    at: f32,
) -> Vec<u8> {
    use anim_format::clip::{Binding, Key, KeyData, Track, TrackKind};
    let mut rng = Rng::new(seed);
    let mut clip = synth::clip(skel, seconds, looping, &mut rng);
    clip.strings = vec!["footstep".into()];
    clip.tracks.push(Track {
        kind: TrackKind::Event,
        flags: 0,
        subtype: 0,
        binding: Binding::none(),
        raw: Vec::new(),
        keys: vec![Key {
            time: at,
            end: at,
            data: KeyData::Event {
                method: 0,
                args: anim_format::NONE,
                threshold: 0.5,
                always: false,
            },
        }],
    });
    let settings = Settings {
        root_motion: Some(RootMotion {
            bone: 0,
            axes: ROOT_ALL,
        }),
        ..Settings::default()
    };
    compress(&clip, Some(skel), &settings).unwrap().bytes
}

/// The `tracks` records of instance `h` this frame, as (opcode, bytes).
pub fn track_records(core: &Core, h: u32) -> Vec<(u16, Vec<u8>)> {
    use anim_wire::core::{TRACK_RECORDS, TRACK_STRIDE};
    use anim_wire::tracks::{OutputHeader, FAMILY};
    let words = TRACK_STRIDE as usize / 4;
    let row = &core.tracks()[(h & 0xFFFF) as usize * words..][..words];
    let bytes: Vec<u8> = row.iter().flat_map(|w| w.to_le_bytes()).collect();
    let header = OutputHeader::decode(&bytes).unwrap();
    let mut at = TRACK_RECORDS as usize;
    let end = at + header.record_bytes as usize;
    let mut out = Vec::new();
    while at < end {
        let op = u16::from_le_bytes([bytes[at], bytes[at + 1]]);
        let d = FAMILY.records.iter().find(|d| d.opcode == op).unwrap();
        out.push((op, bytes[at..at + d.stride as usize].to_vec()));
        at += d.stride as usize;
    }
    assert_eq!(out.len(), header.record_count as usize);
    out
}

/// A started core.
pub fn core(max_instances: u32, max_bones: u32) -> Core {
    let mut core = Core::new();
    let reply = core.init(
        &Init {
            max_instances,
            max_bones,
            arena_initial_bytes: 1 << 20,
        }
        .encode(),
    );
    assert_eq!(reply.status, STATUS_OK);
    core
}

/// Encodes commands into the command buffer and applies them; returns the count applied.
pub fn send(core: &mut Core, commands: &[Vec<u8>]) -> u32 {
    let buf = core.commands_mut();
    let mut at = 0;
    for c in commands {
        buf[at..at + c.len()].copy_from_slice(c);
        at += c.len();
    }
    core.write_inputs(at as u32)
}

pub fn play(instance: u32, clip: u32, layer: u32, fade: f32, play_id: u32, flags: u32) -> Vec<u8> {
    Play {
        instance,
        clip,
        play_id,
        layer,
        fade,
        speed: 1.0,
        start: 0.0,
        flags,
    }
    .encode()
}

pub fn stop(instance: u32, layer: u32, fade: f32) -> Vec<u8> {
    Stop {
        instance,
        layer,
        fade,
        flags: 0,
    }
    .encode()
}

pub fn set_layer(instance: u32, layer: u32, mask: u32, mode: u32) -> Vec<u8> {
    SetLayer {
        instance,
        layer,
        mask,
        mode,
    }
    .encode()
}

fn row(h: u32) -> usize {
    (h & 0xFFFF) as usize * (INPUT_STRIDE / 4) as usize
}

pub fn set_lod(core: &mut Core, h: u32, step: u32) {
    let r = row(h);
    core.inputs_mut()[r + (INPUT_LOD_STEP / 4) as usize] = step;
}

pub fn set_flags(core: &mut Core, h: u32, flags: u32) {
    let r = row(h);
    core.inputs_mut()[r + (INPUT_FLAGS / 4) as usize] = flags;
}

pub fn set_time_scale(core: &mut Core, h: u32, scale: f32) {
    let r = row(h);
    core.inputs_mut()[r + (INPUT_TIME_SCALE / 4) as usize] = scale.to_bits();
}

pub fn set_layer_weight(core: &mut Core, h: u32, layer: usize, w: f32) {
    let r = row(h);
    core.inputs_mut()[r + (INPUT_LAYER_WEIGHTS / 4) as usize + layer] = w.to_bits();
}

/// Instance `h`'s bone matrices.
pub fn matrices(core: &Core, h: u32, max_bones: usize, bones: usize) -> Vec<f32> {
    let at = (h & 0xFFFF) as usize * max_bones * MATRIX_FLOATS as usize;
    core.matrices()[at..at + bones * MATRIX_FLOATS as usize].to_vec()
}

/// Instance `h`'s root delta: translation then rotation.
pub fn root(core: &Core, h: u32) -> [f32; 7] {
    let at = (h & 0xFFFF) as usize * (ROOT_STRIDE / 4) as usize;
    core.roots()[at..at + 7].try_into().unwrap()
}

/// The state changes after the last evaluate.
// A runtime stride; `unknown_lints`: the lint is newer than some stable clippy versions.
#[allow(unknown_lints, clippy::chunks_exact_to_as_chunks)]
pub fn changes(core: &Core) -> Vec<StateChange> {
    core.changes()
        .chunks_exact(StateChange::STRIDE as usize)
        .map(|c| StateChange::decode(c).unwrap())
        .collect()
}

/// The f64 reference: the skeleton's rest pose, parents and inverse binds.
pub struct Reference {
    pub rest: Vec<Transform>,
    pub parents: Vec<u16>,
    pub inverse_bind: Vec<Mat3x4>,
}

impl Reference {
    pub fn new(skel_bytes: &[u8]) -> Reference {
        let view = SkeletonView::parse(skel_bytes).unwrap();
        let rest = osample::rest_pose(&view);
        let parents = osample::parents(&view);
        let inverse_bind = (0..view.bone_count())
            .map(|i| {
                let ib = view.bone(i).unwrap().inverse_bind;
                Mat3x4 {
                    m: ib.map(|v| v as f64),
                }
            })
            .collect();
        Reference {
            rest,
            parents,
            inverse_bind,
        }
    }

    /// A clip's local pose at `t` (compressed form).
    pub fn sample(&self, clip: &[u8], t: f64) -> Vec<Transform> {
        let view = ClipView::parse(clip).unwrap();
        osample::sample_compressed_pose(&view, &self.rest, t).unwrap()
    }

    /// The bone matrices of a local pose, flattened like the matrix view.
    pub fn matrices(&self, local: &[Transform]) -> Vec<f64> {
        offline::skinning_matrices(&self.parents, local, &self.inverse_bind)
            .iter()
            .flat_map(|m| m.m)
            .collect()
    }
}

/// The largest absolute difference.
pub fn max_diff(a: &[f32], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(x, y)| (*x as f64 - y).abs())
        .fold(0.0, f64::max)
}
