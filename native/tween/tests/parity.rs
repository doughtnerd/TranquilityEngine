//! The standalone module against the animation core (ADR 0424: "results are identical either
//! way"): the same scripts of tweens, sequences and controls run on both, through each one's own
//! calls (`anim_wasm::init::Core` natively, `myco_tween_wasm::Module`), and every frame's tween
//! rows, tween change records, sequence values, weights, change records and evaluated list must
//! match bit for bit, as must every handle and status.

use anim_wasm::init::Core;
use anim_wire::core::{Init, PASS_FIXED, PASS_NORMAL, STATUS_OK};
use anim_wire::timeline::{
    SeqCreate, SeqMember, TimelineBlock, TimelineControl, TimelineInfo, FLAG_PLAY,
    OP_KILL as T_KILL, OP_PAUSE as T_PAUSE, OP_PLAY as T_PLAY, OP_SEEK, OP_SET_SPEED, OP_STOP,
    WRAP_HOLD, WRAP_LOOP, WRAP_ONCE, WRAP_PINGPONG,
};
use anim_wire::tween::*;
use anim_wire::WireRecord;
use myco_tween_wasm::Module;

/// The calls a script uses, on either module.
trait Host {
    fn load_curve(&mut self, keys: &[f32]) -> u32;
    fn tween_create(&mut self, record: &[u8]) -> u32;
    fn tween_control(&mut self, record: &[u8]) -> u32;
    fn seq_create(&mut self, bytes: &[u8]) -> u32;
    fn seq_control(&mut self, record: &[u8]) -> u32;
    fn last_status(&self) -> u32;
    /// A frame: clear the outputs, then the fixed and the normal pass of world 0.
    fn frame(&mut self, dt_scaled: f32, dt_unscaled: f32);
    fn rows(&self) -> Vec<(u32, [u32; 4])>;
    fn tween_changes(&self) -> Vec<u8>;
    fn seq_info(&self, h: u32) -> Option<TimelineInfo>;
    fn seq_blocks(&self, h: u32) -> Vec<TimelineBlock>;
    fn seq_values(&self) -> &[u32];
    fn seq_weights(&self) -> &[f32];
    fn seq_changes(&self) -> Vec<u8>;
    fn seq_active(&self) -> Vec<u32>;
}

fn rows_of(t: &myco_tween::Tweens) -> Vec<(u32, [u32; 4])> {
    (0..t.rows())
        .map(|i| {
            let v = &t.values()[i * 4..i * 4 + 4];
            (
                t.columns()[i],
                [
                    v[0].to_bits(),
                    v[1].to_bits(),
                    v[2].to_bits(),
                    v[3].to_bits(),
                ],
            )
        })
        .collect()
}

fn blocks_of(bytes: &[u8]) -> Vec<TimelineBlock> {
    bytes
        .as_chunks::<{ TimelineBlock::STRIDE as usize }>()
        .0
        .iter()
        .map(|b| TimelineBlock::decode(b).unwrap())
        .collect()
}

impl Host for Core {
    fn load_curve(&mut self, keys: &[f32]) -> u32 {
        Core::load_curve(self, keys)
    }
    fn tween_create(&mut self, record: &[u8]) -> u32 {
        Core::tween_create(self, record)
    }
    fn tween_control(&mut self, record: &[u8]) -> u32 {
        Core::tween_control(self, record)
    }
    fn seq_create(&mut self, bytes: &[u8]) -> u32 {
        self.timeline_create_sequence(bytes)
    }
    fn seq_control(&mut self, record: &[u8]) -> u32 {
        self.timeline_control(record)
    }
    fn last_status(&self) -> u32 {
        Core::last_status(self)
    }
    fn frame(&mut self, dt_scaled: f32, dt_unscaled: f32) {
        self.write_inputs(0);
        self.evaluate(0, PASS_FIXED, dt_scaled, dt_unscaled);
        self.evaluate(0, PASS_NORMAL, dt_scaled, dt_unscaled);
    }
    fn rows(&self) -> Vec<(u32, [u32; 4])> {
        rows_of(self.tweens())
    }
    fn tween_changes(&self) -> Vec<u8> {
        let t = self.tweens();
        t.changes()[..t.change_count() * TweenChange::STRIDE as usize].to_vec()
    }
    fn seq_info(&self, h: u32) -> Option<TimelineInfo> {
        self.timelines().info(h)
    }
    fn seq_blocks(&self, h: u32) -> Vec<TimelineBlock> {
        let mut out = vec![0u8; self.timeline_block_bytes(h) as usize];
        self.timeline_blocks(h, &mut out);
        blocks_of(&out)
    }
    fn seq_values(&self) -> &[u32] {
        self.timelines().values()
    }
    fn seq_weights(&self) -> &[f32] {
        self.timelines().weights()
    }
    fn seq_changes(&self) -> Vec<u8> {
        let t = self.timelines();
        t.changes()[..t.change_count() * anim_wire::timeline::TimelineChange::STRIDE as usize]
            .to_vec()
    }
    fn seq_active(&self) -> Vec<u32> {
        let t = self.timelines();
        t.active()[..t.active_count()].to_vec()
    }
}

impl Host for Module {
    fn load_curve(&mut self, keys: &[f32]) -> u32 {
        Module::load_curve(self, keys)
    }
    fn tween_create(&mut self, record: &[u8]) -> u32 {
        self.create(record)
    }
    fn tween_control(&mut self, record: &[u8]) -> u32 {
        self.control(record)
    }
    fn seq_create(&mut self, bytes: &[u8]) -> u32 {
        self.create_sequence(bytes)
    }
    fn seq_control(&mut self, record: &[u8]) -> u32 {
        self.control_sequence(record)
    }
    fn last_status(&self) -> u32 {
        Module::last_status(self)
    }
    fn frame(&mut self, dt_scaled: f32, dt_unscaled: f32) {
        self.begin_frame();
        self.update(0, PASS_FIXED, dt_scaled, dt_unscaled);
        self.update(0, PASS_NORMAL, dt_scaled, dt_unscaled);
    }
    fn rows(&self) -> Vec<(u32, [u32; 4])> {
        rows_of(self.tweens())
    }
    fn tween_changes(&self) -> Vec<u8> {
        let t = self.tweens();
        t.changes()[..t.change_count() * TweenChange::STRIDE as usize].to_vec()
    }
    fn seq_info(&self, h: u32) -> Option<TimelineInfo> {
        self.sequences().info(h)
    }
    fn seq_blocks(&self, h: u32) -> Vec<TimelineBlock> {
        let mut out = vec![0u8; self.sequences().block_bytes(h)];
        self.sequences().write_blocks(h, &mut out);
        blocks_of(&out)
    }
    fn seq_values(&self) -> &[u32] {
        self.sequences().values()
    }
    fn seq_weights(&self) -> &[f32] {
        self.sequences().weights()
    }
    fn seq_changes(&self) -> Vec<u8> {
        let s = self.sequences();
        s.changes()[..s.change_count() * anim_wire::timeline::TimelineChange::STRIDE as usize]
            .to_vec()
    }
    fn seq_active(&self) -> Vec<u32> {
        let s = self.sequences();
        s.active()[..s.active_count()].to_vec()
    }
}

fn core() -> Core {
    let mut core = Core::new();
    let reply = core.init(
        &Init {
            max_instances: 4,
            max_bones: 16,
            arena_initial_bytes: 1 << 20,
        }
        .encode(),
    );
    assert_eq!(reply.status, STATUS_OK);
    core
}

fn module() -> Module {
    let mut m = Module::default();
    assert_eq!(m.configure(DEFAULT_MAX_TWEENS), STATUS_OK);
    assert_eq!(
        m.configure_sequences(anim_wire::timeline::DEFAULT_MAX_TIMELINES),
        STATUS_OK
    );
    m
}

/// One step of a script. Curves, tweens and sequences are named by the order they were made.
#[derive(Clone)]
enum Op {
    Curve(Vec<f32>),
    /// A tween; `curve` replaces its `ease` with that curve's handle.
    Tween(TweenCreate, Option<usize>),
    TweenControl(usize, u32),
    /// A sequence head and its members (each with an optional curve, as for tweens).
    Seq(SeqCreate, Vec<(SeqMember, Option<usize>)>),
    SeqControl(usize, u32, f32),
    Frame(f32, f32),
}

/// What a script produced: every handle, status and frame output, in order.
#[derive(Debug, PartialEq)]
enum Out {
    Handle(u32, u32),
    Status(u32),
    Seq(Option<TimelineInfo>, Vec<TimelineBlock>),
    Frame {
        rows: Vec<(u32, [u32; 4])>,
        tween_changes: Vec<u8>,
        /// Each sequence's value words and weights, while it is live.
        seqs: Vec<Option<(Vec<u32>, Vec<u32>)>>,
        seq_changes: Vec<u8>,
        active: Vec<u32>,
    },
}

fn run<H: Host>(host: &mut H, script: &[Op]) -> Vec<Out> {
    let mut curves = Vec::new();
    let mut tweens = Vec::new();
    let mut seqs = Vec::new();
    let mut out = Vec::new();
    for op in script {
        match op {
            Op::Curve(keys) => {
                let h = host.load_curve(keys);
                assert_ne!(h, 0);
                curves.push(h);
            }
            Op::Tween(c, curve) => {
                let mut c = *c;
                if let Some(i) = curve {
                    c.ease = curves[*i];
                }
                let h = host.tween_create(&c.encode());
                out.push(Out::Handle(h, host.last_status()));
                tweens.push(h);
            }
            Op::TweenControl(i, op) => {
                let s = host.tween_control(
                    &TweenControl {
                        handle: tweens[*i],
                        op: *op,
                    }
                    .encode(),
                );
                out.push(Out::Status(s));
            }
            Op::Seq(head, members) => {
                let mut bytes = SeqCreate {
                    members: members.len() as u32,
                    ..*head
                }
                .encode();
                for (m, curve) in members {
                    let mut m = *m;
                    if let Some(i) = curve {
                        m.ease = curves[*i];
                    }
                    bytes.extend(m.encode());
                }
                let h = host.seq_create(&bytes);
                out.push(Out::Handle(h, host.last_status()));
                out.push(Out::Seq(host.seq_info(h), host.seq_blocks(h)));
                seqs.push(h);
            }
            Op::SeqControl(i, op, value) => {
                let s = host.seq_control(
                    &TimelineControl {
                        handle: seqs[*i],
                        op: *op,
                        value: *value,
                    }
                    .encode(),
                );
                out.push(Out::Status(s));
            }
            Op::Frame(ds, du) => {
                host.frame(*ds, *du);
                let seq_out = seqs
                    .iter()
                    .map(|&h| {
                        host.seq_info(h).map(|info| {
                            let v0 = info.value_offset as usize;
                            let w0 = info.weight_offset as usize;
                            let values =
                                host.seq_values()[v0..v0 + info.value_words as usize].to_vec();
                            let weights = host.seq_weights()[w0..w0 + info.blocks as usize]
                                .iter()
                                .map(|w| w.to_bits())
                                .collect();
                            (values, weights)
                        })
                    })
                    .collect();
                out.push(Out::Frame {
                    rows: host.rows(),
                    tween_changes: host.tween_changes(),
                    seqs: seq_out,
                    seq_changes: host.seq_changes(),
                    active: host.seq_active(),
                });
            }
        }
    }
    out
}

/// Runs `script` on both and compares; returns the core's output (for sanity checks).
fn same(script: &[Op]) -> Vec<Out> {
    let a = run(&mut core(), script);
    let b = run(&mut module(), script);
    assert_eq!(a.len(), b.len());
    for (i, (x, y)) in a.iter().zip(&b).enumerate() {
        assert_eq!(x, y, "step {i} differs (core left, standalone right)");
    }
    a
}

fn tween(host_id: u32, ease: u32) -> TweenCreate {
    TweenCreate {
        world: 0,
        host_id,
        column: host_id,
        value_kind: KIND_VALUE,
        width: 1,
        ease,
        time_mode: TIME_SCALED,
        loops: 1,
        duration: 1.0,
        speed: 1.0,
        from0: 0.0,
        to0: 8.0,
        ..TweenCreate::default()
    }
}

fn member(host_id: u32, offset: f32, ease: u32) -> SeqMember {
    SeqMember {
        host_id,
        column: host_id,
        value_kind: KIND_VALUE,
        width: 1,
        ease,
        loops: 1,
        offset,
        duration: 0.5,
        from0: 1.0,
        to0: 3.0,
        ..SeqMember::default()
    }
}

fn head(host_id: u32, wrap: u32, speed: f32) -> SeqCreate {
    SeqCreate {
        world: 0,
        host_id,
        time_mode: TIME_SCALED,
        wrap,
        flags: FLAG_PLAY,
        speed,
        members: 0,
    }
}

/// Uneven frame times, scaled and unscaled apart.
fn frames(n: usize) -> Vec<Op> {
    (0..n)
        .map(|i| Op::Frame(0.05 + 0.031 * (i % 5) as f32, 0.07 + 0.013 * (i % 3) as f32))
        .collect()
}

/// A Bézier curve over 0..1 that overshoots.
fn bezier() -> Vec<f32> {
    vec![
        0.0, 0.0, 5.0, 0.0, 0.0, 0.4, 1.6, //
        1.0, 1.0, 5.0, -0.3, 0.0, 0.0, 0.0,
    ]
}

#[test]
fn tweens_match_the_core() {
    let mut script = vec![Op::Curve(bezier())];
    script.push(Op::Tween(tween(1, EASE_LINEAR), None));
    script.push(Op::Tween(tween(2, EASE_OUT_QUAD), None));
    script.push(Op::Tween(
        TweenCreate {
            loops: 3,
            flags: FLAG_YOYO,
            delay: 0.2,
            ..tween(3, EASE_IN_OUT_ELASTIC)
        },
        None,
    ));
    script.push(Op::Tween(
        TweenCreate {
            time_mode: TIME_UNSCALED,
            loops: LOOPS_INFINITE,
            ..tween(4, EASE_OUT_BOUNCE)
        },
        None,
    ));
    script.push(Op::Tween(
        TweenCreate {
            time_mode: TIME_FIXED,
            speed: 1.5,
            ..tween(5, EASE_IN_BACK)
        },
        None,
    ));
    script.push(Op::Tween(
        TweenCreate {
            value_kind: KIND_QUAT_SLERP,
            width: 4,
            from3: 1.0,
            to0: 0.0,
            to1: 0.70710677,
            to2: 0.0,
            to3: 0.70710677,
            ..tween(6, EASE_LINEAR)
        },
        None,
    ));
    script.push(Op::Tween(
        TweenCreate {
            width: 3,
            flags: FLAG_RELATIVE,
            from1: 2.0,
            to1: -1.0,
            to2: 4.0,
            ..tween(7, EASE_LINEAR)
        },
        None,
    ));
    script.push(Op::Tween(tween(8, 0), Some(0)));
    script.extend(frames(6));
    script.push(Op::TweenControl(1, OP_PAUSE));
    script.extend(frames(3));
    script.push(Op::TweenControl(1, OP_RESUME));
    script.push(Op::TweenControl(3, OP_KILL));
    script.push(Op::TweenControl(2, OP_DESTROYED));
    script.extend(frames(30));
    script.push(Op::TweenControl(3, OP_KILL)); // stale now
    let out = same(&script);
    assert!(matches!(out.last(), Some(Out::Status(s)) if *s != STATUS_OK));
}

#[test]
fn sequences_match_the_core_in_every_wrap_mode() {
    for wrap in [WRAP_ONCE, WRAP_HOLD, WRAP_LOOP, WRAP_PINGPONG] {
        let mut script = vec![Op::Curve(bezier())];
        // sequence(a, parallel(b, c), d): b and c start together after a.
        script.push(Op::Seq(
            head(10, wrap, 1.0),
            vec![
                (member(11, 0.0, EASE_LINEAR), None),
                (member(12, 0.5, EASE_OUT_QUAD), None),
                (
                    SeqMember {
                        loops: 2,
                        flags: FLAG_YOYO,
                        ..member(13, 0.5, 0)
                    },
                    Some(0),
                ),
                (
                    SeqMember {
                        width: 3,
                        to1: 5.0,
                        to2: -2.0,
                        delay: 0.1,
                        ..member(14, 1.5, EASE_IN_OUT_ELASTIC)
                    },
                    None,
                ),
            ],
        ));
        script.extend(frames(40));
        same(&script);
    }
}

#[test]
fn sequence_controls_match_the_core() {
    let members = || {
        vec![
            (member(21, 0.0, EASE_LINEAR), None),
            (member(22, 0.5, EASE_OUT_QUAD), None),
        ]
    };
    let mut script = vec![
        Op::Seq(head(20, WRAP_ONCE, 1.0), members()),
        Op::Seq(head(30, WRAP_LOOP, -1.0), members()),
        Op::Seq(
            SeqCreate {
                flags: 0,
                time_mode: TIME_UNSCALED,
                ..head(40, WRAP_PINGPONG, 2.0)
            },
            members(),
        ),
    ];
    script.extend(frames(3));
    script.push(Op::SeqControl(0, T_PAUSE, 0.0));
    script.push(Op::SeqControl(2, T_PLAY, 0.0));
    script.extend(frames(3));
    script.push(Op::SeqControl(0, OP_SEEK, 0.75));
    script.push(Op::SeqControl(1, OP_SET_SPEED, 3.0));
    script.extend(frames(2));
    script.push(Op::SeqControl(0, T_PLAY, 0.0));
    script.push(Op::SeqControl(1, OP_SEEK, -0.3));
    script.extend(frames(4));
    script.push(Op::SeqControl(2, OP_STOP, 0.0));
    script.extend(frames(2));
    script.push(Op::SeqControl(2, T_PLAY, 0.0));
    script.extend(frames(12));
    script.push(Op::SeqControl(1, T_KILL, 0.0));
    script.push(Op::SeqControl(2, anim_wire::timeline::OP_DESTROYED, 0.0));
    script.extend(frames(2));
    // Handles retired above are stale; new sequences reuse their slots.
    script.push(Op::SeqControl(1, T_PAUSE, 0.0));
    script.push(Op::Seq(head(50, WRAP_HOLD, 1.0), members()));
    script.extend(frames(20));
    same(&script);
}

#[test]
fn endless_members_and_refusals_match_the_core() {
    let mut script = vec![Op::Seq(
        head(60, WRAP_LOOP, 1.0),
        vec![
            (
                SeqMember {
                    loops: LOOPS_INFINITE,
                    ..member(61, 0.25, EASE_LINEAR)
                },
                None,
            ),
            (member(62, 0.0, EASE_LINEAR), None),
        ],
    )];
    // A member that can't be read (width 0) refuses the whole sequence.
    script.push(Op::Seq(
        head(70, WRAP_ONCE, 1.0),
        vec![(
            SeqMember {
                width: 0,
                ..member(71, 0.0, EASE_LINEAR)
            },
            None,
        )],
    ));
    script.extend(frames(10));
    same(&script);
}
