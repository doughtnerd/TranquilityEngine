//! The `plugin` family through the graph's interface (T45 core half), with a native host that runs
//! nodes written with `anim-plugin-sdk` through its native batch path (`export_nodes!`'s
//! `myco_node_evaluate`, the function a wasm module exports): `scale` is plugin-sample's node,
//! `counter` keeps state, `sum` takes two inputs. Covered: the SoA ↔ AoS conversion, parameter
//! blocks and bindings, nested plugin nodes, faults (pass-through, state kept, one report per node
//! instance), core-side faults (no host, unknown module, state-size mismatch), snapshot and
//! restore, and no allocation per frame.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::RefCell;
use std::sync::atomic::{AtomicUsize, Ordering};

use anim_format::graph::{family, AnimGraph, AnimGraphView, Node as GraphNode, Param, ParamValue};
use anim_format::NONE;
use anim_graph::eval::{
    Assets, ClipRef, Events, Inputs, Program, Scratch, SkeletonPose, StateEvent,
};
use anim_graph::plugin::{self, fault, Call, CallBuffers, Fault, NodeInfo, PluginHost};
use anim_math::layout::{pack_pose, soa_len};
use anim_math::{AosQuat, AosTransform, AosVec3, F32x4, SoaTransform};
use anim_plugin_sdk::abi::{state_stride, Status};
use anim_plugin_sdk::descriptor::{Descriptor, HEADER_BYTES};
use anim_plugin_sdk::{
    export_nodes, Context, Inputs as NodeInputs, Node, ParamDesc, Params, Transform, Unit,
};
use anim_pose::inertialize::Inertializer;

/// A `PLUGIN_NODE`'s parameter words (`anim_graph::plugin`'s layout): module string id, kind, state
/// bytes, the block, then bindings `(offset, words, parameter)`.
fn plugin_node_params(
    module: u32,
    kind: u32,
    state_bytes: u32,
    block: &[u32],
    bindings: &[(u32, u32, u32)],
) -> Vec<u32> {
    let mut w = vec![module, kind, state_bytes, block.len() as u32];
    w.extend_from_slice(block);
    w.push(bindings.len() as u32);
    for &(o, n, p) in bindings {
        w.extend_from_slice(&[o, n, p]);
    }
    w
}

/// A `PLUGIN_NODE`'s state words: (flags, last fault status).
fn fault_state(s: &[u32]) -> (u32, u32) {
    (s[plugin::state::FLAGS], s[plugin::state::STATUS])
}

// ---- The nodes (a plugin crate's code) ----

/// plugin-sample's `scale`: every translation times `factor`.
struct Scale;
impl Node for Scale {
    const KIND: u32 = 2;
    const NAME: &'static str = "scale";
    const PARAMS: &'static [ParamDesc] =
        &[ParamDesc::float("factor", Unit::Multiplier, 0.0, 10.0, 1.0).animatable()];
    type State = ();
    fn evaluate(
        _: &Context<'_>,
        _: &NodeInputs<'_>,
        p: &Params<'_>,
        _: &mut (),
        out: &mut [Transform],
    ) {
        let f = p.float(0);
        for t in out {
            for v in &mut t.translation {
                *v *= f;
            }
        }
    }
}

/// Keeps the time it has run; lifts bone 0 by it.
struct Counter;
impl Node for Counter {
    const KIND: u32 = 3;
    const NAME: &'static str = "counter";
    type State = [f32; 2];
    fn evaluate(
        cx: &Context<'_>,
        _: &NodeInputs<'_>,
        _: &Params<'_>,
        s: &mut [f32; 2],
        out: &mut [Transform],
    ) {
        s[0] += cx.dt;
        s[1] += 1.0;
        out[0].translation[1] += s[0];
    }
}

/// Two inputs: translations added, rotations from input 0.
struct Sum;
impl Node for Sum {
    const KIND: u32 = 4;
    const NAME: &'static str = "sum";
    const INPUTS: u8 = 2;
    const NEEDS_SKELETON: bool = true;
    type State = ();
    fn evaluate(
        cx: &Context<'_>,
        inputs: &NodeInputs<'_>,
        _: &Params<'_>,
        _: &mut (),
        out: &mut [Transform],
    ) {
        assert_eq!(cx.parents.len(), cx.bones);
        let b = inputs.pose(1);
        for (o, t) in out.iter_mut().zip(b) {
            for k in 0..3 {
                o.translation[k] += t.translation[k];
            }
        }
    }
}

export_nodes!(Scale, Counter, Sum);

// ---- The host ----

const SAMPLE: u32 = 1;
/// A module whose every call traps.
const BROKEN: u32 = 2;
const TRAP: u32 = 0x0900;

struct Kind {
    kind: u32,
    inputs: u32,
    state_bytes: u32,
    needs_skeleton: bool,
    defaults: Vec<u32>,
}

struct Host {
    kinds: Vec<Kind>,
    buffers: RefCell<CallBuffers>,
    faults: RefCell<Vec<Fault>>,
    calls: RefCell<u32>,
}

impl Host {
    /// Registers the module the way the core does: from its descriptor blob.
    fn new() -> Host {
        let ptr = myco_node_describe();
        // SAFETY: the export points at a static blob that starts with its header.
        let header = unsafe { std::slice::from_raw_parts(ptr, HEADER_BYTES) };
        let len = Descriptor::total_len(header).unwrap();
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        let d = Descriptor::parse(bytes).unwrap();
        let kinds = d
            .nodes()
            .map(|n| Kind {
                kind: n.kind,
                inputs: n.inputs as u32,
                state_bytes: n.state_bytes,
                needs_skeleton: n.needs_skeleton(),
                defaults: n
                    .params()
                    .checked()
                    .flat_map(|p| p.default[..p.kind.words()].to_vec())
                    .collect(),
            })
            .collect();
        let mut buffers = CallBuffers::default();
        buffers.reserve(4 * 3 * 16 * 10, 64);
        Host {
            kinds,
            buffers: RefCell::new(buffers),
            faults: RefCell::new(Vec::new()),
            calls: RefCell::new(0),
        }
    }
}

impl PluginHost for Host {
    fn node(&self, module: u32, kind: u32) -> Option<NodeInfo<'_>> {
        if module != SAMPLE && module != BROKEN {
            return None;
        }
        let k = self.kinds.iter().find(|k| k.kind == kind)?;
        Some(NodeInfo {
            inputs: k.inputs,
            state_bytes: k.state_bytes,
            needs_skeleton: k.needs_skeleton,
            defaults: &k.defaults,
        })
    }

    fn buffers(&self) -> &RefCell<CallBuffers> {
        &self.buffers
    }

    fn call(&self, c: Call<'_>) -> u32 {
        *self.calls.borrow_mut() += 1;
        if c.module == BROKEN {
            return TRAP;
        }
        // The module's own memory: the state at a 16-byte aligned address (the ABI's), copied in
        // and back out like the wasm host does.
        let mut state = [0u128; 64];
        let words = c.state.len();
        let bytes =
            unsafe { std::slice::from_raw_parts_mut(state.as_mut_ptr().cast::<u32>(), 256) };
        bytes[..words].copy_from_slice(c.state);
        let status = unsafe {
            myco_node_evaluate(
                c.kind,
                1,
                c.bones,
                if c.parents.is_empty() {
                    std::ptr::null()
                } else {
                    c.parents.as_ptr()
                },
                c.input.as_ptr(),
                c.output.as_mut_ptr(),
                c.params.as_ptr(),
                state.as_mut_ptr().cast::<u8>(),
                c.dt,
            )
        };
        if status == Status::Ok as u32 {
            c.state.copy_from_slice(&bytes[..words]);
        }
        status
    }

    fn fault(&self, f: Fault) {
        self.faults.borrow_mut().push(f);
    }
}

struct World {
    host: Option<Host>,
}

impl Assets for World {
    fn clip(&self, _: u32) -> Option<ClipRef<'_>> {
        None
    }
    fn mask(&self, _: u32) -> Option<&[F32x4]> {
        None
    }
    fn plugins(&self) -> Option<&dyn PluginHost> {
        self.host.as_ref().map(|h| h as &dyn PluginHost)
    }
}

struct NoEvents;
impl Events for NoEvents {
    fn push(&mut self, _: StateEvent) {}
}

// ---- Counting allocations ----

// Only the measuring thread counts (the other tests run in parallel).
std::thread_local! {
    static COUNTING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if COUNTING.with(|c| c.get()) {
            ALLOCS.fetch_add(1, Ordering::SeqCst);
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}
#[global_allocator]
static GLOBAL: Counting = Counting;

// ---- The skeleton and graphs ----

const BONES: usize = 6;

fn rest() -> Vec<AosTransform> {
    (0..BONES)
        .map(|i| {
            let a = 0.2 * i as f32;
            AosTransform::new(
                AosVec3::new(0.1 * i as f32, 0.5 + 0.05 * i as f32, -0.03 * i as f32),
                AosQuat::new(0.0, (0.5 * a).sin(), 0.0, (0.5 * a).cos()),
                AosVec3::new(1.0, 1.0, 1.0),
            )
        })
        .collect()
}

struct Skel {
    parents: Vec<u16>,
    rest: Vec<AosTransform>,
    rest_soa: Vec<SoaTransform>,
    identity: Vec<AosTransform>,
}

fn skel() -> Skel {
    let rest = rest();
    let mut rest_soa = vec![SoaTransform::identity(); soa_len(BONES)];
    pack_pose(&rest, &mut rest_soa);
    Skel {
        parents: (0..BONES as u16)
            .map(|i| if i == 0 { u16::MAX } else { i - 1 })
            .collect(),
        rest,
        rest_soa,
        identity: vec![AosTransform::identity(); BONES],
    }
}

/// A graph builder (the module string is string 0, bound to `module`).
struct G {
    g: AnimGraph,
}

impl G {
    fn new() -> G {
        G {
            g: AnimGraph {
                name: NONE,
                skeleton: NONE,
                strings: vec!["module".into(), "factor".into()],
                ..AnimGraph::default()
            },
        }
    }
    fn node(&mut self, fam: u8, kind: u16, inputs: &[u32], params: &[u32]) -> u32 {
        self.g.nodes.push(GraphNode {
            family: fam,
            kind,
            inputs_first: self.g.inputs.len() as u32,
            inputs_count: inputs.len() as u32,
            params_first: self.g.param_blocks.len() as u32,
            params_count: params.len() as u32,
            name: NONE,
        });
        self.g.inputs.extend_from_slice(inputs);
        self.g.param_blocks.extend_from_slice(params);
        self.g.nodes.len() as u32 - 1
    }
    fn rest(&mut self) -> u32 {
        self.node(
            family::SOURCES,
            anim_graph::sources::kind::REFERENCE_POSE,
            &[],
            &[],
        )
    }
    fn plugin(
        &mut self,
        kind: u32,
        state_bytes: u32,
        inputs: &[u32],
        block: &[u32],
        binds: &[(u32, u32, u32)],
    ) -> u32 {
        let p = plugin_node_params(0, kind, state_bytes, block, binds);
        self.node(family::PLUGIN, plugin::kind::PLUGIN_NODE, inputs, &p)
    }
    fn program(mut self, output: u32) -> Program {
        self.g.output = output;
        let bytes = self.g.write().unwrap();
        Program::from_view(&AnimGraphView::parse(&bytes).unwrap()).unwrap()
    }
}

struct Run {
    program: Program,
    world: World,
    skel: Skel,
    bindings: Vec<u32>,
    state: Vec<u32>,
    poses: Vec<SoaTransform>,
    sample: Vec<AosTransform>,
    inertializer: Inertializer,
    out: Vec<SoaTransform>,
}

impl Run {
    fn new(program: Program, module: u32, host: bool) -> Run {
        let skel = skel();
        let groups = soa_len(BONES);
        let mut r = Run {
            state: vec![0; program.state_words(groups)],
            poses: vec![SoaTransform::identity(); program.pose_slots() * groups],
            program,
            world: World {
                host: host.then(Host::new),
            },
            skel,
            bindings: vec![module, 0],
            sample: vec![AosTransform::identity(); 2 * BONES],
            inertializer: Inertializer::new(BONES),
            out: vec![SoaTransform::identity(); groups],
        };
        let Run {
            program,
            world,
            skel,
            bindings,
            state,
            ..
        } = &mut r;
        program.init_state(&inputs(world, skel, bindings), state);
        r
    }

    /// One frame: update, then pose; returns the output pose (AoS).
    fn frame(&mut self, dt: f32) -> Vec<AosTransform> {
        let Run {
            program,
            world,
            skel,
            bindings,
            state,
            poses,
            sample,
            inertializer,
            out,
        } = self;
        let i = inputs(world, skel, bindings);
        program.update(&i, state, dt, &mut NoEvents);
        let scratch = Scratch {
            poses,
            sample,
            inertializer,
        };
        program.pose(&i, state, scratch, out);
        let mut aos = vec![AosTransform::identity(); BONES];
        anim_math::layout::unpack_pose(out, &mut aos);
        aos
    }

    fn faults(&self) -> Vec<Fault> {
        self.world
            .host
            .as_ref()
            .map_or(Vec::new(), |h| h.faults.borrow().clone())
    }

    fn node_state(&mut self, node: u32) -> Vec<u32> {
        self.program
            .node_state(&mut self.state, soa_len(BONES), node)
            .to_vec()
    }
}

fn inputs<'a>(world: &'a World, skel: &'a Skel, bindings: &'a [u32]) -> Inputs<'a> {
    Inputs {
        assets: world,
        skeleton: SkeletonPose {
            parents: &skel.parents,
            rest: &skel.rest,
            rest_soa: &skel.rest_soa,
            identity: &skel.identity,
            bind_soa: &[],
        },
        bindings,
        layer_weights: &[],
        history: None,
        bake_root: false,
    }
}

fn bits(p: &[AosTransform]) -> Vec<u32> {
    p.iter()
        .flat_map(|t| {
            [
                t.translation.x,
                t.translation.y,
                t.translation.z,
                t.rotation.x,
                t.rotation.y,
                t.rotation.z,
                t.rotation.w,
                t.scale.x,
                t.scale.y,
                t.scale.z,
            ]
        })
        .map(f32::to_bits)
        .collect()
}

fn scaled(rest: &[AosTransform], f: f32) -> Vec<AosTransform> {
    rest.iter()
        .map(|t| {
            AosTransform::new(
                AosVec3::new(
                    t.translation.x * f,
                    t.translation.y * f,
                    t.translation.z * f,
                ),
                t.rotation,
                t.scale,
            )
        })
        .collect()
}

#[test]
fn the_sample_scale_node_runs_through_the_sdk() {
    let mut g = G::new();
    let r = g.rest();
    let s = g.plugin(Scale::KIND, 0, &[r], &[2.0f32.to_bits()], &[]);
    let mut run = Run::new(g.program(s), SAMPLE, true);
    let pose = run.frame(1.0 / 30.0);
    assert_eq!(
        bits(&pose),
        bits(&scaled(&skel().rest, 2.0)),
        "SoA → AoS → module → SoA, exact"
    );
    assert!(run.faults().is_empty());
    assert_eq!(fault_state(&run.node_state(s)), (0, 0));
}

#[test]
fn missing_block_words_take_the_defaults_and_bindings_drive_parameters() {
    // No block words: the descriptor's default factor (1) passes the pose through.
    let mut g = G::new();
    let r = g.rest();
    let s = g.plugin(Scale::KIND, 0, &[r], &[], &[]);
    let mut run = Run::new(g.program(s), SAMPLE, true);
    assert_eq!(bits(&run.frame(0.1)), bits(&skel().rest));

    // A graph parameter bound to the factor's word.
    let mut g = G::new();
    g.g.params.push(Param {
        name: 1,
        flags: 0,
        default: ParamValue::Float(3.0),
    });
    let r = g.rest();
    let s = g.plugin(Scale::KIND, 0, &[r], &[2.0f32.to_bits()], &[(0, 1, 0)]);
    let mut run = Run::new(g.program(s), SAMPLE, true);
    assert_eq!(bits(&run.frame(0.1)), bits(&scaled(&skel().rest, 3.0)));
    run.program.param_state(&mut run.state, 0)[0] = 0.5f32.to_bits();
    assert_eq!(bits(&run.frame(0.1)), bits(&scaled(&skel().rest, 0.5)));
}

#[test]
fn nested_plugin_nodes_and_two_inputs() {
    // scale(2) of sum(scale(2) of rest, rest) = 6 × rest translations.
    let mut g = G::new();
    let r = g.rest();
    let inner = g.plugin(Scale::KIND, 0, &[r], &[2.0f32.to_bits()], &[]);
    let sum = g.plugin(Sum::KIND, 0, &[inner, r], &[], &[]);
    let outer = g.plugin(Scale::KIND, 0, &[sum], &[2.0f32.to_bits()], &[]);
    let mut run = Run::new(g.program(outer), SAMPLE, true);
    let pose = run.frame(0.1);
    let rest = skel().rest;
    for (p, t) in pose.iter().zip(&rest) {
        let want = (t.translation.x * 2.0 + t.translation.x) * 2.0;
        assert_eq!(p.translation.x.to_bits(), want.to_bits());
        assert_eq!(p.rotation.y.to_bits(), t.rotation.y.to_bits());
    }
    assert_eq!(*run.world.host.as_ref().unwrap().calls.borrow(), 3);
}

#[test]
fn a_fault_passes_input_0_through_keeps_state_and_reports_once() {
    let mut g = G::new();
    let r = g.rest();
    let c = g.plugin(Counter::KIND, 8, &[r], &[], &[]);
    let mut run = Run::new(g.program(c), BROKEN, true);
    for _ in 0..3 {
        let pose = run.frame(0.1);
        assert_eq!(bits(&pose), bits(&skel().rest), "input 0 passes through");
    }
    assert_eq!(
        run.faults(),
        vec![Fault {
            node: c,
            module: BROKEN,
            kind: Counter::KIND,
            status: TRAP
        }],
        "one report per node instance"
    );
    let s = run.node_state(c);
    assert_eq!(fault_state(&s), (plugin::FAULTED | plugin::REPORTED, TRAP));
    assert!(
        s[plugin::state::FIXED..].iter().all(|w| *w == 0),
        "the state is kept"
    );
    assert_eq!(
        *run.world.host.as_ref().unwrap().calls.borrow(),
        3,
        "it tries again each frame"
    );
}

#[test]
fn core_side_faults() {
    // No host at all.
    let mut g = G::new();
    let r = g.rest();
    let s = g.plugin(Scale::KIND, 0, &[r], &[2.0f32.to_bits()], &[]);
    let mut run = Run::new(g.program(s), SAMPLE, false);
    assert_eq!(bits(&run.frame(0.1)), bits(&skel().rest));
    assert_eq!(fault_state(&run.node_state(s)).1, fault::NO_HOST);

    // An unknown module (an unbound string id resolves to 0).
    let mut g = G::new();
    let r = g.rest();
    let s = g.plugin(Scale::KIND, 0, &[r], &[], &[]);
    let mut run = Run::new(g.program(s), 0, true);
    assert_eq!(bits(&run.frame(0.1)), bits(&skel().rest));
    assert_eq!(run.faults()[0].status, fault::NO_MODULE);

    // A graph compiled against another state size.
    let mut g = G::new();
    let r = g.rest();
    let c = g.plugin(Counter::KIND, 4, &[r], &[], &[]);
    let mut run = Run::new(g.program(c), SAMPLE, true);
    run.frame(0.1);
    assert_eq!(run.faults()[0].status, fault::MISMATCH);

    // Too few inputs for the kind.
    let mut g = G::new();
    let r = g.rest();
    let s = g.plugin(Sum::KIND, 0, &[r], &[], &[]);
    let mut run = Run::new(g.program(s), SAMPLE, true);
    assert_eq!(bits(&run.frame(0.1)), bits(&skel().rest));
    assert_eq!(run.faults()[0].status, fault::MISMATCH);
}

#[test]
fn state_lives_in_the_blob_and_restores_exactly() {
    let mut g = G::new();
    let r = g.rest();
    let c = g.plugin(Counter::KIND, 8, &[r], &[], &[]);
    let program = g.program(c);
    let mut run = Run::new(program, SAMPLE, true);
    for _ in 0..10 {
        run.frame(1.0 / 60.0);
    }
    let s = run.node_state(c);
    let words = &s[plugin::state::FIXED..];
    assert_eq!(words.len(), state_stride(8) / 4);
    assert_eq!(
        f32::from_bits(words[1]),
        10.0,
        "ten successful calls counted in the core's state"
    );
    let snapshot = run.state.clone();
    let after: Vec<Vec<u32>> = (0..5).map(|_| bits(&run.frame(1.0 / 60.0))).collect();
    run.state.copy_from_slice(&snapshot);
    let again: Vec<Vec<u32>> = (0..5).map(|_| bits(&run.frame(1.0 / 60.0))).collect();
    assert_eq!(after, again);
}

#[test]
fn frames_never_allocate() {
    let mut g = G::new();
    let r = g.rest();
    let inner = g.plugin(Scale::KIND, 0, &[r], &[2.0f32.to_bits()], &[]);
    let sum = g.plugin(Sum::KIND, 0, &[inner, r], &[], &[]);
    let c = g.plugin(Counter::KIND, 8, &[sum], &[], &[]);
    let mut run = Run::new(g.program(c), SAMPLE, true);
    run.frame(0.1);
    let Run {
        program,
        world,
        skel,
        bindings,
        state,
        poses,
        sample,
        inertializer,
        out,
    } = &mut run;
    COUNTING.with(|c| c.set(true));
    for _ in 0..20 {
        let i = inputs(world, skel, bindings);
        program.update(&i, state, 0.1, &mut NoEvents);
        let scratch = Scratch {
            poses,
            sample,
            inertializer,
        };
        program.pose(&i, state, scratch, out);
    }
    COUNTING.with(|c| c.set(false));
    assert_eq!(ALLOCS.load(Ordering::SeqCst), 0);
}
