//! The SDK through its public interface: the descriptor encoder and parser, and the exports
//! `export_nodes!` generates, called natively the way the host calls them in wasm.

use anim_plugin_sdk::abi::{self, state_stride, Status, BONE_FLOATS, NO_PARENT};
use anim_plugin_sdk::descriptor::{
    encode, encoded_len, nodes_problem, param_words, Descriptor, DescriptorError, NodeDesc, HEADER_BYTES, PARAM_ANIMATABLE,
};
use anim_plugin_sdk::{export_nodes, Context, Inputs, Node, ParamDesc, ParamKind, Params, Transform, Unit};

/// Adds `offset` to every translation of input 0 and blends towards input 1 by `mix`; counts calls.
struct Offset;
impl Node for Offset {
    const KIND: u32 = 7;
    const NAME: &'static str = "offset";
    const INPUTS: u8 = 2;
    const PARAMS: &'static [ParamDesc] = &[
        ParamDesc::vec3("offset", Unit::Meters, -10.0, 10.0, [0.0, 0.0, 0.0]).animatable(),
        ParamDesc::float("mix", Unit::Ratio, 0.0, 1.0, 0.25),
        ParamDesc::int("count_step", -5, 5, 1),
        ParamDesc::bool("enabled", true),
        ParamDesc::quat("spin", [0.0, 0.0, 0.0, 1.0]),
        ParamDesc::vec2("unused", Unit::None, -1.0, 1.0, [0.5, -0.5]),
    ];
    type State = [u32; 3];
    fn evaluate(_cx: &Context<'_>, inputs: &Inputs<'_>, p: &Params<'_>, state: &mut [u32; 3], out: &mut [Transform]) {
        state[0] = state[0].wrapping_add(p.int(2) as u32);
        if !p.bool(3) {
            return;
        }
        let o = p.vec3(0);
        let mix = p.float(1);
        let b = inputs.pose(1);
        for (t, tb) in out.iter_mut().zip(b) {
            for k in 0..3 {
                t.translation[k] = t.translation[k] + (tb.translation[k] - t.translation[k]) * mix + o[k];
            }
        }
    }
}

/// A 0-input node that reads the skeleton: writes each bone's depth into translation.y.
struct Depth;
impl Node for Depth {
    const KIND: u32 = 3;
    const NAME: &'static str = "depth";
    const INPUTS: u8 = 0;
    const NEEDS_SKELETON: bool = true;
    type State = ();
    fn evaluate(cx: &Context<'_>, _: &Inputs<'_>, _: &Params<'_>, _: &mut (), out: &mut [Transform]) {
        for b in 0..cx.bones {
            let mut d = 0.0;
            let mut p = cx.parents[b];
            while p != NO_PARENT {
                d += 1.0;
                p = cx.parents[p as usize];
            }
            out[b].translation[1] = d;
        }
    }
}

export_nodes!(Offset, Depth);

const NODES: &[NodeDesc] = &[Offset::DESC, Depth::DESC];

fn blob() -> &'static [u8] {
    let p = myco_node_describe();
    let len = Descriptor::total_len(unsafe { std::slice::from_raw_parts(p, HEADER_BYTES) }).unwrap();
    unsafe { std::slice::from_raw_parts(p, len) }
}

#[test]
fn abi_version_is_exported() {
    assert_eq!(myco_node_abi_version(), abi::ABI_VERSION);
}

#[test]
fn descriptor_round_trips() {
    const LEN: usize = encoded_len(NODES);
    let bytes: [u8; LEN] = encode::<LEN>(NODES);
    assert_eq!(&bytes[..], blob(), "the exported blob is the encoder's output");
    let d = Descriptor::parse(&bytes).unwrap();
    assert_eq!(d.node_count(), 2);
    for (view, desc) in d.nodes().zip(NODES) {
        assert_eq!(view.kind, desc.kind);
        assert_eq!(view.name, desc.name);
        assert_eq!(view.inputs, desc.inputs);
        assert_eq!(view.flags, desc.flags);
        assert_eq!(view.state_bytes, desc.state_bytes);
        assert_eq!(view.param_count(), desc.params.len());
        assert_eq!(view.param_words(), param_words(desc.params));
        for (pv, pd) in view.params().checked().zip(desc.params) {
            assert_eq!(pv.name, pd.name);
            assert_eq!(pv.kind, pd.kind);
            assert_eq!(pv.unit, pd.unit);
            assert_eq!(pv.flags, pd.flags);
            assert_eq!((pv.min, pv.max, pv.default), (pd.min, pd.max, pd.default));
        }
    }
    let offset = d.node(7).unwrap();
    assert_eq!(offset.state_bytes, 12);
    assert_eq!(offset.param_words(), 3 + 1 + 1 + 1 + 4 + 2);
    let first = offset.params().checked().next().unwrap();
    assert!(first.is_animatable() && first.flags == PARAM_ANIMATABLE && first.kind == ParamKind::Vec3);
    assert!(d.node(3).unwrap().needs_skeleton());
    assert!(d.node(4).is_none());
}

/// Byte offset of the first node's first parameter record.
const P0: usize = HEADER_BYTES + 13 + "offset".len();

fn reparse(edit: impl FnOnce(&mut Vec<u8>)) -> Result<(), DescriptorError> {
    let mut b = blob().to_vec();
    edit(&mut b);
    Descriptor::parse(&b).map(|_| ())
}

#[test]
fn parse_refuses_broken_blobs() {
    use DescriptorError as E;
    assert_eq!(reparse(|b| b[0] = b'X'), Err(E::BadMagic));
    assert_eq!(reparse(|b| b[4] = 2), Err(E::UnsupportedVersion));
    assert_eq!(reparse(|b| b[12] = 1), Err(E::BadReserved));
    assert_eq!(reparse(|b| b.truncate(b.len() - 1)), Err(E::Truncated));
    assert_eq!(reparse(|b| b.push(0)), Err(E::TrailingBytes));
    assert_eq!(reparse(|b| b[6] = 0), Err(E::BadNodeCount));
    // The second node's kind (3) rewritten to the first's (7).
    let second = blob().len() - (13 + "depth".len());
    assert_eq!(reparse(|b| b[second] = 7), Err(E::DuplicateKind));
    assert_eq!(reparse(|b| b[second + 13..].copy_from_slice(b"dep-h")), Err(E::BadName));
    assert_eq!(reparse(|b| b[HEADER_BYTES + 4] = 9), Err(E::TooManyInputs));
    assert_eq!(reparse(|b| b[HEADER_BYTES + 5] = 0x80), Err(E::UnknownFlags));
    assert_eq!(reparse(|b| b[HEADER_BYTES + 13] = b'1'), Err(E::BadName));
    assert_eq!(reparse(|b| b[HEADER_BYTES + 10] = 2), Err(E::StateTooLarge));
    assert_eq!(reparse(|b| b[P0] = 6), Err(E::UnknownParamKind));
    assert_eq!(reparse(|b| b[P0 + 1] = 2), Err(E::UnknownFlags));
    assert_eq!(reparse(|b| b[P0 + 2] = 200), Err(E::UnknownUnit));
    // min (-10) above max (10).
    assert_eq!(reparse(|b| b[P0 + 4..P0 + 8].copy_from_slice(&11f32.to_le_bytes())), Err(E::BadRange));
    // default.x outside [-10, 10]; a non-zero unused word.
    assert_eq!(reparse(|b| b[P0 + 12..P0 + 16].copy_from_slice(&20f32.to_le_bytes())), Err(E::BadDefault));
    assert_eq!(reparse(|b| b[P0 + 24] = 1), Err(E::BadDefault));
    assert_eq!(reparse(|b| b[P0 + 12..P0 + 16].copy_from_slice(&f32::NAN.to_le_bytes())), Err(E::BadDefault));
    // The last parameter ("unused") renamed to the first's name.
    let unused = blob().windows(6).position(|w| w == b"unused").unwrap();
    assert_eq!(reparse(|b| b[unused..unused + 6].copy_from_slice(b"offset")), Err(E::DuplicateName));
}

#[test]
fn node_lists_are_checked_like_blobs() {
    const P: &[ParamDesc] = &[ParamDesc::float("a", Unit::None, 0.0, 1.0, 0.5)];
    let node = |kind, name| NodeDesc { kind, name, inputs: 1, flags: 0, params: P, state_bytes: 0 };
    assert_eq!(nodes_problem(&[node(1, "a"), node(2, "b")]), None);
    assert_eq!(nodes_problem(&[]), Some(DescriptorError::BadNodeCount));
    assert_eq!(nodes_problem(&[node(1, "a"), node(1, "b")]), Some(DescriptorError::DuplicateKind));
    assert_eq!(nodes_problem(&[node(1, "a"), node(2, "a")]), Some(DescriptorError::DuplicateName));
    assert_eq!(nodes_problem(&[node(1, "bad-name")]), Some(DescriptorError::BadName));
    const DUP: &[ParamDesc] = &[ParamDesc::bool("x", false), ParamDesc::bool("x", true)];
    let dup = NodeDesc { kind: 1, name: "n", inputs: 0, flags: 0, params: DUP, state_bytes: 0 };
    assert_eq!(nodes_problem(&[dup]), Some(DescriptorError::DuplicateName));
    const RANGE: &[ParamDesc] = &[ParamDesc::int("i", 3, 1, 2)];
    let range = NodeDesc { kind: 1, name: "n", inputs: 0, flags: 0, params: RANGE, state_bytes: 0 };
    assert_eq!(nodes_problem(&[range]), Some(DescriptorError::BadRange));
    const DEF: &[ParamDesc] = &[ParamDesc::float("f", Unit::None, 0.0, 1.0, 2.0)];
    let def = NodeDesc { kind: 1, name: "n", inputs: 0, flags: 0, params: DEF, state_bytes: 0 };
    assert_eq!(nodes_problem(&[def]), Some(DescriptorError::BadDefault));
}

fn pose(bones: usize, f: impl Fn(usize) -> Transform) -> Vec<f32> {
    let mut v = Vec::with_capacity(bones * BONE_FLOATS);
    for b in 0..bones {
        let t = f(b);
        v.extend_from_slice(&t.translation);
        v.extend_from_slice(&t.rotation);
        v.extend_from_slice(&t.scale);
    }
    v
}

fn at(x: f32) -> Transform {
    Transform { translation: [x, 2.0 * x, 3.0 * x], ..Transform::IDENTITY }
}

/// A 16-aligned zeroed state buffer.
fn states(count: usize, bytes: usize) -> Vec<u128> {
    vec![0u128; (count * state_stride(bytes)).div_ceil(16)]
}

#[test]
fn evaluate_runs_a_batch() {
    let (count, bones) = (3usize, 5usize);
    // Instance i: input 0 at x = i, input 1 at x = 10 + i.
    let mut input = Vec::new();
    for i in 0..count {
        input.extend(pose(bones, |b| at(i as f32 + b as f32 * 0.0)));
        input.extend(pose(bones, |_| at(10.0 + i as f32)));
    }
    let words = param_words(Offset::PARAMS);
    let mut params = Vec::new();
    for i in 0..count {
        let mix = [0.0f32, 0.5, 1.0][i];
        params.extend([1f32.to_bits(), 0, 0, mix.to_bits(), 2, (i != 1) as u32, 0, 0, 0, 0x3f80_0000, 0, 0]);
    }
    assert_eq!(params.len(), count * words);
    let mut output = vec![f32::NAN; count * bones * BONE_FLOATS];
    let mut state = states(count, 12);
    for frame in 1..=2u32 {
        let status = unsafe {
            myco_node_evaluate(
                Offset::KIND,
                count as u32,
                bones as u32,
                std::ptr::null(),
                input.as_ptr(),
                output.as_mut_ptr(),
                params.as_ptr(),
                state.as_mut_ptr().cast(),
                1.0 / 60.0,
            )
        };
        assert_eq!(status, Status::Ok as u32);
        let s: &[u32] = unsafe { std::slice::from_raw_parts(state.as_ptr().cast(), state.len() * 4) };
        for i in 0..count {
            assert_eq!(s[i * state_stride(12) / 4], 2 * frame, "state persists across calls");
        }
    }
    for i in 0..count {
        let a = i as f32;
        let b = 10.0 + a;
        let mix = [0.0f32, 0.5, 1.0][i];
        for bone in 0..bones {
            let t = &output[(i * bones + bone) * BONE_FLOATS..][..BONE_FLOATS];
            let x = if i == 1 { a } else { a + (b - a) * mix + 1.0 };
            assert_eq!(t[0], x, "instance {i} bone {bone}");
            assert_eq!(&t[3..], &[0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0], "rotation and scale come from input 0");
        }
    }
}

#[test]
fn evaluate_passes_the_skeleton_and_fills_identity_for_zero_inputs() {
    let parents = [NO_PARENT, 0, 1, 1, NO_PARENT];
    let mut output = vec![f32::NAN; parents.len() * BONE_FLOATS];
    let status = unsafe {
        myco_node_evaluate(
            Depth::KIND,
            1,
            parents.len() as u32,
            parents.as_ptr(),
            std::ptr::null(),
            output.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            0.0,
        )
    };
    assert_eq!(status, Status::Ok as u32);
    let ys: Vec<f32> = output.chunks(BONE_FLOATS).map(|t| t[1]).collect();
    assert_eq!(ys, [0.0, 1.0, 2.0, 2.0, 0.0]);
    assert_eq!(&output[3..BONE_FLOATS], &[0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0]);
}

#[test]
fn evaluate_refuses_unknown_kinds_and_bad_pointers() {
    let nul = std::ptr::null_mut();
    let st = |kind, parents: *const u16| unsafe {
        myco_node_evaluate(kind, 1, 2, parents, std::ptr::null(), nul as *mut f32, std::ptr::null(), nul, 0.0)
    };
    assert_eq!(st(99, std::ptr::null()), Status::UnknownKind as u32);
    // Null output (and null parents for a skeleton node).
    assert_eq!(st(Depth::KIND, std::ptr::null()), Status::BadArguments as u32);
    // An empty batch needs no buffers.
    let empty = unsafe {
        myco_node_evaluate(Offset::KIND, 0, 2, std::ptr::null(), std::ptr::null(), nul.cast(), std::ptr::null(), nul, 0.0)
    };
    assert_eq!(empty, Status::Ok as u32);
    // Misaligned state.
    let input = pose(2, |b| at(b as f32)).repeat(2);
    let mut out = vec![0.0f32; 2 * BONE_FLOATS];
    let params = vec![0u32; param_words(Offset::PARAMS)];
    let mut state = states(2, 12);
    let bad = unsafe {
        myco_node_evaluate(
            Offset::KIND,
            1,
            2,
            std::ptr::null(),
            input.as_ptr(),
            out.as_mut_ptr(),
            params.as_ptr(),
            state.as_mut_ptr().cast::<u8>().add(4),
            0.0,
        )
    };
    assert_eq!(bad, Status::BadArguments as u32);
    assert_eq!(Status::from_u32(bad), Some(Status::BadArguments));
    assert_eq!(Status::from_u32(77), None);
    // Bone count beyond u16.
    let big = unsafe {
        myco_node_evaluate(Offset::KIND, 0, abi::MAX_BONES + 1, std::ptr::null(), std::ptr::null(), nul.cast(), std::ptr::null(), nul, 0.0)
    };
    assert_eq!(big, Status::BadArguments as u32);
}

#[test]
fn alloc_is_null_off_wasm() {
    assert!(myco_node_alloc(64).is_null());
}
