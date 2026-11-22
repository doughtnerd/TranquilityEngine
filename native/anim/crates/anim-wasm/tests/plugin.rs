//! Third-party nodes through the core (T45 core half): registering a module's descriptor, binding
//! it into a graph, and the fault path. Natively there is no host function, so every call faults
//! with `FAULT_NO_HOST`: the node passes its input through, each node instance reports once (in
//! the `plugin` family's fault records), and snapshots stay exact. The success path runs through
//! `anim-graph`'s interface with a native host (`anim-graph/tests/plugin.rs`) and through the built
//! wasm with a JavaScript host (`plugin.node.test.ts`).

mod common;

use anim_format::graph::family;
use anim_graph::plugin::{self, plugin_node_params};
use anim_plugin_sdk::descriptor::{encode, encoded_len};
use anim_plugin_sdk::{Context, Inputs, Node, NodeDesc, ParamDesc, Params, Transform, Unit};
use anim_wire::core::{STATUS_BAD_ASSET, STATUS_OK};
use anim_wire::plugin::{
    PluginFault, FAULT_MISMATCH, FAULT_NOT_FINITE, FAULT_NO_HOST, FAULT_NO_MODULE, FAULT_NO_ROOM,
};
use anim_wire::WireRecord;
use common::graph::*;
use common::*;

const MAX_BONES: u32 = 64;

struct Scale;
impl Node for Scale {
    const KIND: u32 = 2;
    const NAME: &'static str = "scale";
    const PARAMS: &'static [ParamDesc] =
        &[ParamDesc::float("factor", Unit::Multiplier, 0.0, 10.0, 1.0).animatable()];
    type State = ();
    fn evaluate(_: &Context<'_>, _: &Inputs<'_>, _: &Params<'_>, _: &mut (), _: &mut [Transform]) {}
}

struct Counter;
impl Node for Counter {
    const KIND: u32 = 3;
    const NAME: &'static str = "counter";
    type State = [f32; 2];
    fn evaluate(_: &Context<'_>, _: &Inputs<'_>, _: &Params<'_>, _: &mut [f32; 2], _: &mut [Transform]) {}
}

const NODES: &[NodeDesc] = &[Scale::DESC, Counter::DESC];
const LEN: usize = encoded_len(NODES);
static DESCRIPTOR: [u8; LEN] = encode::<LEN>(NODES);

fn faults(core: &anim_wasm::init::Core) -> Vec<PluginFault> {
    core.plugin_faults()
        .chunks_exact(PluginFault::STRIDE as usize)
        .map(|c| PluginFault::decode(c).unwrap())
        .collect()
}

/// `REFERENCE_POSE → PLUGIN_NODE(kind)`, the module named by string "module"; returns the graph,
/// the plugin node and the module's string id.
fn graph(kind: u32, state_bytes: u32) -> (Vec<u8>, u32, u32) {
    let mut b = Builder::new();
    let module = b.s("module");
    let r = b.node(family::SOURCES, anim_graph::sources::kind::REFERENCE_POSE, &[], &[]);
    let p = plugin_node_params(module, kind, state_bytes, &[2.0f32.to_bits()], &[]);
    let n = b.node(family::PLUGIN, plugin::kind::PLUGIN_NODE, &[r], &p);
    (b.build(n), n, module)
}

#[test]
fn the_core_side_statuses_match_the_wire_family() {
    assert_eq!(plugin::fault::NO_MODULE, FAULT_NO_MODULE);
    assert_eq!(plugin::fault::MISMATCH, FAULT_MISMATCH);
    assert_eq!(plugin::fault::NO_ROOM, FAULT_NO_ROOM);
    assert_eq!(plugin::fault::NO_HOST, FAULT_NO_HOST);
    assert_eq!(plugin::fault::NOT_FINITE, FAULT_NOT_FINITE);
}

#[test]
fn registration_checks_the_descriptor() {
    let mut core = core(4, MAX_BONES);
    let m = core.plugin_register(&DESCRIPTOR);
    assert_ne!(m, 0);
    assert_eq!(core.last_status(), STATUS_OK);
    let mut bad = DESCRIPTOR.to_vec();
    bad[0] = b'X';
    assert_eq!(core.plugin_register(&bad), 0);
    assert_eq!(core.last_status(), STATUS_BAD_ASSET);
    assert_eq!(core.plugin_register(&DESCRIPTOR[..LEN - 1]), 0);
    // A module handle is an asset: released, it goes stale.
    assert_eq!(core.release(m), STATUS_OK);
    assert_ne!(core.release(m), STATUS_OK);
}

#[test]
fn without_a_host_the_input_passes_through_and_each_instance_reports_once() {
    let (_, skel_bytes) = skeleton(Shape::Humanoid, 3);
    let mut core = core(4, MAX_BONES);
    let s = core.load_skeleton(&skel_bytes);
    let bones = anim_format::skeleton::SkeletonView::parse(&skel_bytes)
        .unwrap()
        .bone_count();
    let m = core.plugin_register(&DESCRIPTOR);
    let (g, node, module) = graph(Counter::KIND, 8);
    let (_, a) = instance(&mut core, &g, s, &[(module, m)]);
    let (_, b) = instance(&mut core, &g, s, &[(module, m)]);
    // The same pose without the plugin node.
    let mut plain = Builder::new();
    let r = plain.node(family::SOURCES, anim_graph::sources::kind::REFERENCE_POSE, &[], &[]);
    let (_, p) = instance(&mut core, &plain.build(r), s, &[]);

    frame(&mut core, 1.0 / 30.0);
    let mut got = faults(&core);
    got.sort_by_key(|f| f.instance);
    assert_eq!(
        got,
        vec![
            PluginFault {
                instance: a,
                node,
                module: m,
                kind: Counter::KIND,
                status: FAULT_NO_HOST
            },
            PluginFault {
                instance: b,
                node,
                module: m,
                kind: Counter::KIND,
                status: FAULT_NO_HOST
            },
        ]
    );
    let want = matrices(&core, p, MAX_BONES as usize, bones);
    assert_eq!(matrices(&core, a, MAX_BONES as usize, bones), want);
    for _ in 0..3 {
        frame(&mut core, 1.0 / 30.0);
        assert!(faults(&core).is_empty(), "reported once per node instance");
        assert_eq!(matrices(&core, b, MAX_BONES as usize, bones), want);
    }

    // Snapshot and restore: the fault flags and the module's state are in the blob.
    let n = core.snapshot_bytes(a) as usize;
    let mut snap = vec![0u8; n];
    assert_eq!(core.snapshot(a, &mut snap), STATUS_OK);
    let run = |core: &mut anim_wasm::init::Core| {
        (0..3)
            .map(|_| {
                frame(core, 1.0 / 30.0);
                (matrices(core, a, MAX_BONES as usize, bones), faults(core))
            })
            .collect::<Vec<_>>()
    };
    let first = run(&mut core);
    assert_eq!(core.restore(a, &snap), STATUS_OK);
    assert_eq!(run(&mut core), first);
}

#[test]
fn an_unbound_module_or_a_wrong_state_size_faults() {
    let (_, skel_bytes) = skeleton(Shape::Chain(5), 3);
    let mut core = core(4, MAX_BONES);
    let s = core.load_skeleton(&skel_bytes);
    let m = core.plugin_register(&DESCRIPTOR);
    let (g, _, _) = graph(Scale::KIND, 0);
    let (_, a) = instance(&mut core, &g, s, &[]);
    let (g, _, module) = graph(Counter::KIND, 4);
    let (_, b) = instance(&mut core, &g, s, &[(module, m)]);
    frame(&mut core, 1.0 / 30.0);
    let mut got: Vec<(u32, u32)> = faults(&core).iter().map(|f| (f.instance, f.status)).collect();
    got.sort();
    assert_eq!(got, vec![(a, FAULT_NO_MODULE), (b, FAULT_MISMATCH)]);
}
