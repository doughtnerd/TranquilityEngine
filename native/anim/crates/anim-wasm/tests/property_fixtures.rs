//! The Node test's property and notify fixtures (`src/plugins/animation/runtime/wasm/fixtures/`),
//! for `features/properties.node.test.ts` (T20t: property tracks into the ECS, notifies to
//! behaviours). Generated here (anim-format and anim-compress, deterministic) and committed. This
//! test fails when they are stale; regenerate with
//! `MYCO_UPDATE_FIXTURES=1 cargo test -p anim-wasm --test property_fixtures`.
//!
//! - `props.anim` (1 s, 30 Hz, no skeleton): `Lamp` `engine.Light.intensity` = 2t;
//!   `Body` `engine.MeshRenderer` `material.color` = (t, 0.5, 1 - t, 1); `Sprite`
//!   `engine.SpriteRenderer.sprite` steps `asset:sheet.png#run_0` → `#run_3` at 0.5 s; `Trail`
//!   active over [0.25, 0.75); `Face` morph target `1` = t; `Joint` `engine.BallJoint`
//!   `drive.targetRotation` = a turn of t·90° about +Y; and two tracks with no target: `Ghost`
//!   (no such node) and `Lamp` `engine.Light.type` (an enum a float can't drive).
//! - `notifies.anim` (1 s, no skeleton, no sampled tracks): notifies `footstep` at 0.25 s with
//!   args `["L", 2]`, a notify state `swing` over [0.4, 0.7) with args `{"power": 3}`, `update`
//!   (a reserved name) at 0.5 s; an audio key at 0.3 s (`asset:sfx/step.wav`, params
//!   `{"volume": 0.5, "surface": 2}`) on the node `Feet`; a `particlePlay` control at 0.6 s.
//!   Every notify fires at any weight (threshold 0, always).

mod common;

use std::fs;
use std::path::PathBuf;

use anim_compress::{compress, Settings};
use anim_format::clip::{Binding, Clip, ControlKind, DiscreteType, Key, KeyData, Track, TrackKind};
use anim_format::NONE;
use anim_wire::core::PASS_NORMAL;
use common::{core, play, send, skeleton, track_records, Shape};

const FRAMES: usize = 31;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../src/plugins/animation/runtime/wasm/fixtures")
}

fn sampled(kind: TrackKind, binding: Binding, value: impl Fn(f32) -> Vec<f32>) -> Track {
    Track {
        kind,
        flags: 0,
        subtype: 0,
        binding,
        raw: (0..FRAMES).flat_map(|f| value(f as f32 / 30.0)).collect(),
        keys: Vec::new(),
    }
}

fn keyed(kind: TrackKind, subtype: u8, binding: Binding, keys: Vec<Key>) -> Track {
    Track {
        kind,
        flags: 0,
        subtype,
        binding,
        raw: Vec::new(),
        keys,
    }
}

fn key(time: f32, end: f32, data: KeyData) -> Key {
    Key { time, end, data }
}

fn node(path: u32) -> Binding {
    Binding {
        bone: NONE,
        node_path: path,
        component: NONE,
        field: NONE,
    }
}

fn build(strings: &[&str], tracks: Vec<Track>, sampled: bool) -> Vec<u8> {
    let clip = Clip {
        flags: 0,
        name: NONE,
        duration: 1.0,
        sample_rate: 30.0,
        frame_count: FRAMES as u32,
        bone_count: 0,
        root_bone: NONE,
        strings: strings.iter().map(|s| s.to_string()).collect(),
        tracks,
        has_raw: sampled,
        root_curve: None,
        compressed: None,
    };
    if !sampled {
        return clip.write().unwrap();
    }
    let settings = Settings {
        keep_raw: true,
        ..Settings::default()
    };
    compress(&clip, None, &settings).unwrap().bytes
}

fn props() -> Vec<u8> {
    let strings = [
        "Lamp",                  // 0
        "engine.Light",          // 1
        "intensity",             // 2
        "Body",                  // 3
        "engine.MeshRenderer",   // 4
        "material.color",        // 5
        "Sprite",                // 6
        "engine.SpriteRenderer", // 7
        "sprite",                // 8
        "asset:sheet.png#run_0", // 9
        "asset:sheet.png#run_3", // 10
        "Trail",                 // 11
        "Face",                  // 12
        "1",                     // 13
        "Joint",                 // 14
        "engine.BallJoint",      // 15
        "drive.targetRotation",  // 16
        "Ghost",                 // 17
        "type",                  // 18
    ];
    let half_turn = std::f32::consts::FRAC_PI_4; // half of 90°
    let tracks = vec![
        sampled(TrackKind::Float, Binding::property(0, 1, 2), |t| {
            vec![2.0 * t]
        }),
        sampled(TrackKind::Color, Binding::property(3, 4, 5), |t| {
            vec![t, 0.5, 1.0 - t, 1.0]
        }),
        keyed(
            TrackKind::Discrete,
            DiscreteType::Asset.id(),
            Binding::property(6, 7, 8),
            vec![
                key(0.0, 0.0, KeyData::Discrete { value: 9 }),
                key(0.5, 0.5, KeyData::Discrete { value: 10 }),
            ],
        ),
        keyed(
            TrackKind::Activation,
            0,
            node(11),
            vec![key(0.25, 0.75, KeyData::Activation)],
        ),
        sampled(TrackKind::Morph, Binding::property(12, NONE, 13), |t| {
            vec![t]
        }),
        sampled(TrackKind::Quat, Binding::property(14, 15, 16), move |t| {
            vec![0.0, (half_turn * t).sin(), 0.0, (half_turn * t).cos()]
        }),
        sampled(TrackKind::Float, Binding::property(17, 1, 2), |t| vec![t]),
        sampled(TrackKind::Float, Binding::property(0, 1, 18), |t| vec![t]),
    ];
    build(&strings, tracks, true)
}

fn notifies() -> Vec<u8> {
    let strings = [
        "footstep",                      // 0
        r#"["L",2]"#,                    // 1
        "swing",                         // 2
        r#"{"power":3}"#,                // 3
        "update",                        // 4
        "asset:sfx/step.wav",            // 5
        r#"{"volume":0.5,"surface":2}"#, // 6
        "Sparks",                        // 7
        "Feet",                          // 8
    ];
    let event = |method: u32, args: u32| KeyData::Event {
        method,
        args,
        threshold: 0.0,
        always: true,
    };
    let tracks = vec![
        keyed(
            TrackKind::Event,
            0,
            Binding::none(),
            vec![
                key(0.25, 0.25, event(0, 1)),
                key(0.4, 0.7, event(2, 3)),
                key(0.5, 0.5, event(4, NONE)),
            ],
        ),
        keyed(
            TrackKind::Audio,
            0,
            node(8),
            vec![key(
                0.3,
                0.3,
                KeyData::Audio {
                    asset: 5,
                    params: 6,
                },
            )],
        ),
        keyed(
            TrackKind::Control,
            0,
            Binding::none(),
            vec![key(
                0.6,
                0.6,
                KeyData::Control {
                    kind: ControlKind::ParticlePlay,
                    target: 7,
                    payload: NONE,
                },
            )],
        ),
    ];
    build(&strings, tracks, false)
}

fn files() -> Vec<(&'static str, Vec<u8>)> {
    vec![("props.anim", props()), ("notifies.anim", notifies())]
}

#[test]
fn fixtures_are_current() {
    let update = std::env::var_os("MYCO_UPDATE_FIXTURES").is_some();
    for (name, bytes) in files() {
        let path = dir().join(name);
        if update {
            fs::write(&path, &bytes).unwrap();
        } else {
            let on_disk = fs::read(&path).unwrap_or_default();
            assert!(
                on_disk == bytes,
                "{name} is stale: run `MYCO_UPDATE_FIXTURES=1 cargo test -p anim-wasm --test property_fixtures`"
            );
        }
    }
}

#[test]
fn the_clips_load_and_play_on_any_skeleton() {
    let (_, skel) = skeleton(Shape::Tree(4), 1);
    let mut core = core(4, 16);
    let s = core.load_skeleton(&skel);
    let props = core.load_clip(&files()[0].1);
    let notifies = core.load_clip(&files()[1].1);
    assert!(s != 0 && props != 0 && notifies != 0);
    // The property clip has a column per property track (activation and discrete among them).
    assert!(core.clip_column_bytes(props) > 0);
    let h = core.create_instance(0, s, 0);
    send(&mut core, &[play(h, notifies, 0, 0.0, 1, 0)]);
    let mut seen = 0;
    for _ in 0..30 {
        core.evaluate(0, PASS_NORMAL, 1.0 / 30.0, 1.0 / 30.0);
        seen += track_records(&core, h).len();
        core.write_inputs(0);
    }
    // footstep, update, swing begin/ticks/end, audio, control.
    assert!(seen >= 6, "only {seen} records");
}
