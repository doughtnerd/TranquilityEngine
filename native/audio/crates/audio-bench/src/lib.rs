//! The audio core's lab benchmark (ADR 0157 A3.5; architecture §6.5 "Lab" and "Content").
//!
//! Drives a real [`Core`] the way the worklet does (BATCH messages through `scheduler::submit`,
//! stream chunks through the ring, `process`, `status::after_quantum`, `clips::flush_events`, and a
//! STATUS take every 6 quanta) and times each quantum's audio-thread work. The same code runs
//! natively (`cargo run --release -p audio-bench -- …`) and as wasm in Node
//! (`node tools/audio-bench/run.mjs …`, built with `+simd128` like the shipped mixer), so the two
//! targets measure the same scenes.
//!
//! Modes (arguments are `key=value` words):
//! - `mode=scene name=<scene> [seconds=60] [warmup=5] [runs=5] [seed=1] [pace=0]`: the frozen
//!   scenes ([`scene`]): per-quantum p50/p99/p99.9/max per run, and the modelled work units.
//! - `mode=fit [seconds=10] [runs=3]`: the coefficient sweeps ([`sweeps`]): each varies one term
//!   of architecture §6.1's formula with everything else fixed; prints each variant and the
//!   least-squares slope (µs per unit), from which `cap::wu` is set.
//! - `mode=memory`: the fixed regions per preset (architecture §5.1).
//!
//! `pace=1` sleeps to the next 2.667 ms deadline after each quantum (as a real device period
//! would), so other work on the machine can evict the core's caches between quanta; unpaced runs
//! render back to back (warmer caches, so lower numbers).
//!
//! Content (§6.5): int16 stereo clips at the context rate, ≥ 64 MB of distinct clips read in
//! shuffled order (cache-cold), one-shots restarted as they end (the start rate is set by their
//! length), 32 buses with effects, the reverb, the limiter at its default 1.5 ms look-ahead, HRTF
//! static or moving, streams fed 4,096 frames at a time.

use audio_core::clips::{self, ClipFormat};
use audio_core::layout::{Layout, RegionKind, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{scheduler, status, Core, QUANTUM};
use audio_wire::generated as wire;

// --- Platform ------------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
mod platform {
    #[link(wasm_import_module = "env")]
    extern "C" {
        /// `performance.now()` in ms.
        fn bench_now() -> f64;
        /// Prints `len` UTF-8 bytes at `ptr` as one line.
        fn bench_print(ptr: *const u8, len: usize);
        /// Sleeps `ms` (Atomics.wait in Node).
        fn bench_sleep(ms: f64);
    }
    pub fn now_us() -> f64 {
        // SAFETY: an import with no preconditions.
        unsafe { bench_now() * 1000.0 }
    }
    pub fn print(s: &str) {
        // SAFETY: `s` is valid for its length during the call.
        unsafe { bench_print(s.as_ptr(), s.len()) }
    }
    pub fn sleep_us(us: f64) {
        // SAFETY: an import with no preconditions.
        unsafe { bench_sleep(us / 1000.0) }
    }
    pub const TARGET: &str = "wasm";
}

#[cfg(not(target_arch = "wasm32"))]
mod platform {
    use std::sync::OnceLock;
    use std::time::Instant;
    static T0: OnceLock<Instant> = OnceLock::new();
    pub fn now_us() -> f64 {
        T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1e6
    }
    pub fn print(s: &str) {
        println!("{s}");
    }
    pub fn sleep_us(us: f64) {
        std::thread::sleep(std::time::Duration::from_secs_f64(us / 1e6));
    }
    pub const TARGET: &str = "native";
}

pub use platform::TARGET;

/// The wasm entry: `args` is the argument string at `ptr` (written into memory from
/// [`bench_alloc`]).
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn bench_main(ptr: *const u8, len: usize) {
    // SAFETY: the runner wrote `len` bytes at `ptr`, from `bench_alloc`.
    let args = unsafe { core::str::from_utf8_unchecked(core::slice::from_raw_parts(ptr, len)) };
    main(args);
}

/// Room for the runner's argument string.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn bench_alloc(len: usize) -> *mut u8 {
    Box::leak(vec![0u8; len].into_boxed_slice()).as_mut_ptr()
}

// --- Scenes --------------------------------------------------------------------------------

/// The context rate of every scene.
pub const RATE: f32 = 48_000.0;
/// Quanta between batches (≈ one 60 Hz frame) and STATUS takes (architecture §4.7: every 6).
const BATCH_EVERY: u64 = 6;
/// A device period at 48 kHz, for `pace=1`.
const PERIOD_US: f64 = QUANTUM as f64 / RATE as f64 * 1e6;
/// First stream id (a reserved high range, as main's).
const STREAM_ID: u32 = 0xFFFF_0100;
/// Frames per stream chunk (architecture §4.7).
const STREAM_CHUNK: u32 = 4_096;

/// One benchmark scene. Mixed voices include the streams.
#[derive(Clone, Debug)]
pub struct Scene {
    pub name: String,
    /// `InitParams`: the preset's logical and mixed voices.
    pub max_logical: u32,
    pub max_mixed: u32,
    /// Mixed voices kept playing (main's selection result), streams included.
    pub mixed: u32,
    /// Looping virtual voices besides the mixed ones.
    pub virtual_voices: u32,
    /// Mixed voices are one-shots restarted as they end (else looping, one distinct clip each).
    pub one_shots: bool,
    /// One-shot starts per second at pitch 1 (sets the one-shots' mean length: mixed ÷ starts).
    pub starts_per_sec: f32,
    /// Each voice's pitch, log-uniform in `[lo, hi]`.
    pub pitch: (f32, f32),
    /// Distinct clip memory (MB of int16 stereo).
    pub clip_mb: u32,
    /// Configured buses (1 = just the root's child), each with `biquads` (0, 1 or 2: lowpass,
    /// highpass), a compressor and the snapshot low-pass when asked.
    pub buses: u32,
    pub biquads: u32,
    pub compressor: bool,
    pub snapshot_lp: bool,
    /// The shared reverb on, fed by `reverb_sends` buses.
    pub reverb: bool,
    pub reverb_sends: u32,
    /// HRTF voices among the mixed, static or turning.
    pub hrtf: u32,
    pub moving: bool,
    /// Stream voices among the mixed.
    pub streams: u32,
    /// Every batch sends SET_PARAMS (gain and direction) for every mixed voice.
    pub updates: bool,
    /// Those updates ramp over the frame (else they apply at once, so the pan matrix settles).
    pub ramps: bool,
    /// The adaptive cap acts on the production budget (else its budget is unlimited) and main
    /// obeys `mixedCap`.
    pub cap: bool,
}

impl Scene {
    fn base(name: &str) -> Scene {
        Scene {
            name: name.to_string(),
            max_logical: 4_096,
            max_mixed: 256,
            mixed: 0,
            virtual_voices: 0,
            one_shots: false,
            starts_per_sec: 200.0,
            pitch: (1.0, 1.0),
            clip_mb: 64,
            buses: 1,
            biquads: 0,
            compressor: false,
            snapshot_lp: false,
            reverb: false,
            reverb_sends: 0,
            hrtf: 0,
            moving: false,
            streams: 0,
            updates: false,
            ramps: true,
            cap: false,
        }
    }

    /// A preset's full scene (architecture §6.5 "Content"): mixed one-shots at 200 starts per
    /// second over 64 MB of clips, pitch 0.5–2, the rest of the logical voices virtual and
    /// looping, 32 buses each with lowpass, highpass, compressor and snapshot low-pass, the reverb
    /// fed by 8 of them, HRTF voices turning, the preset's streams, per-frame parameter updates.
    fn preset(name: &str, logical: u32, mixed: u32, hrtf: u32, streams: u32) -> Scene {
        Scene {
            max_logical: logical,
            max_mixed: mixed,
            mixed,
            virtual_voices: logical - mixed - 64,
            one_shots: true,
            pitch: (0.5, 2.0),
            buses: 32,
            biquads: 2,
            compressor: true,
            snapshot_lp: true,
            reverb: true,
            reverb_sends: 8,
            hrtf,
            moving: true,
            streams,
            updates: true,
            ..Scene::base(name)
        }
    }
}

/// The frozen scenes by name.
pub fn scene(name: &str) -> Option<Scene> {
    let s = match name {
        // The presets (owner-review 1; voices.hrtf 16 / 32; streams 8 / 16 by max_mixed / 16).
        "default" => Scene::preset(name, 4_096, 128, 16, 8),
        "high" => Scene::preset(name, 8_192, 256, 32, 16),
        "low" => Scene::preset(name, 1_024, 48, 4, 4),
        // The high preset with its HRTF voices still.
        "high-static" => Scene { moving: false, ..Scene::preset(name, 8_192, 256, 32, 16) },
        // Alternatives if high misses the budget: 16 HRTF voices, or 192 mixed.
        "high-hrtf16" => Scene::preset(name, 8_192, 256, 16, 16),
        "high-mixed192" => Scene { mixed: 192, ..Scene::preset(name, 8_192, 256, 32, 16) },
        // The high preset with pitch 1–16 (§6.5's worst case for the resampler's reads).
        "high-pitch16" => Scene { pitch: (1.0, 16.0), ..Scene::preset(name, 8_192, 256, 32, 16) },
        // The high preset with the adaptive cap acting on the production budget.
        "high-cap" => Scene { cap: true, ..Scene::preset(name, 8_192, 256, 32, 16) },
        "default-cap" => Scene { cap: true, ..Scene::preset(name, 4_096, 128, 16, 8) },
        _ => return None,
    };
    Some(s)
}

/// One coefficient sweep: scenes that vary one term, and the term's value per run.
pub struct Sweep {
    pub term: &'static str,
    pub unit: &'static str,
    pub scenes: Vec<Scene>,
    pub x: fn(&RunResult) -> f64,
}

/// The sweeps that fit architecture §6.1's terms (and `cap::wu`).
pub fn sweeps() -> Vec<Sweep> {
    let looping = |name: String, mixed: u32| Scene { mixed, ..Scene::base(&name) };
    let mut out = Vec::new();
    // Mixed voices at pitch 1, each looping its own clip of 64 MB / mixed (cache-cold), one bus.
    out.push(Sweep {
        term: "mixed",
        unit: "µs per mixed voice (pitch 1)",
        scenes: [0u32, 64, 128, 192, 256].iter().map(|&m| looping(format!("mixed-{m}"), m)).collect(),
        x: |r| r.mean_mixed,
    });
    // Cache: 128 mixed voices over 1 MB of clips (warm) and 64 MB (cold); x = MB.
    out.push(Sweep {
        term: "cache",
        unit: "µs per MB of distinct clips (128 voices)",
        scenes: [1u32, 64].iter().map(|&mb| Scene { clip_mb: mb, ..looping(format!("clips-{mb}mb"), 128) }).collect(),
        x: |r| r.clip_mb as f64,
    });
    // Pitch: 128 mixed voices at pitch 1–16; x = source frames read ÷ 128.
    out.push(Sweep {
        term: "pitch",
        unit: "µs per 128 source frames",
        scenes: [1.0f32, 2.0, 4.0, 8.0, 16.0].iter().map(|&p| Scene { pitch: (p, p), ..looping(format!("pitch-{p}"), 128) }).collect(),
        x: |r| r.mean_source_frames / QUANTUM as f64,
    });
    // Virtual voices keeping time.
    out.push(Sweep {
        term: "virtual",
        unit: "µs per virtual voice",
        scenes: [0u32, 2_048, 4_096, 8_064]
            .iter()
            .map(|&v| Scene { max_logical: 8_192, virtual_voices: v, ..looping(format!("virtual-{v}"), 16) })
            .collect(),
        x: |r| r.mean_live - r.mean_mixed,
    });
    // Buses without effects (32 mixed voices spread over them).
    out.push(Sweep {
        term: "bus",
        unit: "µs per bus",
        scenes: [1u32, 8, 16, 32].iter().map(|&b| Scene { buses: b, ..looping(format!("bus-{b}"), 32) }).collect(),
        x: |r| r.buses as f64,
    });
    // Biquads: 32 buses × 0, 1, 2.
    out.push(Sweep {
        term: "biquad",
        unit: "µs per biquad",
        scenes: [0u32, 1, 2].iter().map(|&n| Scene { buses: 32, biquads: n, ..looping(format!("biquad-{n}"), 32) }).collect(),
        x: |r| 32.0 * r.biquads as f64,
    });
    // The snapshot low-pass on 32 buses.
    out.push(Sweep {
        term: "snapshot_lp",
        unit: "µs per bus low-pass",
        scenes: [false, true].iter().map(|&on| Scene { buses: 32, snapshot_lp: on, ..looping(format!("snapshot-{on}"), 32) }).collect(),
        x: |r| if r.snapshot_lp { 32.0 } else { 0.0 },
    });
    // Compressors on 32 buses.
    out.push(Sweep {
        term: "compressor",
        unit: "µs per compressor",
        scenes: [false, true].iter().map(|&on| Scene { buses: 32, compressor: on, ..looping(format!("compressor-{on}"), 32) }).collect(),
        x: |r| if r.compressor { 32.0 } else { 0.0 },
    });
    // The reverb (one send).
    out.push(Sweep {
        term: "reverb",
        unit: "µs for the reverb",
        scenes: [false, true].iter().map(|&on| Scene { reverb: on, reverb_sends: on as u32, ..looping(format!("reverb-{on}"), 32) }).collect(),
        x: |r| r.reverb as u32 as f64,
    });
    // Reverb sends on 32 buses (reverb on).
    out.push(Sweep {
        term: "reverb_send",
        unit: "µs per send",
        scenes: [1u32, 32].iter().map(|&n| Scene { buses: 32, reverb: true, reverb_sends: n, ..looping(format!("sends-{n}"), 32) }).collect(),
        x: |r| r.reverb_sends as f64,
    });
    // HRTF voices, still (32 mixed, n flagged).
    out.push(Sweep {
        term: "hrtf_static",
        unit: "µs per HRTF voice (still)",
        scenes: [0u32, 8, 16, 32].iter().map(|&n| Scene { hrtf: n, ..looping(format!("hrtf-static-{n}"), 32) }).collect(),
        x: |r| r.mean_hrtf,
    });
    // HRTF voices turning (see `fit_moving`).
    out.push(Sweep {
        term: "hrtf_moving",
        unit: "µs per HRTF voice (turning)",
        scenes: [8u32, 16, 32].iter().map(|&n| Scene { hrtf: n, moving: true, ..looping(format!("hrtf-moving-{n}"), 32) }).collect(),
        x: |r| r.mean_hrtf,
    });
    // Records: per-frame SET_PARAMS for 256 mixed voices, off and on, applied at once.
    out.push(Sweep {
        term: "record",
        unit: "µs per record",
        scenes: [false, true].iter().map(|&on| Scene { updates: on, ramps: false, ..looping(format!("records-{on}"), 256) }).collect(),
        x: |r| r.records_per_quantum,
    });
    // Moving voices: the same updates ramping over the frame (the pan matrix's per-frame path).
    out.push(Sweep {
        term: "moving",
        unit: "µs per moving mixed voice",
        scenes: [false, true].iter().map(|&on| Scene { updates: true, ramps: on, ..looping(format!("ramps-{on}"), 256) }).collect(),
        x: |r| r.mean_moving,
    });
    // Streams: 32 mixed voices of which 0, 8, 16 are streams.
    out.push(Sweep {
        term: "stream",
        unit: "µs per stream voice over a clip voice",
        scenes: [0u32, 8, 16].iter().map(|&s| Scene { streams: s, ..looping(format!("streams-{s}"), 32) }).collect(),
        x: |r| r.streams as f64,
    });
    // One-shots at 200 starts per second against looping voices (128 mixed): start cost.
    out.push(Sweep {
        term: "starts",
        unit: "µs per start",
        scenes: [false, true].iter().map(|&on| Scene { one_shots: on, ..looping(format!("oneshots-{on}"), 128) }).collect(),
        x: |r| r.starts_per_quantum,
    });
    out
}

// --- Running -------------------------------------------------------------------------------

/// xorshift32.
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in [0, 1).
    fn unit(&mut self) -> f32 {
        (self.next() >> 8) as f32 / (1u32 << 24) as f32
    }
    fn below(&mut self, n: u32) -> u32 {
        ((self.next() as u64 * n as u64) >> 32) as u32
    }
}

/// A finished run.
#[derive(Clone, Debug, Default)]
pub struct RunResult {
    pub quanta: usize,
    pub p50: f64,
    pub p99: f64,
    pub p999: f64,
    pub max: f64,
    pub mean: f64,
    /// The quanta without a batch or STATUS take (4 of every 6): their p99 and p99.9.
    pub p99_quiet: f64,
    pub p999_quiet: f64,
    pub mean_mixed: f64,
    pub mean_live: f64,
    pub mean_hrtf: f64,
    pub mean_crossfading: f64,
    pub mean_kernels: f64,
    pub mean_source_frames: f64,
    pub mean_moving: f64,
    pub records_per_quantum: f64,
    pub starts_per_quantum: f64,
    pub wu_mean: f64,
    pub wu_p99: f64,
    pub wu_max: f64,
    pub cap_min: u32,
    pub cap_last: u32,
    /// Most kernel computations the bank's budget counted in one quantum.
    pub budget_max: u32,
    pub demoted: u32,
    pub buses: u32,
    pub clip_mb: u32,
    pub biquads: u32,
    pub snapshot_lp: bool,
    pub compressor: bool,
    pub reverb: bool,
    pub reverb_sends: u32,
    pub streams: u32,
    /// Per quantum (µs), plus the HRTF terms, for the moving fit.
    pub times: Vec<f32>,
    pub crossfading: Vec<u8>,
    pub kernels: Vec<u8>,
    pub hrtf: Vec<u8>,
}

/// A main-side voice.
#[derive(Clone, Copy)]
struct Voice {
    id: u32,
    mixed: bool,
    hrtf: bool,
    /// Index in `Bench::mixed_ids` while mixed.
    at: u32,
    phase: f32,
}

struct Bench {
    core: Core,
    block: (*mut u8, std::alloc::Layout),
    rng: Rng,
    scene: Scene,
    /// Per clip id (1-based): frames.
    clip_frames: Vec<u32>,
    /// Shuffled order of one-shot clips and the next index into it.
    order: Vec<u32>,
    next_clip: usize,
    voices: Vec<Option<Voice>>,
    gens: Vec<u16>,
    free: Vec<u32>,
    mixed_ids: Vec<u32>,
    hrtf_now: u32,
    /// Records waiting for their batch, and the batch buffer.
    recs: Vec<u8>,
    rec_count: u32,
    /// Records held back from setup (submitted at most 2,048 a batch).
    setup: Vec<Vec<u8>>,
    stream_fed: Vec<u64>,
    stream_data: Vec<f32>,
    records_sent: u64,
    starts: u64,
}

/// The scene's init parameters. The arena's initial reserve holds all of the scene's clips (with
/// the size classes' rounding) and the HRTF bank, so it never grows and the block can be freed
/// after the run (wasm memory can't shrink; runs would otherwise pile up past 4 GB).
fn init_params(s: &Scene) -> InitParams {
    let arena_mb = s.clip_mb + s.clip_mb / 2 + 16;
    InitParams { sample_rate: RATE, max_logical: s.max_logical, max_mixed: s.max_mixed, max_buses: 32, arena_initial_bytes: arena_mb << 20 }
}

/// A core over a fresh zeroed block; returns the block to free after the core is dropped.
fn new_core(p: InitParams) -> (Core, *mut u8, std::alloc::Layout) {
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size; zeroed and page-aligned as `Core::new` needs.
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    assert!(!base.is_null(), "the block");
    // SAFETY: a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES; it outlives
    // the core (freed only after the core is dropped, `Bench::free`).
    (unsafe { Core::new(p, layout, base) }, base, block)
}

/// The shipped HRIR asset (44.1 kHz, delays in).
static HRIR_ASSET: &[u8] = include_bytes!("../../../../../src/plugins/audio/runtime/wasm/myco_hrir.bin");

/// The shipped table at `rate` as main would send it: delays extracted (H5), responses resampled
/// by nearest frame (cost is independent of the responses' values; listening needs `hrir.ts`).
fn hrir_table(rate: f32) -> Vec<u8> {
    use audio_dsp::hrtf::database::{encode, HrirHeader};
    let header = HrirHeader::read(HRIR_ASSET).unwrap();
    let n = header.ir_length as usize;
    let dirs = header.directions();
    let ratio = rate / header.rate;
    let out_len = (n as f32 * ratio).ceil() as usize;
    let mut scratch = audio_dsp::hrtf::HrtfScratch::new();
    let mut delays = vec![0.0f32; dirs * 2];
    let mut irs = vec![0i16; dirs * out_len * 2];
    let mut ir = vec![0.0f32; n];
    for d in 0..dirs {
        for ear in 0..2 {
            for (f, s) in ir.iter_mut().enumerate() {
                let at = 16 + ((d * n + f) * 2 + ear) * 2;
                *s = i16::from_le_bytes([HRIR_ASSET[at], HRIR_ASSET[at + 1]]) as f32 / 32768.0;
            }
            delays[d * 2 + ear] = audio_dsp::hrtf::kernel::extract_average_group_delay(&mut ir, &mut scratch) * ratio;
            for f in 0..out_len {
                let s = ir.get((f as f32 / ratio) as usize).copied().unwrap_or(0.0);
                irs[(d * out_len + f) * 2 + ear] = (s * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
            }
        }
    }
    let out_header = HrirHeader { ir_length: out_len as u32, rate, ..header };
    let mut bytes = vec![0u8; out_header.byte_len()];
    encode(&out_header, &delays, &irs, &mut bytes).unwrap();
    bytes
}

fn load_hrir(core: &mut Core, bytes: &[u8]) {
    let id = wire::HRIR_CLIP_ID_FIRST;
    assert_eq!(clips::reserve(core, id, (bytes.len() / 2) as u32, 1, RATE, wire::clip_format::HRIR), wire::ERR_OK);
    for (k, chunk) in bytes.chunks(clips::MAX_CHUNK_BYTES).enumerate() {
        let at = (k * clips::MAX_CHUNK_BYTES / 2) as u32;
        let p = clips::chunk_ptr(core, id, at, chunk.len() as u32);
        assert!(!p.is_null());
        // SAFETY: chunk_ptr gave room for `chunk.len()` bytes.
        unsafe { core::ptr::copy_nonoverlapping(chunk.as_ptr(), p, chunk.len()) };
        assert_eq!(clips::commit(core, id, at, chunk.len() as u32), wire::ERR_OK);
    }
    assert!(core.clips().hrtf_bank().is_some(), "the HRTF bank");
}

impl Bench {
    fn new(scene: &Scene, seed: u32, hrir: Option<&[u8]>) -> Bench {
        let (mut core, base, block) = new_core(init_params(scene));
        core.clips_mut().set_ceiling(usize::MAX);
        // Growth would take memory the block's free can't return: refuse it (a scene that needs it
        // fails its reserve loudly).
        core.clips_mut().set_grow(|_| None);
        if !scene.cap {
            // Unlimited budget: the cap never acts, so every scene keeps its voices.
            core.cap_mut().set_budget(u32::MAX);
        }
        let mut rng = Rng(seed.wrapping_mul(2_654_435_761).max(1));
        // Clips: int16 stereo noise at the context rate.
        let bytes_total = scene.clip_mb as usize * (1 << 20);
        let (count, mean_frames) = if scene.one_shots {
            let frames = ((scene.mixed.max(1) as f32 / scene.starts_per_sec) * RATE).max(4_096.0) as usize;
            (bytes_total.div_ceil(frames * 4).max(1), frames)
        } else {
            let n = (scene.mixed - scene.streams).max(1) as usize;
            (n, (bytes_total / n / 4).max(4_096))
        };
        let mut clip_frames = vec![0u32];
        let mut buf: Vec<u8> = Vec::new();
        for id in 1..=count as u32 {
            let frames = if scene.one_shots { (mean_frames as f32 * (0.5 + rng.unit())) as u32 } else { mean_frames as u32 };
            core.clips_mut().reserve(id, frames, 2, RATE, ClipFormat::I16).expect("clip reserve");
            buf.clear();
            buf.reserve(frames as usize * 4);
            for _ in 0..frames as usize * 2 {
                let s = (rng.next() >> 16) as i16 / 16;
                buf.extend_from_slice(&s.to_le_bytes());
            }
            core.clips_mut().write(id, 0, &buf).expect("clip write");
            clip_frames.push(frames);
        }
        if scene.hrtf > 0 {
            load_hrir(&mut core, hrir.expect("the HRIR table"));
        }
        let mut b = Bench {
            core,
            block: (base, block),
            rng,
            scene: scene.clone(),
            order: (1..=count as u32).collect(),
            next_clip: count,
            clip_frames,
            voices: vec![None; scene.max_logical as usize],
            gens: vec![0; scene.max_logical as usize],
            free: (0..scene.max_logical).rev().collect(),
            mixed_ids: Vec::new(),
            hrtf_now: 0,
            recs: Vec::new(),
            rec_count: 0,
            setup: Vec::new(),
            stream_fed: vec![0; scene.streams as usize],
            stream_data: Vec::new(),
            records_sent: 0,
            starts: 0,
        };
        b.stream_data = (0..STREAM_CHUNK as usize * 2).map(|_| (b.rng.unit() - 0.5) * 0.1).collect();
        b.configure();
        b
    }

    /// BUS_CONFIG, BUS_MIX and MASTER, the streams, the looping and first mixed voices.
    fn configure(&mut self) {
        let s = self.scene.clone();
        let mut buses = Vec::new();
        for i in 0..s.buses {
            // Bus 0 under the root; 1–3 groups under it; the rest under the groups.
            let parent = match i {
                0 => wire::BUS_ROOT as u16,
                1..=3 => 0,
                _ => (1 + i % 3) as u16,
            };
            let mut effects = Vec::new();
            let fx = |t: u32, p0: f32, p1: f32| wire::BusConfigBusesEffects { type_: t, p: [p0, p1, 0.0, 0.0, 0.0, 0.0, 0.0] };
            if s.biquads >= 1 {
                effects.push(fx(wire::effect_type::LOWPASS, 9_000.0 + 50.0 * i as f32, 0.7));
            }
            if s.biquads >= 2 {
                effects.push(fx(wire::effect_type::HIGHPASS, 60.0 + i as f32, 0.7));
            }
            if s.compressor {
                effects.push(fx(wire::effect_type::COMPRESSOR, -24.0, 12.0));
            }
            if s.reverb && i < s.reverb_sends.max(1) && s.reverb_sends > 0 {
                effects.push(fx(wire::effect_type::REVERB_SEND, 0.2, 0.0));
            }
            buses.push(wire::BusConfigBuses { parent, effects });
        }
        self.push(&wire::BusConfig { voice_id: 0, frame_offset: wire::ASAP, buses });
        let lp = if s.snapshot_lp { 6_000.0 } else { wire::BUS_LP_OFF_HZ as f32 };
        let mix = wire::BusMix { voice_id: 0, frame_offset: wire::ASAP, ramp_frames: 0, buses: (0..s.buses).map(|_| wire::BusMixBuses { gain: 0.9, lp_hz: lp }).collect() };
        self.push(&mix);
        self.push(&wire::Master { voice_id: 0, frame_offset: wire::ASAP, volume: 0.5, muted: 0, ramp_frames: 0 });
        self.flush_setup();
        for k in 0..s.streams {
            let id = STREAM_ID + k;
            self.start(Some(id), true);
            let o = wire::StreamOpen { stream_id: id, channels: 2, sample_rate: RATE, total_frames: u32::MAX, epoch: 1, ..Default::default() };
            assert!(self.core.streams_mut().open(&o), "stream open");
        }
        for _ in 0..s.virtual_voices {
            self.start(None, false);
            if self.rec_count >= 2_048 {
                self.flush_setup();
            }
        }
        self.flush_setup();
        while (self.mixed_ids.len() as u32) < s.mixed {
            self.start(None, true);
            if self.rec_count >= 2_048 {
                self.flush_setup();
            }
        }
        self.flush_setup();
    }

    fn flush_setup(&mut self) {
        if self.rec_count > 0 {
            let msg = self.take_batch(0.0);
            self.setup.push(msg);
        }
    }

    fn push<R: WireRecord>(&mut self, r: &R) {
        let at = self.recs.len();
        self.recs.resize(at + 4096, 0);
        let n = r.write_to(&mut self.recs, at);
        self.recs.truncate(at + n);
        self.rec_count += 1;
    }

    /// The batch of the waiting records (envelope and header first).
    fn take_batch(&mut self, first_frame: f64) -> Vec<u8> {
        let mut msg = vec![0u8; 32];
        msg.extend_from_slice(&self.recs);
        wire::Envelope::new(wire::kind::BATCH, 1, (msg.len() - 16) as u32).write(&mut msg, 0).unwrap();
        wire::BatchHeader { first_frame, count: self.rec_count, flags: 0 }.write(&mut msg, 0).unwrap();
        self.recs.clear();
        self.rec_count = 0;
        msg
    }

    fn next_clip(&mut self) -> u32 {
        if self.next_clip >= self.order.len() {
            // Reshuffle (Fisher–Yates): each clip once per cycle, in a new order.
            for i in (1..self.order.len()).rev() {
                let j = self.rng.below(i as u32 + 1) as usize;
                self.order.swap(i, j);
            }
            self.next_clip = 0;
        }
        self.next_clip += 1;
        self.order[self.next_clip - 1]
    }

    fn pitch(&mut self) -> f32 {
        let (lo, hi) = self.scene.pitch;
        if lo == hi {
            lo
        } else {
            lo * libm::powf(hi / lo, self.rng.unit())
        }
    }

    /// Starts a voice: a stream voice (`stream`), a mixed voice (one-shot or looping by the scene)
    /// or a looping virtual one.
    fn start(&mut self, stream: Option<u32>, mixed: bool) {
        let Some(index) = self.free.pop() else { return };
        let g = &mut self.gens[index as usize];
        *g = g.wrapping_add(1).max(1);
        let id = ((*g as u32) << 16) | index;
        let s = self.scene.clone();
        let looping = stream.is_some() || !mixed || !s.one_shots;
        let hrtf = mixed && self.hrtf_now < s.hrtf;
        let clip = match stream {
            Some(sid) => sid,
            None if mixed && !s.one_shots => {
                // Looping mixed voices each read their own clip.
                let n = (self.clip_frames.len() - 1) as u32;
                1 + (self.mixed_ids.len() as u32 % n)
            }
            None if mixed => self.next_clip(),
            None => 1 + self.rng.below((self.clip_frames.len() - 1) as u32),
        };
        let bus = self.rng.below(s.buses) as u16;
        let phase = self.rng.unit() * 6.283;
        let mut flags = wire::PLAY_FLAGS_SPATIAL;
        if looping {
            flags |= wire::PLAY_FLAGS_LOOP;
        }
        if stream.is_some() {
            flags |= wire::PLAY_FLAGS_STREAM;
        }
        if mixed {
            flags |= wire::PLAY_FLAGS_MIXED;
        }
        if hrtf {
            flags |= (wire::panner::HRTF as u16) << wire::PLAY_FLAGS_PANNER_SHIFT;
        }
        let frames = if stream.is_some() { 0 } else { self.clip_frames[clip as usize] };
        // Looping and first voices start anywhere in their clip, so ends spread out.
        let offset = if frames > 0 && (looping || self.starts == 0) { self.rng.below(frames) } else { 0 };
        let pitch = if stream.is_some() { 1.0 } else { self.pitch() };
        let score = self.rng.unit();
        self.push(&wire::Play {
            voice_id: id,
            frame_offset: wire::ASAP,
            clip,
            bus,
            flags,
            gain: 0.3,
            pitch,
            dir_x: libm::sinf(phase),
            dir_y: 0.0,
            dir_z: -libm::cosf(phase),
            lp_hz: wire::BUS_LP_OFF_HZ as f32,
            score,
            start_offset_frames: offset,
            ..Default::default()
        });
        let mut v = Voice { id, mixed, hrtf, at: u32::MAX, phase };
        if mixed {
            v.at = self.mixed_ids.len() as u32;
            self.mixed_ids.push(id);
            self.hrtf_now += hrtf as u32;
        }
        self.voices[index as usize] = Some(v);
    }

    /// Main's view loses a mixed voice (ended or demoted).
    fn unmix(&mut self, index: usize) {
        let Some(v) = self.voices[index].as_mut() else { return };
        if !v.mixed {
            return;
        }
        v.mixed = false;
        let (at, hrtf) = (v.at as usize, v.hrtf);
        v.hrtf = false;
        self.hrtf_now -= hrtf as u32;
        self.mixed_ids.swap_remove(at);
        if at < self.mixed_ids.len() {
            let moved = (self.mixed_ids[at] & 0xFFFF) as usize;
            if let Some(m) = self.voices[moved].as_mut() {
                m.at = at as u32;
            }
        }
    }

    /// What STATUS says ended or was demoted since the last take.
    fn read_status(&mut self) {
        let ended: Vec<u32> = status::counters(&self.core).ended.as_slice().to_vec();
        let demoted: Vec<u32> = status::counters(&self.core).demoted.as_slice().to_vec();
        for id in demoted {
            let index = (id & 0xFFFF) as usize;
            if self.voices[index].is_some_and(|v| v.id == id) {
                self.unmix(index);
            }
        }
        for id in ended {
            let index = (id & 0xFFFF) as usize;
            if self.voices[index].is_some_and(|v| v.id == id) {
                self.unmix(index);
                self.voices[index] = None;
                self.free.push(index as u32);
            }
        }
    }

    /// The frame's batch (main's work, not timed): replacement one-shots up to the mixed target
    /// (`min(mixed, mixedCap)` with the cap), HRTF directions, parameter updates.
    fn build_batch(&mut self, q: u64) {
        let s = self.scene.clone();
        let mut target = s.mixed;
        if s.cap {
            target = target.min(status::counters(&self.core).mixed_cap as u32);
        }
        if s.one_shots {
            while (self.mixed_ids.len() as u32) < target && !self.free.is_empty() {
                self.start(None, true);
                self.starts += 1;
            }
        }
        let t = q as f32 * QUANTUM as f32 / RATE;
        let ramp = if s.ramps { (BATCH_EVERY as u32) * QUANTUM as u32 } else { 0 };
        for k in 0..self.mixed_ids.len() {
            let id = self.mixed_ids[k];
            let v = self.voices[(id & 0xFFFF) as usize].unwrap();
            let turning = v.hrtf && s.moving;
            if !(turning || (s.updates && !v.hrtf)) {
                continue;
            }
            // Turning: 120° a second; otherwise a slow drift.
            let w = if turning { 2.094 } else { 0.2 };
            let a = v.phase + w * t;
            let mut mask = wire::SET_PARAMS_MASK_DIR;
            if s.updates {
                mask |= wire::SET_PARAMS_MASK_GAIN;
            }
            self.push(&wire::SetParams {
                voice_id: id,
                frame_offset: wire::ASAP,
                mask,
                gain: 0.25 + 0.05 * libm::sinf(a),
                dir_x: libm::sinf(a),
                dir_z: -libm::cosf(a),
                ramp_frames: ramp,
                ..Default::default()
            });
        }
    }

    /// Feeds each stream up to about 16,384 frames ahead of the context (main's worker would
    /// keep its ring near full; the copy is audio-thread work, so it is timed).
    fn feed_streams(&mut self, frame: u64) {
        for k in 0..self.stream_fed.len() {
            if self.stream_fed[k] > frame + 16_384 {
                continue;
            }
            let id = STREAM_ID + k as u32;
            let Ok(p) = self.core.streams_mut().chunk_ptr(id, STREAM_CHUNK) else { continue };
            // SAFETY: room for STREAM_CHUNK stereo f32 frames.
            unsafe { core::ptr::copy_nonoverlapping(self.stream_data.as_ptr(), p as *mut f32, self.stream_data.len()) };
            if self.core.streams_mut().commit(id, STREAM_CHUNK, 1, 0) == wire::ERR_OK {
                self.stream_fed[k] += STREAM_CHUNK as u64;
            }
        }
    }
}

/// A wire record with a `write`.
trait WireRecord {
    fn write_to(&self, out: &mut [u8], at: usize) -> usize;
}

macro_rules! wire_record {
    ($($t:ty),*) => {$(
        impl WireRecord for $t {
            fn write_to(&self, out: &mut [u8], at: usize) -> usize {
                self.write(out, at).expect("record fits")
            }
        }
    )*};
}
wire_record!(wire::Play, wire::SetParams, wire::BusConfig, wire::BusMix, wire::Master);

fn percentile(sorted: &[f32], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[i] as f64
}

/// Runs `scene` for `warmup` then `seconds` of audio time; returns the recorded quanta's stats.
pub fn run(scene: &Scene, seconds: f64, warmup: f64, seed: u32, pace: bool, hrir: Option<&[u8]>) -> RunResult {
    let mut b = Bench::new(scene, seed, hrir);
    let warm_q = (warmup * RATE as f64 / QUANTUM as f64).ceil() as u64;
    let rec_q = (seconds * RATE as f64 / QUANTUM as f64).ceil() as usize;
    let mut times = Vec::with_capacity(rec_q);
    let mut wus = Vec::with_capacity(rec_q);
    let (mut xf_v, mut k_v, mut h_v) = (Vec::with_capacity(rec_q), Vec::with_capacity(rec_q), Vec::with_capacity(rec_q));
    let mut r = RunResult { cap_min: u32::MAX, ..Default::default() };
    let (mut sum_mixed, mut sum_live, mut sum_src, mut sum_moving) = (0f64, 0f64, 0f64, 0f64);
    let mut status_buf = vec![0u8; 16 * 1024];
    let mut deadline = platform::now_us();
    let (mut records_at_warm, mut starts_at_warm) = (0u64, 0u64);
    for q in 0..warm_q + rec_q as u64 {
        let frame = q * QUANTUM as u64;
        let recording = q >= warm_q;
        if q == warm_q {
            records_at_warm = b.records_sent;
            starts_at_warm = b.starts;
        }
        // Main's side (not timed): the frame's batch.
        let msg = if let Some(m) = (!b.setup.is_empty()).then(|| b.setup.remove(0)) {
            Some(m)
        } else if q % BATCH_EVERY == 0 {
            b.build_batch(q);
            (b.rec_count > 0).then(|| {
                b.records_sent += b.rec_count as u64;
                b.take_batch(frame as f64)
            })
        } else {
            None
        };
        let t0 = platform::now_us();
        if let Some(m) = &msg {
            let rc = scheduler::submit(&mut b.core, m);
            assert_eq!(rc, 0, "batch refused");
        }
        b.feed_streams(frame);
        b.core.process(frame);
        status::after_quantum(&mut b.core);
        clips::flush_events(&mut b.core);
        let mut dt = platform::now_us() - t0;
        if q % BATCH_EVERY == BATCH_EVERY - 1 {
            b.read_status();
            let t1 = platform::now_us();
            status::take(&mut b.core, &mut status_buf, 1);
            dt += platform::now_us() - t1;
        }
        if recording {
            let c = status::counters(&b.core);
            let w = b.core.cap().render_work();
            let (src, xf, kern) = (w.source_frames, w.hrtf_crossfading, w.hrtf_kernels);
            sum_moving += w.moving as f64;
            times.push(dt as f32);
            wus.push(b.core.work_units() as f32);
            sum_mixed += c.mixed_voices as f64;
            sum_live += c.live_voices as f64;
            sum_src += src as f64;
            h_v.push(c.hrtf_voices.min(255) as u8);
            xf_v.push(xf.min(255) as u8);
            k_v.push(kern.min(255) as u8);
            r.budget_max = r.budget_max.max(audio_core::panner::kernels_last_quantum(&b.core));
            let cap = c.mixed_cap as u32;
            r.cap_min = r.cap_min.min(cap);
            r.cap_last = cap;
        }
        if pace {
            deadline += PERIOD_US;
            let now = platform::now_us();
            if deadline > now {
                platform::sleep_us(deadline - now);
            } else {
                deadline = now;
            }
        }
    }
    let n = times.len().max(1) as f64;
    r.quanta = times.len();
    r.mean = times.iter().map(|&t| t as f64).sum::<f64>() / n;
    let mut sorted = times.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    r.p50 = percentile(&sorted, 0.5);
    r.p99 = percentile(&sorted, 0.99);
    r.p999 = percentile(&sorted, 0.999);
    r.max = *sorted.last().unwrap_or(&0.0) as f64;
    // Quantum q's batch is submitted at q % 6 == 0 and STATUS taken at q % 6 == 5.
    let mut quiet: Vec<f32> = times.iter().enumerate().filter(|(i, _)| ((warm_q + *i as u64) % BATCH_EVERY) % 5 != 0).map(|(_, &t)| t).collect();
    quiet.sort_by(|a, b| a.partial_cmp(b).unwrap());
    r.p99_quiet = percentile(&quiet, 0.99);
    r.p999_quiet = percentile(&quiet, 0.999);
    let mut w = wus.clone();
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    r.wu_mean = wus.iter().map(|&x| x as f64).sum::<f64>() / n;
    r.wu_p99 = percentile(&w, 0.99);
    r.wu_max = *w.last().unwrap_or(&0.0) as f64;
    r.mean_mixed = sum_mixed / n;
    r.mean_live = sum_live / n;
    r.mean_source_frames = sum_src / n;
    r.mean_moving = sum_moving / n;
    r.mean_hrtf = h_v.iter().map(|&x| x as f64).sum::<f64>() / n;
    r.mean_crossfading = xf_v.iter().map(|&x| x as f64).sum::<f64>() / n;
    r.mean_kernels = k_v.iter().map(|&x| x as f64).sum::<f64>() / n;
    r.records_per_quantum = (b.records_sent - records_at_warm) as f64 / n;
    r.starts_per_quantum = (b.starts - starts_at_warm) as f64 / n;
    r.demoted = b.core.cap().demoted;
    r.buses = scene.buses;
    r.clip_mb = scene.clip_mb;
    r.biquads = scene.biquads;
    r.snapshot_lp = scene.snapshot_lp;
    r.compressor = scene.compressor;
    r.reverb = scene.reverb;
    r.reverb_sends = scene.reverb_sends;
    r.streams = scene.streams;
    let (base, block) = b.block;
    drop(b);
    // SAFETY: the core over the block is gone with `b`; nothing else points into it.
    unsafe { std::alloc::dealloc(base, block) };
    r.times = times;
    r.crossfading = xf_v;
    r.kernels = k_v;
    r.hrtf = h_v;
    r
}

// --- Fitting -------------------------------------------------------------------------------

/// Least squares `y = a + b x`: (a, b, standard error of b).
pub fn fit_line(xs: &[f64], ys: &[f64]) -> (f64, f64, f64) {
    let n = xs.len() as f64;
    let mx = xs.iter().sum::<f64>() / n;
    let my = ys.iter().sum::<f64>() / n;
    let sxx: f64 = xs.iter().map(|x| (x - mx) * (x - mx)).sum();
    let sxy: f64 = xs.iter().zip(ys).map(|(x, y)| (x - mx) * (y - my)).sum();
    if sxx == 0.0 {
        return (my, 0.0, 0.0);
    }
    let b = sxy / sxx;
    let a = my - b * mx;
    let rss: f64 = xs.iter().zip(ys).map(|(x, y)| (y - a - b * x).powi(2)).sum();
    let se = if n > 2.0 { (rss / (n - 2.0) / sxx).sqrt() } else { 0.0 };
    (a, b, se)
}

/// Per-quantum least squares `t = c0 + c1·hrtf + c2·crossfading + c3·kernels` over the turning
/// runs (normal equations, 4×4).
fn fit_moving(runs: &[RunResult]) -> [f64; 4] {
    let mut ata = [[0f64; 4]; 4];
    let mut aty = [0f64; 4];
    for r in runs {
        for i in 0..r.times.len() {
            let row = [1.0, r.hrtf[i] as f64, r.crossfading[i] as f64, r.kernels[i] as f64];
            for a in 0..4 {
                for b in 0..4 {
                    ata[a][b] += row[a] * row[b];
                }
                aty[a] += row[a] * r.times[i] as f64;
            }
        }
    }
    solve4(ata, aty)
}

fn solve4(mut m: [[f64; 4]; 4], mut v: [f64; 4]) -> [f64; 4] {
    for c in 0..4 {
        let p = (c..4).max_by(|&a, &b| m[a][c].abs().partial_cmp(&m[b][c].abs()).unwrap()).unwrap();
        m.swap(c, p);
        v.swap(c, p);
        if m[c][c].abs() < 1e-12 {
            continue;
        }
        for r in 0..4 {
            if r != c {
                let f = m[r][c] / m[c][c];
                for k in 0..4 {
                    m[r][k] -= f * m[c][k];
                }
                v[r] -= f * v[c];
            }
        }
    }
    core::array::from_fn(|i| if m[i][i].abs() < 1e-12 { 0.0 } else { v[i] / m[i][i] })
}

// --- Entry ---------------------------------------------------------------------------------

fn arg<'a>(args: &'a str, key: &str) -> Option<&'a str> {
    args.split_whitespace().find_map(|w| w.strip_prefix(key).and_then(|r| r.strip_prefix('=')))
}

fn num(args: &str, key: &str, default: f64) -> f64 {
    arg(args, key).and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn result_json(target: &str, name: &str, run: usize, r: &RunResult) -> String {
    format!(
        "{{\"target\":\"{target}\",\"scene\":\"{name}\",\"run\":{run},\"quanta\":{},\"p50\":{:.2},\"p99\":{:.2},\"p999\":{:.2},\"max\":{:.2},\"mean\":{:.2},\"p99Quiet\":{:.2},\"p999Quiet\":{:.2},\"mixed\":{:.1},\"live\":{:.0},\"hrtf\":{:.2},\"crossfading\":{:.2},\"kernels\":{:.3},\"kernelsMax\":{},\"budgetMax\":{},\"sourceFrames\":{:.0},\"moving\":{:.1},\"recordsPerQuantum\":{:.2},\"startsPerSecond\":{:.1},\"wuMean\":{:.0},\"wuP99\":{:.0},\"wuMax\":{:.0},\"capMin\":{},\"capLast\":{},\"demoted\":{}}}",
        r.quanta,
        r.p50,
        r.p99,
        r.p999,
        r.max,
        r.mean,
        r.p99_quiet,
        r.p999_quiet,
        r.mean_mixed,
        r.mean_live,
        r.mean_hrtf,
        r.mean_crossfading,
        r.mean_kernels,
        r.kernels.iter().max().copied().unwrap_or(0),
        r.budget_max,
        r.mean_source_frames,
        r.mean_moving,
        r.records_per_quantum,
        r.starts_per_quantum * RATE as f64 / QUANTUM as f64,
        r.wu_mean,
        r.wu_p99,
        r.wu_max,
        r.cap_min,
        r.cap_last,
        r.demoted
    )
}

/// The fixed regions of a preset, for architecture §5.1.
fn memory(name: &str, logical: u32, mixed: u32, arena_mb: u32) -> String {
    let p = InitParams { sample_rate: RATE, max_logical: logical, max_mixed: mixed, max_buses: 32, arena_initial_bytes: arena_mb << 20 };
    let layout = Layout::new(&p);
    let mut parts = Vec::new();
    for (kind, r) in layout.regions() {
        parts.push(format!("\"{kind:?}\":{}", r.len));
    }
    let fixed = layout.region(RegionKind::Arena).offset;
    let hrtf44 = audio_core::panner::HrtfBank::bytes_for(44_100.0).unwrap_or(0);
    let hrtf48 = audio_core::panner::HrtfBank::bytes_for(48_000.0).unwrap_or(0);
    let hrtf96 = audio_core::panner::HrtfBank::bytes_for(96_000.0).unwrap_or(0);
    let hrir = hrir_table(RATE).len();
    format!(
        "{{\"memory\":\"{name}\",\"hrirTable48k\":{hrir},{},\"fixedBeforeArena\":{fixed},\"total\":{},\"hrtfBank44k\":{hrtf44},\"hrtfBank48k\":{hrtf48},\"hrtfBank96k\":{hrtf96},\"ringBytes\":{}}}",
        parts.join(","),
        layout.total(),
        audio_core::stream::RING_BYTES
    )
}

/// Runs the benchmark for `args` (see the module comment), printing JSON lines.
pub fn main(args: &str) {
    let mode = arg(args, "mode").unwrap_or("scene");
    let seconds = num(args, "seconds", if mode == "fit" { 10.0 } else { 60.0 });
    let warmup = num(args, "warmup", 5.0);
    let runs = num(args, "runs", if mode == "fit" { 3.0 } else { 5.0 }) as usize;
    let seed = num(args, "seed", 1.0) as u32;
    let pace = num(args, "pace", 0.0) != 0.0;
    let target = TARGET;
    match mode {
        "memory" => {
            for (name, l, m, a) in [("low", 1_024, 48, 8), ("default", 4_096, 128, 16), ("high", 8_192, 256, 32)] {
                platform::print(&memory(name, l, m, a));
            }
        }
        "scene" => {
            let names = arg(args, "name").unwrap_or("default");
            let hrir = hrir_table(RATE);
            for name in names.split(',') {
                let Some(s) = scene(name) else {
                    platform::print(&format!("{{\"error\":\"unknown scene {name}\"}}"));
                    continue;
                };
                for run_i in 0..runs {
                    let r = run(&s, seconds, warmup, seed + run_i as u32, pace, Some(&hrir));
                    platform::print(&result_json(target, name, run_i, &r));
                    if num(args, "phases", 0.0) != 0.0 {
                        // Mean and p99 by quantum index mod 16 (the reverb tail's period) and mod 6
                        // (batches and STATUS takes): where the tail of the distribution comes from.
                        for period in [16usize, 6] {
                            let mut parts = Vec::new();
                            for ph in 0..period {
                                let mut v: Vec<f32> = r.times.iter().skip(ph).step_by(period).copied().collect();
                                v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                                let mean = v.iter().map(|&t| t as f64).sum::<f64>() / v.len().max(1) as f64;
                                parts.push(format!("[{mean:.0},{:.0}]", percentile(&v, 0.99)));
                            }
                            platform::print(&format!("{{\"phases\":{period},\"meanP99\":[{}]}}", parts.join(",")));
                        }
                    }
                }
            }
        }
        "fit" => {
            let only = arg(args, "term");
            let hrir = hrir_table(RATE);
            let mut static_hrtf: Option<(f64, f64)> = None;
            for sw in sweeps() {
                if only.is_some_and(|t| !t.split(',').any(|x| x == sw.term)) {
                    continue;
                }
                let (mut xs, mut ys, mut p999s) = (Vec::new(), Vec::new(), Vec::new());
                let mut all = Vec::new();
                for sc in &sw.scenes {
                    for run_i in 0..runs {
                        let r = run(sc, seconds, warmup.min(2.0), seed + run_i as u32, pace, Some(&hrir));
                        platform::print(&result_json(target, &sc.name, run_i, &r));
                        xs.push((sw.x)(&r));
                        ys.push(r.mean);
                        p999s.push(r.p999);
                        all.push(r);
                    }
                }
                let (a, b, se) = fit_line(&xs, &ys);
                let (_, b999, _) = fit_line(&xs, &p999s);
                let mut extra = String::new();
                if sw.term == "hrtf_static" {
                    static_hrtf = Some((a, b));
                }
                if sw.term == "hrtf_moving" {
                    let c = fit_moving(&all);
                    extra = format!(",\"perQuantum\":{{\"intercept\":{:.3},\"perVoice\":{:.3},\"perCrossfading\":{:.3},\"perKernel\":{:.3}}}", c[0], c[1], c[2], c[3]);
                    if let Some((_, bs)) = static_hrtf {
                        extra.push_str(&format!(",\"staticPerVoice\":{bs:.3}"));
                    }
                }
                platform::print(&format!(
                    "{{\"target\":\"{target}\",\"fit\":\"{}\",\"unit\":\"{}\",\"intercept\":{a:.3},\"slope\":{b:.4},\"stderr\":{se:.4},\"slopeP999\":{b999:.4}{extra}}}",
                    sw.term, sw.unit
                ));
            }
        }
        _ => platform::print(&format!("{{\"error\":\"unknown mode {mode}\"}}")),
    }
}
