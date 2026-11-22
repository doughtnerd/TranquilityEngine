mod common;

use anim_format::posedb::*;
use anim_format::{FormatError, NONE};
use common::*;

fn gen_kd(rng: &mut Rng, frames: u32, dims: u32) -> KdTree {
    // A random tree built breadth-first so children always follow their parent.
    let mut nodes = vec![None];
    let mut indices = Vec::new();
    let mut i = 0;
    while i < nodes.len() {
        let inner = nodes.len() < 7 && rng.bool();
        nodes[i] = Some(if inner {
            let left = nodes.len() as u32;
            nodes.push(None);
            nodes.push(None);
            KdNode::Inner {
                axis: rng.below(dims),
                split: rng.f32(-1.0, 1.0),
                left,
                right: left + 1,
            }
        } else {
            let first = indices.len() as u32;
            let count = rng.range(0, 3);
            indices.extend((0..count).map(|_| rng.below(frames)));
            KdNode::Leaf { first, count }
        });
        i += 1;
    }
    KdTree {
        nodes: nodes.into_iter().map(Option::unwrap).collect(),
        indices,
    }
}

fn gen_db(rng: &mut Rng) -> PoseDb {
    let strings = strings(rng, 2);
    let ns = strings.len() as u32;
    let mut features = Vec::new();
    let mut dims = 0u32;
    for _ in 0..rng.range(1, 5) {
        let kind = rng.pick(FeatureKind::ALL);
        let fd = kind.dims().unwrap_or(rng.range(1, 4) as u16);
        features.push(Feature {
            kind,
            dims: fd,
            bone: if kind.has_bone() { rng.below(30) } else { NONE },
            first_dim: dims,
            weight: rng.f32(0.0, 2.0),
            time_offset: if kind.has_bone() {
                0.0
            } else {
                rng.f32(-0.5, 1.0)
            },
            name: rng.opt_id(ns as usize),
        });
        dims += fd as u32;
    }
    let frames = rng.range(1, 30) as usize;
    let clips: Vec<u32> = (0..rng.range(1, 3)).map(|_| rng.below(ns)).collect();
    let tag_names: Vec<u32> = (0..rng.range(0, 40)).map(|_| rng.below(ns)).collect();
    let wpf = words_per_frame(tag_names.len());
    let mut tags = vec![0u32; frames * wpf];
    for f in 0..frames {
        for t in 0..tag_names.len() {
            if rng.bool() {
                tags[f * wpf + t / 32] |= 1 << (t % 32);
            }
        }
    }
    PoseDb {
        sample_rate: 30.0,
        skeleton: rng.opt_id(ns as usize),
        strings,
        dims,
        features,
        mean: (0..dims).map(|_| rng.f32(-1.0, 1.0)).collect(),
        std: (0..dims).map(|_| rng.f32(0.1, 2.0)).collect(),
        matrix: (0..frames * dims as usize)
            .map(|_| rng.f32(-3.0, 3.0))
            .collect(),
        frames: (0..frames)
            .map(|_| FrameRef {
                clip: rng.below(clips.len() as u32),
                time: rng.f32(0.0, 4.0),
            })
            .collect(),
        clips,
        tag_names,
        tags,
        kd_tree: rng.bool().then(|| gen_kd(rng, frames as u32, dims)),
    }
}

#[test]
fn round_trips_arbitrary_databases() {
    for seed in 0..400 {
        let mut rng = Rng::new(seed);
        let db = gen_db(&mut rng);
        let bytes = db.write().unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        check_layout(&bytes);
        let v = PoseDbView::parse(&bytes).unwrap();
        assert_eq!(v.to_posedb(), db, "seed {seed}");
        assert_eq!(v.to_posedb().write().unwrap(), bytes);
    }
}

fn sample() -> PoseDb {
    let strings = ["Walk.anim", "Run.anim", "idle", "pivot", "LeftFoot"]
        .map(String::from)
        .to_vec();
    let features = vec![
        Feature {
            kind: FeatureKind::BonePosition,
            dims: 3,
            bone: 4,
            first_dim: 0,
            weight: 1.0,
            time_offset: 0.0,
            name: 4,
        },
        Feature {
            kind: FeatureKind::TrajectoryPosition,
            dims: 2,
            bone: NONE,
            first_dim: 3,
            weight: 0.5,
            time_offset: 0.33,
            name: NONE,
        },
    ];
    let frames = 3;
    PoseDb {
        sample_rate: 30.0,
        skeleton: NONE,
        strings,
        dims: 5,
        features,
        mean: vec![0.0; 5],
        std: vec![1.0; 5],
        matrix: (0..frames * 5).map(|i| i as f32).collect(),
        frames: vec![
            FrameRef { clip: 0, time: 0.0 },
            FrameRef {
                clip: 0,
                time: 1.0 / 30.0,
            },
            FrameRef { clip: 1, time: 0.5 },
        ],
        clips: vec![0, 1],
        tag_names: vec![2, 3],
        tags: vec![0b01, 0b10, 0b11],
        kd_tree: Some(KdTree {
            nodes: vec![
                KdNode::Inner {
                    axis: 0,
                    split: 5.0,
                    left: 1,
                    right: 2,
                },
                KdNode::Leaf { first: 0, count: 1 },
                KdNode::Leaf { first: 1, count: 2 },
            ],
            indices: vec![0, 1, 2],
        }),
    }
}

#[test]
fn views_read_the_documented_layout() {
    let bytes = sample().write().unwrap();
    assert_eq!(&bytes[0..8], b"MYCOPSDB");
    let v = PoseDbView::parse(&bytes).unwrap();
    assert_eq!(v.dims(), 5);
    assert_eq!(v.row_stride(), 8);
    // Rows are 16-byte aligned: the matrix section is, and the stride is a multiple of 4 floats.
    let m = v.section(section::MATRIX).unwrap();
    assert_eq!(m.offset % 16, 0);
    assert_eq!(m.count, 3 * 8);
    assert_eq!(v.matrix().get(8), Some(5.0)); // row 1 starts after 3 zero padding columns
    assert_eq!(v.matrix().get(5), Some(0.0));
    assert_eq!(
        v.row(2).unwrap().to_vec(),
        vec![10.0, 11.0, 12.0, 13.0, 14.0]
    );
    assert_eq!(v.std().to_vec(), vec![1.0; 5]);
    assert_eq!(v.frame(2), Some(FrameRef { clip: 1, time: 0.5 }));
    assert_eq!(v.strings().get(v.clips().get(1).unwrap()), Some("Run.anim"));
    assert!(v.has_tag(0, 0) && !v.has_tag(0, 1));
    assert!(v.has_tag(2, 1));
    assert!(!v.has_tag(2, 2));
    assert_eq!(
        v.kd_node(0),
        Some(KdNode::Inner {
            axis: 0,
            split: 5.0,
            left: 1,
            right: 2
        })
    );
    assert_eq!(v.feature(1).unwrap().time_offset, 0.33);
}

#[test]
fn corrupt_and_truncated_buffers_are_refused() {
    let mut rng = Rng::new(21);
    check_refusals(
        &sample().write().unwrap(),
        |b| PoseDbView::parse(b).map(|_| ()),
        &mut rng,
    );
    for seed in 0..10 {
        let mut g = Rng::new(300 + seed);
        let bytes = gen_db(&mut g).write().unwrap();
        check_refusals(&bytes, |b| PoseDbView::parse(b).map(|_| ()), &mut rng);
    }
}

#[test]
fn invalid_databases_are_refused() {
    let err = |f: &dyn Fn(&mut PoseDb)| {
        let mut d = sample();
        f(&mut d);
        d.write().expect_err("invalid database written")
    };
    assert!(matches!(
        err(&|d| d.features[1].first_dim = 4),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|d| d.features[1].dims = 3),
        FormatError::InvalidValue {
            what: "feature dims",
            ..
        }
    ));
    assert!(matches!(
        err(&|d| d.features[0].bone = NONE),
        FormatError::Inconsistent {
            what: "feature bone"
        }
    ));
    assert!(matches!(
        err(&|d| d.features[0].weight = -1.0),
        FormatError::BadFloat { .. }
    ));
    assert!(matches!(
        err(&|d| d.std[2] = 0.0),
        FormatError::BadFloat {
            what: "normalization"
        }
    ));
    assert!(matches!(
        err(&|d| d.matrix[4] = f32::NAN),
        FormatError::BadFloat { .. }
    ));
    assert!(matches!(
        err(&|d| {
            d.matrix.pop();
        }),
        FormatError::BadCount { .. }
    ));
    assert!(matches!(
        err(&|d| d.frames[0].clip = 2),
        FormatError::IndexOutOfRange { .. }
    ));
    assert!(matches!(
        err(&|d| d.frames[0].time = -1.0),
        FormatError::BadFloat { .. }
    ));
    assert!(matches!(
        err(&|d| d.tags[1] = 0b100),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        err(&|d| {
            d.tags.pop();
        }),
        FormatError::BadCount { .. }
    ));
    assert!(matches!(
        err(&|d| d.kd_tree.as_mut().unwrap().nodes[0] = KdNode::Inner {
            axis: 0,
            split: 0.0,
            left: 0,
            right: 2
        }),
        FormatError::IndexOutOfRange {
            what: "KD child",
            ..
        }
    ));
    assert!(matches!(
        err(&|d| d.kd_tree.as_mut().unwrap().nodes[0] = KdNode::Inner {
            axis: 5,
            split: 0.0,
            left: 1,
            right: 2
        }),
        FormatError::IndexOutOfRange { .. }
    ));
    assert!(matches!(
        err(&|d| d.kd_tree.as_mut().unwrap().indices[0] = 3),
        FormatError::IndexOutOfRange { .. }
    ));
    assert!(matches!(
        err(&|d| d.kd_tree.as_mut().unwrap().nodes[2] = KdNode::Leaf { first: 2, count: 2 }),
        FormatError::RangeOutOfBounds { .. }
    ));
}

#[test]
fn matrix_row_padding_must_be_zero() {
    let mut bytes = sample().write().unwrap();
    let off = PoseDbView::parse(&bytes)
        .unwrap()
        .section(section::MATRIX)
        .unwrap()
        .offset as usize;
    bytes[off + 5 * 4] = 1; // column 5 of row 0 is padding
    assert!(PoseDbView::parse(&bytes).is_err());
}
