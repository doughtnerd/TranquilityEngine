mod common;

use anim_format::graph::*;
use anim_format::{FormatError, NONE};
use common::*;

fn gen_value(rng: &mut Rng, ty: ParamType, n_strings: usize) -> ParamValue {
    let mut f = || rng.f32(-5.0, 5.0);
    match ty {
        ParamType::Float => ParamValue::Float(f()),
        ParamType::Int => ParamValue::Int(f() as i32 * 100),
        ParamType::Bool => ParamValue::Bool(f() > 0.0),
        ParamType::Vec2 => ParamValue::Vec2([f(), f()]),
        ParamType::Vec3 => ParamValue::Vec3([f(), f(), f()]),
        ParamType::Quat => ParamValue::Quat([0.0, 0.0, 0.0, 1.0]),
        ParamType::Node => ParamValue::Node(rng.opt_id(n_strings)),
    }
}

fn gen_compare(rng: &mut Rng, params: &[Param], n_strings: usize) -> CondNode {
    let comparable: Vec<u32> = (0..params.len() as u32)
        .filter(|&i| {
            matches!(
                params[i as usize].default.ty(),
                ParamType::Float | ParamType::Int | ParamType::Bool
            )
        })
        .collect();
    let float = |rng: &mut Rng| rng.f32(-2.0, 2.0).to_bits();
    let eq = |rng: &mut Rng| if rng.bool() { CmpOp::Eq } else { CmpOp::Ne };
    match rng.below(6) {
        0 if !comparable.is_empty() => {
            let i = rng.pick(&comparable);
            match params[i as usize].default.ty() {
                ParamType::Float => CondNode::Compare {
                    operand: Operand::Param(i),
                    op: rng.pick(CmpOp::ALL),
                    value: float(rng),
                },
                ParamType::Int => CondNode::Compare {
                    operand: Operand::Param(i),
                    op: rng.pick(CmpOp::ALL),
                    value: rng.next() as u32,
                },
                _ => CondNode::Compare {
                    operand: Operand::Param(i),
                    op: eq(rng),
                    value: rng.below(2),
                },
            }
        }
        1 => CondNode::Compare {
            operand: Operand::StateTime,
            op: rng.pick(CmpOp::ALL),
            value: float(rng),
        },
        2 => CondNode::Compare {
            operand: Operand::NormalizedTime,
            op: rng.pick(CmpOp::ALL),
            value: float(rng),
        },
        3 => CondNode::Compare {
            operand: Operand::SyncPhase,
            op: rng.pick(CmpOp::ALL),
            value: float(rng),
        },
        4 => CondNode::Compare {
            operand: Operand::Curve(rng.below(n_strings as u32)),
            op: rng.pick(CmpOp::ALL),
            value: float(rng),
        },
        _ => CondNode::Compare {
            operand: Operand::Request(rng.below(n_strings as u32)),
            op: eq(rng),
            value: rng.below(2),
        },
    }
}

fn gen_tree(
    rng: &mut Rng,
    depth: u32,
    params: &[Param],
    n_strings: usize,
    out: &mut Vec<CondNode>,
) {
    if depth < 3 && rng.below(3) == 0 {
        let k = rng.range(1, 3);
        out.push(if rng.bool() {
            CondNode::All(k)
        } else {
            CondNode::Any(k)
        });
        for _ in 0..k {
            gen_tree(rng, depth + 1, params, n_strings, out);
        }
    } else {
        out.push(gen_compare(rng, params, n_strings));
    }
}

fn gen_graph(rng: &mut Rng) -> AnimGraph {
    let strings = strings(rng, 2);
    let ns = strings.len();
    let mut g = AnimGraph {
        strings,
        name: NONE,
        skeleton: NONE,
        ..Default::default()
    };
    g.name = rng.opt_id(ns);
    g.skeleton = rng.opt_id(ns);
    for _ in 0..rng.range(0, 6) {
        let ty = rng.pick(ParamType::ALL);
        g.params.push(Param {
            name: rng.below(ns as u32),
            flags: rng.below(8) as u8,
            default: gen_value(rng, ty, ns),
        });
    }
    // Inputs only point to higher indices, so the dataflow is a DAG; node 0 is a logic node.
    let n = rng.range(2, 10);
    for i in 0..n {
        let first = g.inputs.len() as u32;
        for _ in 0..rng.range(0, 3) {
            if i + 1 < n {
                g.inputs.push(rng.range(i + 1, n - 1));
            }
        }
        let pfirst = g.param_blocks.len() as u32;
        let pcount = rng.range(0, 4);
        g.param_blocks
            .extend((0..pcount).map(|_| rng.next() as u32));
        g.nodes.push(Node {
            family: if i == 0 {
                family::LOGIC
            } else {
                rng.below(family::COUNT as u32) as u8
            },
            kind: rng.below(20) as u16,
            inputs_first: first,
            inputs_count: g.inputs.len() as u32 - first,
            params_first: pfirst,
            params_count: pcount,
            name: rng.opt_id(ns),
        });
    }
    g.output = rng.below(n);
    // Conditions.
    for _ in 0..rng.range(0, 4) {
        let first = g.conditions.len() as u32;
        let params = g.params.clone();
        gen_tree(rng, 0, &params, ns, &mut g.conditions);
        g.programs.push(CondProgram {
            first,
            count: g.conditions.len() as u32 - first,
        });
    }
    let np = g.programs.len();
    // A state machine on node 0.
    if rng.bool() {
        let n_states = rng.range(1, 4);
        let gen_t = |rng: &mut Rng, g: &mut AnimGraph| -> (u32, u32) {
            let first = g.transitions.len() as u32;
            for _ in 0..rng.range(0, 3) {
                let when = match rng.below(4) {
                    0 => When::Now,
                    1 => When::Exit,
                    2 => When::Marker(rng.below(ns as u32)),
                    _ => When::NormalizedTime(rng.f32(0.0, 1.0)),
                };
                let how = match rng.below(4) {
                    0 => How::Crossfade {
                        duration: rng.f32(0.0, 0.5),
                        shape: rng.below(4),
                    },
                    1 => How::Cut,
                    2 => How::Inertialize {
                        duration: rng.f32(0.0, 0.5),
                    },
                    _ => How::Bridge {
                        node: rng.range(1, n - 1),
                        duration: rng.f32(0.0, 0.5),
                        shape: rng.below(4),
                    },
                };
                g.transitions.push(Transition {
                    target: rng.below(n_states),
                    condition: if np == 0 || rng.below(4) == 0 {
                        NONE
                    } else {
                        rng.below(np as u32)
                    },
                    when,
                    how,
                    interrupt: Interrupt::Never,
                });
            }
            (first, g.transitions.len() as u32 - first)
        };
        let states_first = g.states.len() as u32;
        let (any_first, any_count) = gen_t(rng, &mut g);
        for _ in 0..n_states {
            let (tf, tc) = gen_t(rng, &mut g);
            g.states.push(State {
                name: rng.opt_id(ns),
                node: rng.range(1, n - 1),
                transitions_first: tf,
                transitions_count: tc,
                flags: rng.below(2),
            });
        }
        g.machines.push(Machine {
            node: 0,
            name: rng.opt_id(ns),
            states_first,
            states_count: n_states,
            entry: rng.below(n_states),
            any_first,
            any_count,
        });
        // Interrupt lists.
        let nt = g.transitions.len() as u32;
        for t in 0..g.transitions.len() {
            g.transitions[t].interrupt = match rng.below(3) {
                0 => Interrupt::Never,
                1 => Interrupt::Any,
                _ => {
                    let first = g.interrupts.len() as u32;
                    let count = rng.range(0, 2);
                    g.interrupts.extend((0..count).map(|_| rng.below(nt)));
                    Interrupt::List { first, count }
                }
            };
        }
    }
    for _ in 0..rng.range(0, 2) {
        g.slots.push(Slot {
            name: rng.below(ns as u32),
            node: rng.below(n),
            group: rng.opt_id(ns),
        });
        g.linked.push(LinkedGraph {
            name: rng.below(ns as u32),
            node: rng.below(n),
            default_graph: rng.opt_id(ns),
        });
    }
    let floats: Vec<u32> = (0..g.params.len() as u32)
        .filter(|&i| g.params[i as usize].default.ty() == ParamType::Float)
        .collect();
    for _ in 0..rng.range(0, 3) {
        g.layers.push(Layer {
            name: rng.below(ns as u32),
            node: rng.below(n),
            mask: rng.opt_id(ns),
            mode: rng.pick(LayerMode::ALL),
            weight: rng.f32(0.0, 1.0),
            weight_param: if floats.is_empty() || rng.bool() {
                NONE
            } else {
                rng.pick(&floats)
            },
        });
    }
    if np > 0 && n > 2 && rng.bool() {
        let node = rng.range(1, n - 2);
        let rows_first = g.chooser_rows.len() as u32;
        let rows = rng.range(1, 3);
        for _ in 0..rows {
            g.chooser_rows.push(ChooserRow {
                condition: rng.below(np as u32),
                node: rng.range(node + 1, n - 1),
            });
        }
        let fallback = if rng.bool() {
            NONE
        } else {
            rng.range(node + 1, n - 1)
        };
        g.choosers.push(Chooser {
            node,
            rows_first,
            rows_count: rows,
            fallback,
        });
    }
    g
}

#[test]
fn round_trips_arbitrary_graphs() {
    for seed in 0..400 {
        let mut rng = Rng::new(seed);
        let g = gen_graph(&mut rng);
        let bytes = g.write().unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        check_layout(&bytes);
        let v = AnimGraphView::parse(&bytes).unwrap();
        assert_eq!(v.to_graph(), g, "seed {seed}");
        assert_eq!(v.to_graph().write().unwrap(), bytes);
    }
}

/// Idle/Run machine on node 0, with a blend under Run and a speed parameter.
fn sample() -> AnimGraph {
    let strings = [
        "Base",
        "speed",
        "Idle",
        "Run",
        "Jump",
        "L",
        "UpperBody",
        "upper.mask.json",
        "grounded",
    ]
    .map(String::from)
    .to_vec();
    let node = |family, kind, inputs_first, inputs_count| Node {
        family,
        kind,
        inputs_first,
        inputs_count,
        params_first: 0,
        params_count: 0,
        name: NONE,
    };
    AnimGraph {
        name: 0,
        output: 0,
        skeleton: NONE,
        strings,
        params: vec![
            Param {
                name: 1,
                flags: PARAM_REPLICATE,
                default: ParamValue::Float(0.0),
            },
            Param {
                name: 8,
                flags: PARAM_COMPUTED,
                default: ParamValue::Bool(true),
            },
            Param {
                name: 6,
                flags: 0,
                default: ParamValue::Vec2([0.0, 1.0]),
            },
        ],
        nodes: vec![
            node(family::LOGIC, 0, 0, 0),
            node(family::SOURCES, 0, 0, 0),
            Node {
                params_first: 0,
                params_count: 2,
                ..node(family::MIXING, 1, 0, 2)
            },
            node(family::SOURCES, 0, 0, 0),
        ],
        inputs: vec![1, 3],
        param_blocks: vec![0.5f32.to_bits(), 7],
        machines: vec![Machine {
            node: 0,
            name: 0,
            states_first: 0,
            states_count: 2,
            entry: 0,
            any_first: 0,
            any_count: 0,
        }],
        states: vec![
            State {
                name: 2,
                node: 1,
                transitions_first: 0,
                transitions_count: 1,
                flags: 0,
            },
            State {
                name: 3,
                node: 2,
                transitions_first: 1,
                transitions_count: 1,
                flags: STATE_EXIT,
            },
        ],
        transitions: vec![
            Transition {
                target: 1,
                condition: 0,
                when: When::Now,
                how: How::Crossfade {
                    duration: 0.2,
                    shape: 1,
                },
                interrupt: Interrupt::List { first: 0, count: 1 },
            },
            Transition {
                target: 0,
                condition: 1,
                when: When::Marker(5),
                how: How::Inertialize { duration: 0.15 },
                interrupt: Interrupt::Any,
            },
        ],
        interrupts: vec![1],
        programs: vec![
            CondProgram { first: 0, count: 3 },
            CondProgram { first: 3, count: 1 },
        ],
        conditions: vec![
            CondNode::All(2),
            CondNode::Compare {
                operand: Operand::Param(0),
                op: CmpOp::Gt,
                value: 0.1f32.to_bits(),
            },
            CondNode::Compare {
                operand: Operand::Param(1),
                op: CmpOp::Eq,
                value: 1,
            },
            CondNode::Compare {
                operand: Operand::Request(4),
                op: CmpOp::Eq,
                value: 1,
            },
        ],
        slots: vec![Slot {
            name: 6,
            node: 3,
            group: NONE,
        }],
        linked: vec![],
        layers: vec![Layer {
            name: 6,
            node: 2,
            mask: 7,
            mode: LayerMode::Override,
            weight: 1.0,
            weight_param: 0,
        }],
        choosers: vec![],
        chooser_rows: vec![],
    }
}

#[test]
fn views_read_the_documented_layout() {
    let bytes = sample().write().unwrap();
    assert_eq!(&bytes[0..8], b"MYCOAGPH");
    let v = AnimGraphView::parse(&bytes).unwrap();
    assert_eq!(v.node(2).unwrap().family, family::MIXING);
    assert_eq!(v.node_inputs(2).unwrap().to_vec(), vec![1, 3]);
    assert_eq!(
        f32::from_bits(v.node_params(2).unwrap().get(0).unwrap()),
        0.5
    );
    let m = v.machine(0).unwrap();
    assert_eq!(
        v.state(m.states_first as usize + 1).unwrap().flags,
        STATE_EXIT
    );
    assert_eq!(v.transition(1).unwrap().when, When::Marker(5));
    assert_eq!(v.strings().get(5), Some("L"));
    assert_eq!(v.condition(0), Some(CondNode::All(2)));
    assert_eq!(v.param(1).unwrap().flags, PARAM_COMPUTED);
    assert_eq!(v.layer(0).unwrap().mask, 7);
    // NODES record 2: family byte, kind u16 at 2.
    let nodes = v.section(section::NODES).unwrap().offset as usize + 2 * 24;
    assert_eq!(bytes[nodes], family::MIXING);
    assert_eq!(u16::from_le_bytes([bytes[nodes + 2], bytes[nodes + 3]]), 1);
    // TRANSITIONS record 0: when/how/interrupt bytes and duration.
    let t = v.section(section::TRANSITIONS).unwrap().offset as usize;
    assert_eq!(&bytes[t + 8..t + 11], &[0, 0, 2]);
    assert_eq!(
        f32::from_le_bytes(bytes[t + 16..t + 20].try_into().unwrap()),
        0.2
    );
}

#[test]
fn family_ids_match_anim_graph() {
    // Copied from anim-graph's `Family` discriminants (dispatch.rs): append-only.
    let ids = [
        family::SOURCES,
        family::LOGIC,
        family::MIXING,
        family::SLOTS,
        family::SYNC,
        family::RIG,
        family::RETARGET,
        family::MATCHING,
        family::PHYSICS,
        family::PLUGIN,
    ];
    assert_eq!(ids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert_eq!(family::COUNT, 10);
}

#[test]
fn corrupt_and_truncated_buffers_are_refused() {
    let mut rng = Rng::new(11);
    check_refusals(
        &sample().write().unwrap(),
        |b| AnimGraphView::parse(b).map(|_| ()),
        &mut rng,
    );
    for seed in 0..10 {
        let mut g = Rng::new(900 + seed);
        let bytes = gen_graph(&mut g).write().unwrap();
        check_refusals(&bytes, |b| AnimGraphView::parse(b).map(|_| ()), &mut rng);
    }
}

#[test]
fn invalid_graphs_are_refused() {
    let err = |f: &dyn Fn(&mut AnimGraph)| {
        let mut g = sample();
        f(&mut g);
        g.write().expect_err("invalid graph written")
    };
    assert!(matches!(
        err(&|g| g.nodes[1].family = 10),
        FormatError::InvalidValue {
            what: "node family",
            ..
        }
    ));
    assert!(matches!(
        err(&|g| g.inputs[0] = 9),
        FormatError::IndexOutOfRange { .. }
    ));
    // Cycles: through inputs, through a state root, through a bridge.
    assert!(matches!(
        err(&|g| g.inputs[0] = 2),
        FormatError::Cycle { .. }
    ));
    assert!(matches!(
        err(&|g| g.states[0].node = 0),
        FormatError::Cycle { .. }
    ));
    assert!(matches!(
        err(&|g| g.transitions[0].how = How::Bridge {
            node: 0,
            duration: 0.1,
            shape: 0
        }),
        FormatError::Cycle { .. }
    ));
    assert!(matches!(
        err(&|g| g.machines[0].node = 1),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|g| g.machines[0].entry = 2),
        FormatError::IndexOutOfRange { .. }
    ));
    assert!(matches!(
        err(&|g| g.transitions[0].target = 2),
        FormatError::IndexOutOfRange {
            what: "transition target",
            ..
        }
    ));
    assert!(matches!(
        err(&|g| g.transitions[0].condition = 5),
        FormatError::IndexOutOfRange { .. }
    ));
    assert!(matches!(
        err(&|g| g.interrupts[0] = 2),
        FormatError::IndexOutOfRange { .. }
    ));
    assert!(matches!(
        err(&|g| g.transitions[0].how = How::Crossfade {
            duration: -1.0,
            shape: 0
        }),
        FormatError::BadFloat { .. }
    ));
    assert!(matches!(
        err(&|g| g.transitions[1].when = When::NormalizedTime(f32::NAN)),
        FormatError::BadFloat { .. }
    ));
    // Conditions: malformed trees, bad operands, bad constants.
    assert!(matches!(
        err(&|g| g.programs[0].count = 2),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|g| g.conditions[0] = CondNode::All(3)),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|g| g.conditions[0] = CondNode::Any(0)),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|g| g.conditions[2] = CondNode::Compare {
            operand: Operand::Param(1),
            op: CmpOp::Lt,
            value: 1
        }),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|g| g.conditions[2] = CondNode::Compare {
            operand: Operand::Param(2),
            op: CmpOp::Eq,
            value: 0
        }),
        FormatError::Inconsistent {
            what: "parameter type not comparable"
        }
    ));
    assert!(matches!(
        err(&|g| g.conditions[1] = CondNode::Compare {
            operand: Operand::Param(0),
            op: CmpOp::Gt,
            value: f32::NAN.to_bits()
        }),
        FormatError::BadFloat { .. }
    ));
    assert!(matches!(
        err(&|g| g.conditions[3] = CondNode::Compare {
            operand: Operand::Request(4),
            op: CmpOp::Eq,
            value: 2
        }),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|g| g.params[0].default = ParamValue::Float(f32::INFINITY)),
        FormatError::BadFloat { .. }
    ));
    assert!(matches!(
        err(&|g| g.params[0].flags = 8),
        FormatError::InvalidValue {
            what: "param flags",
            ..
        }
    ));
    assert!(matches!(
        err(&|g| g.layers[0].weight = 1.5),
        FormatError::BadFloat { .. }
    ));
    assert!(matches!(
        err(&|g| g.layers[0].weight_param = 1),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|g| g.slots[0].node = 4),
        FormatError::IndexOutOfRange { .. }
    ));
    assert!(matches!(
        err(&|g| g.output = 4),
        FormatError::IndexOutOfRange { .. }
    ));
    assert!(matches!(
        err(&|g| {
            g.nodes.clear();
            g.machines.clear();
            g.states.clear();
            g.layers.clear();
            g.slots.clear();
            g.transitions.clear();
            g.interrupts.clear();
        }),
        FormatError::BadCount { what: "nodes", .. }
    ));
}

#[test]
fn condition_depth_is_limited() {
    let mut g = sample();
    let first = g.conditions.len() as u32;
    for _ in 0..MAX_CONDITION_DEPTH {
        g.conditions.push(CondNode::All(1));
    }
    g.conditions.push(CondNode::Compare {
        operand: Operand::StateTime,
        op: CmpOp::Gt,
        value: 0,
    });
    g.programs.push(CondProgram {
        first,
        count: MAX_CONDITION_DEPTH + 1,
    });
    assert!(matches!(g.write(), Err(FormatError::TooDeep { .. })));
    // One level less is accepted.
    g.conditions.remove(first as usize);
    g.programs.last_mut().unwrap().count -= 1;
    assert!(g.write().is_ok());
}

#[test]
fn unused_transition_fields_must_be_zero() {
    let mut bytes = sample().write().unwrap();
    let v = AnimGraphView::parse(&bytes).unwrap();
    let t = v.section(section::TRANSITIONS).unwrap().offset as usize + 40; // inertialize: shape must be 0
    bytes[t + 20] = 1;
    assert!(matches!(
        AnimGraphView::parse(&bytes),
        Err(FormatError::NonZeroReserved { .. })
    ));
}
