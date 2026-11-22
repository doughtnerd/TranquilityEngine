//! The sample plugin end to end: built to wasm32, validated and metered by `anim-meter`, then
//! driven in wasmi the way the Phase B host glue drives it (instantiate with no imports, read the
//! descriptor, allocate buffers, copy a batch in, evaluate under a budget, copy it out). The same
//! batch run natively through the crate's exports must give the same bits.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

use anim_meter::{meter, validate, Limits, FUEL_GET, FUEL_SET};
use anim_plugin_sdk::abi::{self, pose_bytes, state_stride, Status, BONE_FLOATS};
use anim_plugin_sdk::descriptor::{Descriptor, ParamKind, HEADER_BYTES};
use anim_plugin_sdk::{Node, Unit};
use plugin_sample::{Scale, Sway};

/// Builds the crate for wasm32-unknown-unknown (release) once per test run, in its own target
/// directory so the outer `cargo test` keeps its lock.
fn module() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| {
        let target = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("plugin-sample-wasm");
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let status = Command::new(env!("CARGO"))
            .args([
                "build",
                "--release",
                "--target",
                "wasm32-unknown-unknown",
                "--manifest-path",
            ])
            .arg(&manifest)
            .arg("--target-dir")
            .arg(&target)
            .env_remove("RUSTFLAGS")
            .env_remove("CARGO_ENCODED_RUSTFLAGS")
            .status()
            .expect("run cargo");
        assert!(status.success(), "building plugin-sample for wasm32 failed");
        std::fs::read(target.join("wasm32-unknown-unknown/release/plugin_sample.wasm")).unwrap()
    })
}

type EvalArgs = (i32, i32, i32, i32, i32, i32, i32, i32, f32);

/// What the Phase B host glue does with one module instance.
struct Host {
    store: wasmi::Store<()>,
    instance: wasmi::Instance,
    memory: wasmi::Memory,
}

/// Generous fuel per call for setup calls.
const SETUP_FUEL: i64 = 1 << 20;

impl Host {
    fn new(metered: &[u8]) -> Self {
        let engine = wasmi::Engine::default();
        let module = wasmi::Module::new(&engine, metered).unwrap();
        assert_eq!(module.imports().count(), 0);
        let mut store = wasmi::Store::new(&engine, ());
        let instance = wasmi::Linker::<()>::new(&engine)
            .instantiate_and_start(&mut store, &module)
            .unwrap();
        let memory = instance.get_memory(&store, abi::MEMORY).unwrap();
        Self {
            store,
            instance,
            memory,
        }
    }

    fn set_fuel(&mut self, fuel: i64) {
        let f = self
            .instance
            .get_typed_func::<i64, ()>(&self.store, FUEL_SET)
            .unwrap();
        f.call(&mut self.store, fuel).unwrap();
    }

    fn fuel(&mut self) -> i64 {
        let f = self
            .instance
            .get_typed_func::<(), i64>(&self.store, FUEL_GET)
            .unwrap();
        f.call(&mut self.store, ()).unwrap()
    }

    fn call0(&mut self, name: &str) -> i32 {
        self.set_fuel(SETUP_FUEL);
        let f = self
            .instance
            .get_typed_func::<(), i32>(&self.store, name)
            .unwrap();
        f.call(&mut self.store, ()).unwrap()
    }

    fn alloc(&mut self, bytes: usize) -> i32 {
        self.set_fuel(SETUP_FUEL);
        let f = self
            .instance
            .get_typed_func::<i32, i32>(&self.store, abi::ALLOC)
            .unwrap();
        let p = f.call(&mut self.store, bytes as i32).unwrap();
        assert!(p != 0 && p % abi::STATE_ALIGN as i32 == 0, "alloc gave {p}");
        p
    }

    fn read(&self, at: i32, len: usize) -> Vec<u8> {
        let mut out = vec![0; len];
        self.memory
            .read(&self.store, at as usize, &mut out)
            .unwrap();
        out
    }

    fn write(&mut self, at: i32, bytes: &[u8]) {
        self.memory
            .write(&mut self.store, at as usize, bytes)
            .unwrap();
    }

    fn descriptor(&mut self) -> Vec<u8> {
        let p = self.call0(abi::DESCRIBE);
        let len = Descriptor::total_len(&self.read(p, HEADER_BYTES)).unwrap();
        self.read(p, len)
    }
}

/// One batch: `count` instances of a node on `bones` bones (all buffers as the ABI lays them out).
#[derive(Clone)]
struct Batch {
    kind: u32,
    count: usize,
    bones: usize,
    input: Vec<f32>,
    params: Vec<u32>,
    state: Vec<u8>,
    dt: f32,
}

fn f32_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn bytes_f32(b: &[u8]) -> Vec<f32> {
    b.chunks(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

/// Copies a batch in, evaluates it under `fuel`, copies outputs and states out. `Err` is a fault
/// (a trap or a non-zero status), on which the host would pass the input through.
fn run_wasm(host: &mut Host, b: &mut Batch, fuel: i64) -> Result<(Vec<f32>, i64), String> {
    let out_bytes = b.count * pose_bytes(b.bones);
    let input = host.alloc(b.input.len() * 4);
    let output = host.alloc(out_bytes);
    let params = host.alloc(b.params.len() * 4);
    let state = host.alloc(b.state.len());
    host.write(input, &f32_bytes(&b.input));
    let pbytes: Vec<u8> = b.params.iter().flat_map(|w| w.to_le_bytes()).collect();
    host.write(params, &pbytes);
    host.write(state, &b.state);
    host.set_fuel(fuel);
    let f = host
        .instance
        .get_typed_func::<EvalArgs, i32>(&host.store, abi::EVALUATE)
        .unwrap();
    let args = (
        b.kind as i32,
        b.count as i32,
        b.bones as i32,
        0,
        input,
        output,
        params,
        state,
        b.dt,
    );
    let status = f.call(&mut host.store, args).map_err(|e| e.to_string())?;
    if status != Status::Ok as i32 {
        return Err(format!("status {status}"));
    }
    let used = fuel - host.fuel();
    b.state = host.read(state, b.state.len());
    Ok((bytes_f32(&host.read(output, out_bytes)), used))
}

/// The same batch through the crate's own exports, natively.
fn run_native(b: &mut Batch) -> Vec<f32> {
    let mut out = vec![0f32; b.count * b.bones * BONE_FLOATS];
    // 16-aligned state copy.
    let mut state = vec![0u128; b.state.len().div_ceil(16)];
    let sb: &mut [u8] =
        unsafe { std::slice::from_raw_parts_mut(state.as_mut_ptr().cast(), state.len() * 16) };
    sb[..b.state.len()].copy_from_slice(&b.state);
    let status = unsafe {
        plugin_sample::myco_node_evaluate(
            b.kind,
            b.count as u32,
            b.bones as u32,
            std::ptr::null(),
            b.input.as_ptr(),
            out.as_mut_ptr(),
            b.params.as_ptr(),
            sb.as_mut_ptr(),
            b.dt,
        )
    };
    assert_eq!(status, Status::Ok as u32);
    let n = b.state.len();
    b.state.copy_from_slice(&sb[..n]);
    out
}

/// A pose with distinct, normalised transforms.
fn pose(bones: usize, seed: f32) -> Vec<f32> {
    let mut v = Vec::new();
    for b in 0..bones {
        let x = seed + b as f32;
        let (s, c) = ((0.1 * x).sin(), (0.1 * x).cos());
        v.extend_from_slice(&[x, 0.5 * x, -x, s, 0.0, 0.0, c, 1.0, 1.0, 1.0]);
    }
    v
}

fn batch(kind: u32, count: usize, bones: usize, params: &[u32], state_bytes: usize) -> Batch {
    let input = (0..count)
        .flat_map(|i| pose(bones, i as f32 * 3.0))
        .collect();
    Batch {
        kind,
        count,
        bones,
        input,
        params: (0..count).flat_map(|_| params.iter().copied()).collect(),
        state: vec![0; count * state_stride(state_bytes)],
        dt: 1.0 / 30.0,
    }
}

fn metered() -> Vec<u8> {
    meter(module(), &Limits::default()).unwrap()
}

/// wasmi's unoptimised executor needs more stack than the harness's default.
fn big_stack(f: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn builds_validates_and_meters() {
    let info = validate(module(), &Limits::default()).unwrap();
    assert!(info.functions >= 4);
    assert_eq!(
        info.memory_maximum,
        Limits::default().max_memory_pages,
        "rustc declares no maximum"
    );
    assert_eq!(metered(), metered(), "deterministic");
}

#[test]
fn describes_its_nodes() {
    big_stack(|| {
        let mut host = Host::new(&metered());
        assert_eq!(host.call0(abi::ABI_VERSION_FN), abi::ABI_VERSION as i32);
        let blob = host.descriptor();
        // The wasm module's blob is the one the crate builds natively.
        let native = {
            let p = plugin_sample::myco_node_describe();
            let len = Descriptor::total_len(unsafe { std::slice::from_raw_parts(p, HEADER_BYTES) })
                .unwrap();
            unsafe { std::slice::from_raw_parts(p, len) }.to_vec()
        };
        assert_eq!(blob, native);
        let d = Descriptor::parse(&blob).unwrap();
        let names: Vec<_> = d
            .nodes()
            .map(|n| (n.kind, n.name, n.inputs, n.state_bytes))
            .collect();
        assert_eq!(names, [(1, "sway", 1, 4), (2, "scale", 1, 0)]);
        let sway: Vec<_> = d
            .node(Sway::KIND)
            .unwrap()
            .params()
            .checked()
            .map(|p| (p.name, p.kind, p.unit))
            .collect();
        assert_eq!(
            sway,
            [
                ("amplitude", ParamKind::Float, Unit::Degrees),
                ("frequency", ParamKind::Float, Unit::Hertz),
                ("axis", ParamKind::Vec3, Unit::None),
                ("first_bone", ParamKind::Int, Unit::None),
                ("falloff", ParamKind::Float, Unit::Ratio),
            ]
        );
        assert!(d
            .node(Scale::KIND)
            .unwrap()
            .params()
            .checked()
            .all(|p| p.is_animatable()));
    });
}

/// Parameter blocks built from the descriptor's defaults, as the core does for unset parameters.
fn defaults(kind: u32) -> Vec<u32> {
    let blob = {
        let p = plugin_sample::myco_node_describe();
        let len =
            Descriptor::total_len(unsafe { std::slice::from_raw_parts(p, HEADER_BYTES) }).unwrap();
        unsafe { std::slice::from_raw_parts(p, len) }
    };
    let d = Descriptor::parse(blob).unwrap();
    d.node(kind)
        .unwrap()
        .params()
        .checked()
        .flat_map(|p| p.default[..p.kind.words()].to_vec())
        .collect()
}

#[test]
fn scale_scales_translations_in_wasm() {
    big_stack(|| {
        let mut host = Host::new(&metered());
        let mut b = batch(Scale::KIND, 4, 7, &[2.5f32.to_bits()], 0);
        let (out, used) = run_wasm(&mut host, &mut b.clone(), 1 << 30).unwrap();
        assert!(used > 0);
        for (o, i) in out.chunks(BONE_FLOATS).zip(b.input.chunks(BONE_FLOATS)) {
            assert_eq!(&o[..3], &[i[0] * 2.5, i[1] * 2.5, i[2] * 2.5]);
            assert_eq!(&o[3..], &i[3..], "rotation and scale pass through");
        }
        assert_eq!(run_native(&mut b), out, "wasm and native agree bit for bit");
        assert_eq!(defaults(Scale::KIND), [1f32.to_bits()]);
    });
}

#[test]
fn sway_matches_native_bit_for_bit_over_frames() {
    big_stack(|| {
        let mut host = Host::new(&metered());
        let mut p = defaults(Sway::KIND);
        p[0] = 30f32.to_bits(); // amplitude, degrees
        p[1] = 1.3f32.to_bits(); // frequency
        let mut wasm = batch(Sway::KIND, 3, 9, &p, 4);
        let mut native = wasm.clone();
        let mut costs = Vec::new();
        for _ in 0..20 {
            let (w, used) = run_wasm(&mut host, &mut wasm, 1 << 30).unwrap();
            costs.push(used);
            assert_eq!(run_native(&mut native), w);
            assert_eq!(wasm.state, native.state, "the phase advances the same way");
        }
        assert!(costs.iter().all(|&c| c > 0));
    });
}

#[test]
fn sway_rotates_the_chain_with_falloff() {
    // Native, through the exports: phase reaches 0.25 after one step, so the first bone turns by
    // the full amplitude about +z and each later bone by falloff times the previous.
    let mut p = defaults(Sway::KIND);
    p[0] = 20f32.to_bits();
    p[1] = 1f32.to_bits();
    let mut b = batch(Sway::KIND, 1, 4, &p, 4);
    for t in b.input.chunks_mut(BONE_FLOATS) {
        t[3..7].copy_from_slice(&[0.0, 0.0, 0.0, 1.0]);
    }
    b.dt = 0.25;
    let out = run_native(&mut b);
    assert_eq!(f32::from_le_bytes(b.state[..4].try_into().unwrap()), 0.25);
    let amplitude = 20f32.to_radians();
    for (bone, t) in out.chunks(BONE_FLOATS).enumerate() {
        let angle = if bone == 0 {
            0.0
        } else {
            amplitude * 0.8f32.powi(bone as i32 - 1)
        };
        let expected = [0.0, 0.0, (angle / 2.0).sin(), (angle / 2.0).cos()];
        for k in 0..4 {
            // The plugin's polynomial sine is within 4e-6 of libm's.
            assert!(
                (t[3 + k] - expected[k]).abs() < 1e-5,
                "bone {bone}: {:?} vs {expected:?}",
                &t[3..7]
            );
        }
        assert_eq!(
            &t[..3],
            &b.input[bone * BONE_FLOATS..][..3],
            "translations untouched"
        );
    }
}

#[test]
fn a_small_budget_faults_and_unknown_kinds_report() {
    big_stack(|| {
        let metered = metered();
        let mut host = Host::new(&metered);
        let mut b = batch(Sway::KIND, 2, 30, &defaults(Sway::KIND), 4);
        let (_, used) = run_wasm(&mut host, &mut b.clone(), 1 << 30).unwrap();
        // A fresh instance (a trapped one is discarded) with one unit less than the batch needs.
        let mut fresh = Host::new(&metered);
        let err = run_wasm(&mut fresh, &mut b.clone(), used - 1).unwrap_err();
        assert!(err.contains("unreachable"), "{err}");
        assert!(
            fresh.fuel() < 0,
            "the host tells exhaustion from other faults by the counter"
        );
        let mut exact = Host::new(&metered);
        assert_eq!(run_wasm(&mut exact, &mut b, used).unwrap().1, used);

        let mut unknown = batch(99, 1, 2, &[], 0);
        assert_eq!(
            run_wasm(&mut host, &mut unknown, 1 << 20).unwrap_err(),
            format!("status {}", Status::UnknownKind as i32)
        );
    });
}
