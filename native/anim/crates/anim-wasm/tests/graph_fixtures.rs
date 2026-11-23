//! The Node test's graph fixtures (T31, `src/plugins/animation/runtime/wasm/fixtures/`): the
//! locomotion graph (a state machine with a 2D blend space of three clips and an any-state jump,
//! under an upper-body slot and an inertialization node), its clips over the T13r small skeleton,
//! a command script, and what the native core shows for it (bone matrices at the end, the states
//! entered on the way). The Node test (`core.node.test.ts`) runs the same script through the built
//! wasm and compares; the core is deterministic (no FMA, no relaxed SIMD), so the tolerance is
//! tight (1e-5 on matrix entries, for f32 printing). Also a third 60-bone humanoid clip for the
//! Node benchmark (`bench.mjs`).
//!
//! The files are committed; this test fails when they are stale. Regenerate with
//! `MYCO_UPDATE_FIXTURES=1 cargo test -p anim-wasm --test graph_fixtures`.

mod common;

use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

use anim_format::skeleton::SkeletonView;
use anim_wire::core::PASS_NORMAL;
use anim_wire::graph::GRAPH_STATE_ENTERED;
use anim_wire::{Value, WireRecord};
use common::graph::*;
use common::*;

const DT: f32 = 1.0 / 30.0;
const MAX_BONES: u32 = 64;
const FRAMES: usize = 45;
const MASK_FROM: usize = 3;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../src/plugins/animation/runtime/wasm/fixtures")
}

fn camel(s: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for c in s.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn screaming(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push('_');
        }
        out.extend(c.to_uppercase());
    }
    out
}

/// One script entry as JSON: the record's TypeScript name and values (instance and clip handles
/// are 0; the Node test fills them).
fn entry<R: WireRecord>(frame: usize, r: &R) -> String {
    let mut s = format!(
        "{{\"frame\":{frame},\"record\":\"{}\",\"values\":{{",
        screaming(R::DESC.name)
    );
    for (i, (name, v)) in r.values().iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let v = match v {
            Value::Int(x) => format!("{x}"),
            Value::Float(x) => format!("{x}"),
        };
        let _ = write!(s, "\"{}\":{v}", camel(name));
    }
    s.push_str("}}");
    s
}

struct Generated {
    files: Vec<(&'static str, Vec<u8>)>,
}

fn generate() -> Generated {
    let small = fs::read(dir().join("small.skel")).expect("T13r's small.skel fixture");
    let model = SkeletonView::parse(&small).unwrap().to_skeleton();
    let clip =
        |seed: u64, seconds: f64, looping: bool, speed: f64, sync: Vec<(&'static str, f32)>| {
            let mut spec = ClipSpec::new(seconds, looping, seed);
            spec.speed = speed;
            spec.sync = sync;
            raw_clip(&model, &spec)
        };
    let idle = clip(41, 1.0, true, 0.0, vec![("L", 0.0), ("R", 0.5)]);
    let walk = clip(42, 1.0, true, 1.4, vec![("L", 0.05), ("R", 0.55)]);
    let run = clip(43, 0.7, true, 3.5, vec![("L", 0.0), ("R", 0.35)]);
    let shot = clip(44, 1.0, false, 0.0, Vec::new());
    let mut b = Builder::new();
    let ids = locomotion(&mut b);
    let graph = b.build(ids.output);

    // The native run of the script.
    let mut core = core(4, MAX_BONES);
    let s = core.load_skeleton(&small);
    let ci = core.load_clip(&idle);
    let cw = core.load_clip(&walk);
    let cr = core.load_clip(&run);
    let cs = core.load_clip(&shot);
    let bones = model.bones.len();
    let weights: Vec<f32> = (0..bones).map(|i| (i >= MASK_FROM) as u32 as f32).collect();
    let mask = core.load_mask(&weights);
    let binds = [
        (ids.idle, ci),
        (ids.walk, cw),
        (ids.run, cr),
        (ids.upper, mask),
    ];
    let (_, h) = instance(&mut core, &graph, s, &binds);
    let mut script = Vec::new();
    let mut entered = Vec::new();
    for f in 0..FRAMES {
        let cmds = loco_script(h, &ids, f, cs);
        for c in &cmds {
            let op = u16::from_le_bytes([c[0], c[1]]);
            let mut zeroed = c.clone();
            zeroed[4..8].fill(0); // the instance: filled in by the Node test
            let e = match op {
                anim_wire::graph::SetParam::OPCODE => {
                    entry(f, &anim_wire::graph::SetParam::decode(&zeroed).unwrap())
                }
                anim_wire::graph::Request::OPCODE => {
                    entry(f, &anim_wire::graph::Request::decode(&zeroed).unwrap())
                }
                anim_wire::graph::SlotPlay::OPCODE => {
                    let mut r = anim_wire::graph::SlotPlay::decode(&zeroed).unwrap();
                    r.clip = 0; // the shot clip: filled in by the Node test
                    entry(f, &r)
                }
                other => panic!("script opcode {other:#x}"),
            };
            script.push(e);
        }
        send(&mut core, &cmds);
        core.evaluate(0, PASS_NORMAL, DT, DT);
        for c in graph_changes(&core) {
            if c.kind == GRAPH_STATE_ENTERED {
                entered.push(format!("[{f},{},{}]", c.index, c.value));
            }
        }
    }
    let m = matrices(&core, h, MAX_BONES as usize, bones);

    let mut json = String::new();
    json.push_str("{\n  \"note\": \"Generated by native/anim/crates/anim-wasm/tests/graph_fixtures.rs from the native core. Do not edit.\",\n");
    let _ = writeln!(json, "  \"maxBones\": {MAX_BONES},");
    let _ = writeln!(json, "  \"bones\": {bones},");
    let _ = writeln!(json, "  \"dt\": {DT},");
    let _ = writeln!(json, "  \"frames\": {FRAMES},");
    json.push_str("  \"tolerance\": 0.00001,\n");
    let _ = writeln!(json, "  \"maskFrom\": {MASK_FROM},");
    let _ = writeln!(
        json,
        "  \"binds\": {{\"idle\": {}, \"walk\": {}, \"run\": {}, \"upper\": {}}},",
        ids.idle, ids.walk, ids.run, ids.upper
    );
    let _ = writeln!(json, "  \"script\": [{}],", script.join(","));
    let _ = writeln!(json, "  \"entered\": [{}],", entered.join(","));
    json.push_str("  \"matrices\": [");
    for (i, v) in m.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        let _ = write!(json, "{v}");
    }
    json.push_str("]\n}\n");

    // The benchmark's third humanoid clip.
    let (human, _) = skeleton(Shape::Humanoid, 3);
    let h_idle = common::clip(&human, 1.0, true, 33);

    Generated {
        files: vec![
            ("loco.animgraph", graph),
            ("graph_idle.anim", idle),
            ("graph_walk.anim", walk),
            ("graph_run.anim", run),
            ("graph_shot.anim", shot),
            ("graph_expected.json", json.into_bytes()),
            ("humanoid_idle.anim", h_idle),
        ],
    }
}

#[test]
fn graph_fixtures_are_up_to_date() {
    let g = generate();
    let update = std::env::var_os("MYCO_UPDATE_FIXTURES").is_some();
    let dir = dir();
    let mut stale = Vec::new();
    for (name, bytes) in &g.files {
        let path = dir.join(name);
        if fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
            stale.push(*name);
            if update {
                fs::write(&path, bytes).unwrap();
            }
        }
    }
    assert!(
        update || stale.is_empty(),
        "stale fixtures {stale:?}: run MYCO_UPDATE_FIXTURES=1 cargo test -p anim-wasm --test graph_fixtures"
    );
}
