//! The Node test's timeline fixtures (`src/plugins/animation/runtime/wasm/fixtures/`): a leaf clip
//! (a ramp `value = t` over 4 s with a notify at 1.5 s) and a timeline clip over it (4 s: its own
//! ramp, and a subclip entry covering `[1, 3)` that plays the leaf from 0.5 s at double speed
//! with a 0.5 s blend in), for `timeline.node.test.ts` (tweens and timelines through the built
//! wasm). Generated here (anim-format and anim-compress, deterministic) and committed. This test
//! fails when they are stale; regenerate with
//! `MYCO_UPDATE_FIXTURES=1 cargo test -p anim-wasm --test timeline_fixtures`. It also plays the
//! pair through the native core and checks the values the Node test expects.

mod common;

use std::fs;
use std::path::PathBuf;

use anim_compress::{compress, Settings};
use anim_format::clip::{Binding, Clip, Key, KeyData, Track, TrackKind};
use anim_format::NONE;
use anim_wire::core::PASS_NORMAL;
use anim_wire::timeline::{TimelineCreate, FLAG_PLAY, WRAP_HOLD};
use anim_wire::WireRecord;
use common::core;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../src/plugins/animation/runtime/wasm/fixtures")
}

fn ramp() -> Track {
    Track {
        kind: TrackKind::Float,
        flags: 0,
        subtype: 0,
        binding: Binding::property(0, 1, 2),
        raw: (0..121).map(|f| f as f32 / 30.0).collect(),
        keys: Vec::new(),
    }
}

fn clip(tracks: Vec<Track>) -> Vec<u8> {
    let clip = Clip {
        flags: 0,
        name: NONE,
        duration: 4.0,
        sample_rate: 30.0,
        frame_count: 121,
        bone_count: 0,
        root_bone: NONE,
        strings: vec!["leaf".into(), "n".into(), "c".into()],
        tracks,
        has_raw: true,
        root_curve: None,
        compressed: None,
    };
    let settings = Settings {
        keep_raw: true,
        ..Settings::default()
    };
    compress(&clip, None, &settings).unwrap().bytes
}

fn files() -> Vec<(&'static str, Vec<u8>)> {
    let notify = Track {
        kind: TrackKind::Event,
        flags: 0,
        subtype: 0,
        binding: Binding::none(),
        raw: Vec::new(),
        keys: vec![Key {
            time: 1.5,
            end: 1.5,
            data: KeyData::Event {
                method: 0,
                args: NONE,
                threshold: 0.0,
                always: true,
            },
        }],
    };
    let entry = Track {
        kind: TrackKind::Subclip,
        flags: 0,
        subtype: 0,
        binding: Binding::none(),
        raw: Vec::new(),
        keys: vec![Key {
            time: 1.0,
            end: 3.0,
            data: KeyData::Subclip {
                clip: 0,
                offset: 0.5,
                speed: 2.0,
                blend_in: 0.5,
                blend_out: 0.0,
            },
        }],
    };
    vec![
        ("timeline_leaf.anim", clip(vec![ramp(), notify])),
        ("timeline_root.anim", clip(vec![ramp(), entry])),
    ]
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
                "{name} is stale: run `MYCO_UPDATE_FIXTURES=1 cargo test -p anim-wasm --test timeline_fixtures`"
            );
        }
    }
}

#[test]
fn the_pair_plays_as_the_node_test_expects() {
    let files = files();
    let mut core = core(4, 16);
    let leaf = core.load_clip(&files[0].1);
    let root = core.load_clip(&files[1].1);
    let h = core.timeline_create(
        &TimelineCreate {
            world: 0,
            host_id: 1,
            clip: root,
            time_mode: 0,
            wrap: WRAP_HOLD,
            flags: FLAG_PLAY,
            speed: 1.0,
            start: 0.0,
        }
        .encode(),
    );
    assert_eq!(core.timeline_bind(h, root, 0, leaf), 0);
    let info = core.timelines().info(h).unwrap();
    assert_eq!((info.blocks, info.value_words), (2, 2));
    for _ in 0..8 {
        core.write_inputs(0);
        core.evaluate(0, PASS_NORMAL, 0.25, 0.25);
    }
    // t = 2: the entry is at 0.5 + 2 = 2.5, at full weight; the root's own ramp is 2.
    let v = |i: usize| f32::from_bits(core.timelines().values()[info.value_offset as usize + i]);
    assert!((v(0) - 2.0).abs() < 1e-3 && (v(1) - 2.5).abs() < 1e-3);
}
