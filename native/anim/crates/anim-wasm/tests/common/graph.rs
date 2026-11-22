//! Graph test helpers (T31): raw clips with chosen root speeds, markers, events and curves; a
//! `myco.animgraph@1` builder; `graph` and `debug` family records through the core.
#![allow(dead_code)]

use anim_format::clip::{Binding, Clip, Key, KeyData, MarkerKind, Track, TrackKind, CLIP_LOOP};
use anim_format::graph::{
    AnimGraph, Chooser, ChooserRow, CondNode, CondProgram, How, Interrupt, LinkedGraph, Machine,
    Node, Param, ParamValue, Slot, State, Transition, When,
};
use anim_format::skeleton::Skeleton;
use anim_format::NONE;
use anim_wasm::init::Core;
use anim_wire::debug::{DebugHeader, DebugMachine, DebugNode, DebugRequest, DebugTransition};
use anim_wire::graph as wg;
use anim_wire::WireRecord;

/// What a raw test clip holds.
#[derive(Clone, Debug)]
pub struct ClipSpec {
    pub seconds: f64,
    pub looping: bool,
    /// Root speed along +z, metres per second (also its root curve).
    pub speed: f64,
    pub seed: u64,
    /// Sync markers: (name, time).
    pub sync: Vec<(&'static str, f32)>,
    /// Exit markers' times.
    pub exits: Vec<f32>,
    /// Notifies: (time, threshold); method string `"step"`.
    pub events: Vec<(f32, f32)>,
    /// A curve track: (name, value at t = slope · t).
    pub curve: Option<(&'static str, f32)>,
}

impl ClipSpec {
    pub fn new(seconds: f64, looping: bool, seed: u64) -> ClipSpec {
        ClipSpec {
            seconds,
            looping,
            speed: 1.0,
            seed,
            sync: Vec::new(),
            exits: Vec::new(),
            events: Vec::new(),
            curve: None,
        }
    }
}

/// A raw (uncompressed) clip over `skel` at 30 Hz: every bone swings about its own axis by a
/// seeded amplitude and phase over one cycle of the clip; bone 0 also moves along +z at `speed`,
/// and its root curve says so.
pub fn raw_clip(skel: &Skeleton, spec: &ClipSpec) -> Vec<u8> {
    let rate = 30.0f64;
    let frames = (spec.seconds * rate).round() as u32 + 1;
    let duration = (frames - 1) as f64 / rate;
    let mut s = spec.seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut rnd = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut tracks = Vec::new();
    for (i, b) in skel.bones.iter().enumerate() {
        let axis = {
            let (x, y, z) = (rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
            let l = (x * x + y * y + z * z).sqrt().max(1e-6);
            [x / l, y / l, z / l]
        };
        let amp = 0.2 + 0.6 * rnd();
        let phase = rnd() * std::f64::consts::TAU;
        let rq = b.rotation.map(|v| v as f64);
        let mut raw = Vec::with_capacity(frames as usize * 10);
        for f in 0..frames {
            let t = f as f64 / rate;
            let a = amp * (std::f64::consts::TAU * t / duration + phase).sin();
            let (sa, ca) = (0.5 * a).sin_cos();
            let d = [axis[0] * sa, axis[1] * sa, axis[2] * sa, ca];
            // rest * d
            let q = [
                rq[3] * d[0] + rq[0] * d[3] + rq[1] * d[2] - rq[2] * d[1],
                rq[3] * d[1] - rq[0] * d[2] + rq[1] * d[3] + rq[2] * d[0],
                rq[3] * d[2] + rq[0] * d[1] - rq[1] * d[0] + rq[2] * d[3],
                rq[3] * d[3] - rq[0] * d[0] - rq[1] * d[1] - rq[2] * d[2],
            ];
            let mut p = b.translation.map(|v| v as f64);
            if i == 0 {
                p[2] += spec.speed * t;
            }
            raw.extend_from_slice(&[
                p[0] as f32,
                p[1] as f32,
                p[2] as f32,
                q[0] as f32,
                q[1] as f32,
                q[2] as f32,
                q[3] as f32,
                1.0,
                1.0,
                1.0,
            ]);
        }
        tracks.push(Track {
            kind: TrackKind::Bone,
            flags: 0,
            subtype: 0,
            binding: Binding::bone(i as u32),
            raw,
            keys: Vec::new(),
        });
    }
    let mut strings: Vec<String> = vec!["step".into()];
    let mut intern = |name: &str| -> u32 {
        match strings.iter().position(|s| s == name) {
            Some(i) => i as u32,
            None => {
                strings.push(name.into());
                strings.len() as u32 - 1
            }
        }
    };
    let mut marker_keys: Vec<Key> = Vec::new();
    for &(name, t) in &spec.sync {
        marker_keys.push(Key {
            time: t,
            end: t,
            data: KeyData::Marker {
                kind: MarkerKind::Sync,
                name: intern(name),
            },
        });
    }
    for &t in &spec.exits {
        marker_keys.push(Key {
            time: t,
            end: t,
            data: KeyData::Marker {
                kind: MarkerKind::Exit,
                name: NONE,
            },
        });
    }
    marker_keys.sort_by(|a, b| a.time.total_cmp(&b.time));
    if !marker_keys.is_empty() {
        tracks.push(Track {
            kind: TrackKind::Marker,
            flags: 0,
            subtype: 0,
            binding: Binding::none(),
            raw: Vec::new(),
            keys: marker_keys,
        });
    }
    if !spec.events.is_empty() {
        tracks.push(Track {
            kind: TrackKind::Event,
            flags: 0,
            subtype: 0,
            binding: Binding::none(),
            raw: Vec::new(),
            keys: spec
                .events
                .iter()
                .map(|&(t, threshold)| Key {
                    time: t,
                    end: t,
                    data: KeyData::Event {
                        method: 0,
                        args: NONE,
                        threshold,
                        always: false,
                    },
                })
                .collect(),
        });
    }
    if let Some((name, slope)) = spec.curve {
        let field = intern(name);
        tracks.push(Track {
            kind: TrackKind::Curve,
            flags: 0,
            subtype: 0,
            binding: Binding {
                bone: NONE,
                node_path: NONE,
                component: NONE,
                field,
            },
            raw: (0..frames)
                .map(|f| slope * f as f32 / rate as f32)
                .collect(),
            keys: Vec::new(),
        });
    }
    let root_curve = (0..frames)
        .map(|f| [0.0, 0.0, (spec.speed * f as f64 / rate) as f32, 0.0])
        .collect();
    Clip {
        flags: if spec.looping { CLIP_LOOP } else { 0 },
        name: NONE,
        duration: duration as f32,
        sample_rate: rate as f32,
        frame_count: frames,
        bone_count: skel.bones.len() as u32,
        root_bone: 0,
        strings,
        tracks,
        has_raw: true,
        root_curve: Some(root_curve),
        compressed: None,
    }
    .write()
    .unwrap()
}

/// A transition (interrupt: never).
pub fn tr(target: u32, condition: u32, when: When, how: How) -> Transition {
    Transition {
        target,
        condition,
        when,
        how,
        interrupt: Interrupt::Never,
    }
}

/// The ids of a built machine.
#[derive(Clone, Debug)]
pub struct MachineIds {
    pub node: u32,
    pub index: u32,
    /// Global transition indices per state.
    pub trans: Vec<Vec<u32>>,
    pub any: Vec<u32>,
}

/// A `myco.animgraph@1` builder.
#[derive(Default)]
pub struct Builder {
    pub g: AnimGraph,
}

impl Builder {
    pub fn new() -> Builder {
        Builder {
            g: AnimGraph {
                name: NONE,
                skeleton: NONE,
                ..AnimGraph::default()
            },
        }
    }

    /// A string id (interned).
    pub fn s(&mut self, name: &str) -> u32 {
        match self.g.strings.iter().position(|s| s == name) {
            Some(i) => i as u32,
            None => {
                self.g.strings.push(name.into());
                self.g.strings.len() as u32 - 1
            }
        }
    }

    pub fn param(&mut self, name: &str, default: ParamValue) -> u32 {
        let name = self.s(name);
        self.g.params.push(Param {
            name,
            flags: 0,
            default,
        });
        self.g.params.len() as u32 - 1
    }

    pub fn node(&mut self, family: u8, kind: u16, inputs: &[u32], params: &[u32]) -> u32 {
        self.g.nodes.push(Node {
            family,
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

    /// A clip player of the clip bound to string `clip`.
    pub fn player(&mut self, clip: &str) -> u32 {
        self.player_with(clip, 1.0, 0)
    }

    pub fn player_with(&mut self, clip: &str, speed: f32, flags: u32) -> u32 {
        let id = self.s(clip);
        let p = anim_graph::sources::clip_player_params(id, speed, flags, 0.0, NONE);
        self.node(
            anim_format::graph::family::SOURCES,
            anim_graph::sources::kind::CLIP_PLAYER,
            &[],
            &p,
        )
    }

    /// A condition program from prefix-order nodes.
    pub fn cond(&mut self, nodes: &[CondNode]) -> u32 {
        let first = self.g.conditions.len() as u32;
        self.g.conditions.extend_from_slice(nodes);
        self.g.programs.push(CondProgram {
            first,
            count: nodes.len() as u32,
        });
        self.g.programs.len() as u32 - 1
    }

    /// An interrupt list.
    pub fn interrupts(&mut self, list: &[u32]) -> Interrupt {
        let first = self.g.interrupts.len() as u32;
        self.g.interrupts.extend_from_slice(list);
        Interrupt::List {
            first,
            count: list.len() as u32,
        }
    }

    /// A state machine: states (name, root, flags), the entry, each state's transitions in priority
    /// order, and the any-state transitions.
    pub fn machine(
        &mut self,
        states: &[(&str, u32, u32)],
        entry: u32,
        trans: &[Vec<Transition>],
        any: &[Transition],
    ) -> MachineIds {
        let node = self.node(
            anim_format::graph::family::LOGIC,
            anim_graph::logic::kind::STATE_MACHINE,
            &[],
            &[],
        );
        let any_first = self.g.transitions.len() as u32;
        self.g.transitions.extend_from_slice(any);
        let any_ids = (any_first..any_first + any.len() as u32).collect();
        let states_first = self.g.states.len() as u32;
        let mut ids = Vec::new();
        for (i, &(name, root, flags)) in states.iter().enumerate() {
            let name = self.s(name);
            let list = trans.get(i).cloned().unwrap_or_default();
            let first = self.g.transitions.len() as u32;
            ids.push((first..first + list.len() as u32).collect());
            self.g.transitions.extend_from_slice(&list);
            self.g.states.push(State {
                name,
                node: root,
                transitions_first: first,
                transitions_count: list.len() as u32,
                flags,
            });
        }
        self.g.machines.push(Machine {
            node,
            name: NONE,
            states_first,
            states_count: states.len() as u32,
            entry,
            any_first,
            any_count: any.len() as u32,
        });
        MachineIds {
            node,
            index: self.g.machines.len() as u32 - 1,
            trans: ids,
            any: any_ids,
        }
    }

    /// A slot over `source` (mask string or `NONE`, group or none): (node, slot index).
    pub fn slot(&mut self, name: &str, source: u32, mask: u32, group: Option<&str>) -> (u32, u32) {
        let node = self.node(
            anim_format::graph::family::SLOTS,
            anim_graph::slots::kind::SLOT,
            &[source],
            &[mask],
        );
        let name = self.s(name);
        let group = group.map_or(NONE, |g| self.s(g));
        self.g.slots.push(Slot { name, node, group });
        (node, self.g.slots.len() as u32 - 1)
    }

    /// A linked-graph slot with its capacities: (node, linked index).
    pub fn linked(&mut self, name: &str, default: Option<&str>, caps: [u32; 4]) -> (u32, u32) {
        let node = self.node(
            anim_format::graph::family::SLOTS,
            anim_graph::slots::kind::LINKED,
            &[],
            &caps,
        );
        let name = self.s(name);
        let default_graph = default.map_or(NONE, |g| self.s(g));
        self.g.linked.push(LinkedGraph {
            name,
            node,
            default_graph,
        });
        (node, self.g.linked.len() as u32 - 1)
    }

    /// A chooser: rows (condition program, result), fallback, flags, blend time.
    pub fn chooser(&mut self, rows: &[(u32, u32)], fallback: u32, flags: u32, blend: f32) -> u32 {
        let node = self.node(
            anim_format::graph::family::LOGIC,
            anim_graph::logic::kind::CHOOSER,
            &[],
            &[flags, blend.to_bits()],
        );
        let first = self.g.chooser_rows.len() as u32;
        for &(condition, n) in rows {
            self.g.chooser_rows.push(ChooserRow { condition, node: n });
        }
        self.g.choosers.push(Chooser {
            node,
            rows_first: first,
            rows_count: rows.len() as u32,
            fallback,
        });
        node
    }

    pub fn build(&mut self, output: u32) -> Vec<u8> {
        self.g.output = output;
        self.g.write().unwrap()
    }
}

/// Loads `graph`, binds its clip names to handles, creates an instance.
pub fn instance(core: &mut Core, graph: &[u8], skel: u32, binds: &[(u32, u32)]) -> (u32, u32) {
    let g = core.load_graph(graph);
    assert_ne!(g, 0, "graph loads (status {})", core.last_status());
    for &(id, asset) in binds {
        assert_eq!(core.graph_bind(g, id, asset), 0);
    }
    let h = core.create_instance(0, skel, g);
    assert_ne!(h, 0, "instance (status {})", core.last_status());
    (g, h)
}

/// One frame: `write_inputs(0)` then `evaluate`.
pub fn frame(core: &mut Core, dt: f32) -> u32 {
    core.write_inputs(0);
    core.evaluate(0, anim_wire::core::PASS_NORMAL, dt, dt)
}

/// Sends commands, then evaluates one frame (without clearing the commands' change records).
pub fn command_frame(core: &mut Core, commands: &[Vec<u8>], dt: f32) -> u32 {
    let n = super::send(core, commands);
    core.evaluate(0, anim_wire::core::PASS_NORMAL, dt, dt);
    n
}

/// The graph state changes waiting.
// `unknown_lints`: the lint is newer than some stable clippy versions.
#[allow(unknown_lints, clippy::chunks_exact_to_as_chunks)]
pub fn graph_changes(core: &Core) -> Vec<wg::GraphChange> {
    core.graph_changes()
        .chunks_exact(wg::GraphChange::STRIDE as usize)
        .map(|c| wg::GraphChange::decode(c).unwrap())
        .collect()
}

pub fn set_float(instance: u32, param: u32, v: f32) -> Vec<u8> {
    wg::SetParam {
        instance,
        param,
        param_type: 0,
        w0: v.to_bits(),
        ..Default::default()
    }
    .encode()
}

pub fn set_int(instance: u32, param: u32, v: i32) -> Vec<u8> {
    wg::SetParam {
        instance,
        param,
        param_type: 1,
        w0: v as u32,
        ..Default::default()
    }
    .encode()
}

pub fn set_bool(instance: u32, param: u32, v: bool) -> Vec<u8> {
    wg::SetParam {
        instance,
        param,
        param_type: 2,
        w0: v as u32,
        ..Default::default()
    }
    .encode()
}

pub fn request(instance: u32, name: u32, lifetime: f32) -> Vec<u8> {
    wg::Request {
        instance,
        name,
        lifetime,
    }
    .encode()
}

pub fn travel(instance: u32, machine: u32, state: u32) -> Vec<u8> {
    wg::Travel {
        instance,
        machine,
        state,
    }
    .encode()
}

pub fn jump(instance: u32, machine: u32, state: u32) -> Vec<u8> {
    wg::Jump {
        instance,
        machine,
        state,
    }
    .encode()
}

pub fn debug_on(instance: u32) -> Vec<u8> {
    wg::Debug {
        instance,
        flags: wg::DEBUG_ON,
    }
    .encode()
}

pub fn seed(instance: u32, seed: u32) -> Vec<u8> {
    wg::SetSeed { instance, seed }.encode()
}

/// A parsed debug report.
#[derive(Debug, Default)]
pub struct Report {
    pub header: DebugHeader,
    pub nodes: Vec<DebugNode>,
    pub machines: Vec<DebugMachine>,
    pub transitions: Vec<DebugTransition>,
    pub requests: Vec<DebugRequest>,
}

impl Report {
    /// The effective weight of node `n` (0 when it isn't active).
    pub fn weight(&self, n: u32) -> f32 {
        self.nodes
            .iter()
            .find(|x| x.node == n)
            .map_or(0.0, |x| x.weight)
    }
    pub fn node(&self, n: u32) -> Option<DebugNode> {
        self.nodes.iter().find(|x| x.node == n).copied()
    }
}

/// Instance `h`'s debug report (it must be flagged).
pub fn report(core: &mut Core, h: u32) -> Report {
    let n = core.debug_write(h) as usize;
    let bytes = core.debug()[..n].to_vec();
    let mut r = Report::default();
    if n == 0 {
        return r;
    }
    r.header = DebugHeader::decode(&bytes).unwrap();
    let mut at = DebugHeader::STRIDE as usize;
    while at < n {
        let op = u16::from_le_bytes([bytes[at], bytes[at + 1]]);
        let b = &bytes[at..];
        let stride = match op {
            DebugNode::OPCODE => {
                r.nodes.push(DebugNode::decode(b).unwrap());
                DebugNode::STRIDE
            }
            DebugMachine::OPCODE => {
                r.machines.push(DebugMachine::decode(b).unwrap());
                DebugMachine::STRIDE
            }
            DebugTransition::OPCODE => {
                r.transitions.push(DebugTransition::decode(b).unwrap());
                DebugTransition::STRIDE
            }
            DebugRequest::OPCODE => {
                r.requests.push(DebugRequest::decode(b).unwrap());
                DebugRequest::STRIDE
            }
            other => panic!("unknown debug opcode {other:#x}"),
        };
        at += stride as usize;
    }
    r
}

/// Compare `p op v` on parameter `p` (float constant).
pub fn cmp_f(param: u32, op: anim_format::graph::CmpOp, v: f32) -> CondNode {
    CondNode::Compare {
        operand: anim_format::graph::Operand::Param(param),
        op,
        value: v.to_bits(),
    }
}

/// A request is live.
pub fn req(name: u32) -> CondNode {
    CondNode::Compare {
        operand: anim_format::graph::Operand::Request(name),
        op: anim_format::graph::CmpOp::Eq,
        value: 1,
    }
}

/// The ids of [`locomotion`]'s graph.
#[derive(Clone, Debug)]
pub struct Loco {
    pub x: u32,
    pub y: u32,
    pub speed: u32,
    pub moving: u32,
    pub jump: u32,
    pub machine: MachineIds,
    pub blend_space: u32,
    pub slot: u32,
    pub output: u32,
    /// String ids to bind: the idle, walk and run clips and the upper-body mask.
    pub idle: u32,
    pub walk: u32,
    pub run: u32,
    pub upper: u32,
}

/// The benchmark's graph (ADR 0340's budget scenario, without the rig): a state machine (Idle,
/// Locomotion: a 2D blend space of idle, walk and run with speed scaling and sync; Jump, entered on
/// a request through an any-state transition and left at its exit) under an upper-body slot, under
/// an inertialization node.
pub fn locomotion(b: &mut Builder) -> Loco {
    use anim_format::graph::{family, CmpOp, ParamValue};
    let x = b.param("x", ParamValue::Float(0.0));
    let y = b.param("y", ParamValue::Float(0.0));
    let speed = b.param("speed", ParamValue::Float(1.0));
    let moving = b.param("moving", ParamValue::Bool(false));
    let jump = b.s("Jump");
    let idle_p = b.player("idle");
    let walk_p = b.player("walk");
    let run_p = b.player("run");
    let idle2 = b.player("idle");
    let jump_p = b.player_with("run", 1.5, anim_graph::sources::PLAYER_LOOP_SET);
    let mut words = vec![
        x,
        y,
        speed,
        150.0f32.to_bits(),
        anim_graph::sources::BS_SYNC | anim_graph::sources::BS_SPEED,
        0.0f32.to_bits(),
        0.0f32.to_bits(),
    ];
    for c in [0.0f32, 0.0, 0.0, 1.0, 1.0, 1.0] {
        words.push(c.to_bits());
    }
    let bs = b.node(
        family::SOURCES,
        anim_graph::sources::kind::BLEND_SPACE_2D,
        &[idle2, walk_p, run_p],
        &words,
    );
    let on = b.cond(&[CondNode::Compare {
        operand: anim_format::graph::Operand::Param(moving),
        op: CmpOp::Eq,
        value: 1,
    }]);
    let off = b.cond(&[CondNode::Compare {
        operand: anim_format::graph::Operand::Param(moving),
        op: CmpOp::Eq,
        value: 0,
    }]);
    let jumped = b.cond(&[req(jump)]);
    let machine = b.machine(
        &[
            ("Idle", idle_p, 0),
            ("Locomotion", bs, 0),
            ("Jump", jump_p, 0),
        ],
        0,
        &[
            vec![tr(
                1,
                on,
                When::Now,
                How::Crossfade {
                    duration: 0.2,
                    shape: 1,
                },
            )],
            vec![tr(0, off, When::Now, How::Inertialize { duration: 0.25 })],
            vec![tr(
                1,
                NONE,
                When::Exit,
                How::Crossfade {
                    duration: 0.15,
                    shape: 0,
                },
            )],
        ],
        &[tr(2, jumped, When::Now, How::Inertialize { duration: 0.2 })],
    );
    let upper = b.s("upper");
    let (slot, _) = b.slot("UpperBody", machine.node, upper, None);
    let output = b.node(
        family::MIXING,
        anim_graph::mixing::kind::INERTIALIZE,
        &[slot],
        &[],
    );
    let idle = b.s("idle");
    let walk = b.s("walk");
    let run = b.s("run");
    Loco {
        x,
        y,
        speed,
        moving,
        jump,
        machine,
        blend_space: bs,
        slot,
        output,
        idle,
        walk,
        run,
        upper,
    }
}

/// A frame script for [`locomotion`] instances: the commands to send before frame `f` of a run.
pub fn loco_script(h: u32, ids: &Loco, f: usize, shot: u32) -> Vec<Vec<u8>> {
    match f {
        2 => vec![set_bool(h, ids.moving, true), set_float(h, ids.y, 0.6)],
        8 => vec![set_float(h, ids.x, 0.7), set_float(h, ids.speed, 2.5)],
        14 => vec![wg::SlotPlay {
            instance: h,
            slot: 0,
            clip: shot,
            play_id: 5,
            blend_in: 0.1,
            blend_out: 0.1,
            speed: 1.0,
            start: 0.0,
            end: 0.5,
            flags: 0,
        }
        .encode()],
        20 => vec![request(h, ids.jump, 0.2)],
        34 => vec![set_bool(h, ids.moving, false)],
        _ => Vec::new(),
    }
}
