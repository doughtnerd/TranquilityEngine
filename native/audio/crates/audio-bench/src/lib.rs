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
//! ADR 0162 A7 adds the bed scenes (`bed-64`, `bed-256`, `bed-xfade`) and the bed sweeps (`bed_encode`, `bed_decode`,
//! `bed_decode_matrix`, `bed_xfade`): kind 2 voices encode into beds hosted on buses, decoded with the committed MagLS
//! filters (loaded as format 4, as main does) or the baked matrix. The ambisonic terms (`AMBI_ROTATE`, `AMBI_READ`):
//! `ambi-o3` (4 looping 3rd-order clips rotated by a turning listener into a bed), `ambi-o3-private` (into a private
//! decoder), the sweeps `ambi_o3`, `ambi_o1` and `ambi_o3_private` over 1 to 16 clips, and `mode=fit term=ambi_rotate`
//! (the rotation alone, against the dedicated kernel B3 traded away).
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
use audio_core::{scheduler, status, zones, Core, QUANTUM};
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
    /// The adaptive cap acts on the production budget with the work-unit model driving it (else its budget is
    /// unlimited) and main obeys `mixedCap`.
    pub cap: bool,
    /// ADR 0158 E2: automation bindings per voice (0 to 3: volume on a global parameter, pitch on the voice's
    /// group's local one, lowpass on a second global), with every batch seeking the globals and 32 groups' locals.
    pub bindings: u32,
    /// ADR 0158 E2: every bus has a volume and a lowpass binding to the seeking globals.
    pub bus_automation: bool,
    /// ADR 0158 E2: mixed voices are clips looping a SET_LOOP region (no whole-clip loop); each batch releases two,
    /// which play their tails and end, and new ones replace them.
    pub sustain: bool,
    /// ADR 0158 E2: also time one extra `automation::begin_quantum` before each quantum (outside the timed work;
    /// the parameters then seek twice as fast) and report its percentiles: the control-rate pass on its own.
    pub probe_automation: bool,
    /// ADR 0162 A7: beds hosted (`max_beds`; 0 = none). One bed is hosted by bus 0 (the root's child); with more, bus
    /// 0 is a plain parent and bed `k` is hosted by bus `1 + k`, so `buses` is `1 + beds` and the bed voices spread
    /// over buses `1..=beds`.
    pub beds: u32,
    /// The first `bed_voices` mixed voices use panner kind 2 (bed).
    pub bed_voices: u32,
    /// Load the committed MagLS filters (format 4) so beds decode through them; off decodes through the matrix.
    pub magls: bool,
    /// ADR 0162 A7 (`bed-xfade`): voices cross the HRTF/bed boundary continuously. Every batch, `xfade` voices enter
    /// the HRTF window and `xfade` leave it ([`xfade_kind`]); the 45 ms crossfades overlap. `Some(0)`: the window
    /// stays still (the sweep's baseline); `None`: no window, every bed voice stays a bed voice.
    pub xfade: Option<u32>,
    /// ADR 0162 D6 (D1's per-voice filters): mixed voices (streams and ambisonic voices excepted) carrying a low-pass,
    /// and a high-pass, each ramping log-uniformly every batch (SET_PARAMS `lpHz`, SET_VOICE_FX `hpHz`). A voice with
    /// both counts in both.
    pub voice_lp: u32,
    pub voice_hp: u32,
    /// ADR 0162 D6: ambisonic voices (looping 3rd-order, 16-channel clips, `ambi_private` of them on a bus with no bed,
    /// decoded by a private decoder, the rest into the beds' host buses) among the mixed; `max_wide` is the core's
    /// `maxClips`.
    pub ambi: u32,
    pub ambi_private: u32,
    pub max_wide: u32,
    /// ADR 0162 A7 (`ambi-o3`): the ambisonic clips' order (1: 4 channels, 2: 9, 3: 16) and a listener that turns (yaw and
    /// a slow pitch, a LISTENER every batch ramped over it), so every ambisonic voice rotates through a moving matrix.
    pub ambi_order: u32,
    pub listener: bool,
    /// ADR 0162 D6: configured zone slots and the longest kernel they hold (frames). C4's sends are not on this base
    /// (`sends::tap` is a no-op), so the slots are sized (the `Zones` region) but never fed: they idle at no cost.
    pub zone_slots: u32,
    pub zone_frames: u32,
    /// ADR 0162 C7 (C4's sends are on the base now): slots made active at setup, each holding its own prepared kernel of
    /// `zone_frames` (decaying noise, as `zones_common::kernel_blob`), returning to bus 0 at wet 1; the shared reverb's
    /// return at 0.5 (the listener inside a zone, so the scaled path runs).
    pub zones_active: u32,
    /// Mixed voices (streams and ambisonic ones excepted) carrying zone sends, each into `sends_per_voice` of the
    /// accepting slots (voice `k` takes slots `k, k+1, ...` modulo them), 0.3 each; and mixed voices with an aux send
    /// (0.2, post-fader) into bus [`AUX_BUS`].
    pub zone_sends: u32,
    pub sends_per_voice: u32,
    pub aux_voices: u32,
    /// Zones swap slots ([`SWAP_FIRST_S`], then every [`SWAP_EVERY_S`]): alternately through the standby path (a zone
    /// is released and rings out beside the incoming one) and the eviction path (a zone is evicted with the 150 ms
    /// fade, its kernel freed, the incoming kernel uploaded into its slot, 256 KB a quantum). Main's side is scripted
    /// here (`ZoneMain`); the core's side (`configure`, `start_waiting`, kernel reserve and free) is timed.
    pub swap: bool,
    /// ADR 0166 M4-0 (Z5): per-quantum per-voice records, one batch every quantum ([`Per`]), stamped inside the quantum
    /// (`stamped`: each record at its own frame, so the core applies it in its voice) or, for the twin, `ASAP` (the same
    /// records applied at the quantum's start). A stamped scene asserts at its end that no quantum split.
    pub per_quantum: Option<Per>,
    pub stamped: bool,
    /// ADR 0166 M4b (Bench1): music on top of the preset (stems, groups, rings; [`Music`]). The scene's mixed voices
    /// exclude music's, so the scene less its `music: None` twin is music's own cost.
    pub music: Option<Music>,
    /// The core's `max_music_rings` (the music scenes and their twins lay the pool out, whether or not they open a ring).
    pub music_rings: u32,
}

/// ADR 0166 M4b (Bench1): what the music scenes play ([`Scene::music`]), on the default preset (8 music rings, 16 groups).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Music {
    pub kind: MusicKind,
    /// Stems read music rings (a stream each; the worst scene's other stems and stingers stay decoded), else every stem is a
    /// decoded clip.
    pub streamed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MusicKind {
    /// 8 stems in one gated group; one stem fading at a time; a held group (streamed: a ring runs dry and the group
    /// holds, then resumes; decoded: a group missing a member waits and is given up).
    Typical,
    /// A transition every [`MUSIC_CYCLE_Q`] quanta: the next segment's 4 stems start as a stamped group (rings opened and
    /// primed first) and fade in, the last segment's fade out and stop, a bridge and a tail span play over the seam.
    Transition,
    /// The most the default preset allows at once: 16 groups (the table's cap, one member each), 12 stems and 4 stingers,
    /// every voice fading all the time; streamed, the 8 music rings carry the first 8 stems.
    Worst,
}

/// The default preset's music pool (`max_music_rings`: `max_mixed / 16`, 128 -> 8).
const MUSIC_RINGS: u32 = 8;
/// Ids of the music rings main opens (one per stem per segment; a retired ring's id is never reused).
const MUSIC_STREAM_ID: u32 = 0xFFFF_0400;
/// Music starts at this quantum (its rings primed by then); a transition cycle's length.
const MUSIC_START_Q: u64 = 8;
const MUSIC_CYCLE_Q: u64 = 240;
/// Frames of a stem crossfade (16 quanta), a stinger's stop fade, a tail's fade.
const MUSIC_XFADE: u32 = 2_048;

/// The per-quantum record streams of M4-0's metered scenes (`stamped-*` and their `-twin`s).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Per {
    /// One FADE (class G) on the next mixed voice, alternating down and up.
    Fade,
    /// A stamped spatial PLAY with zone and aux sends (one voice a quantum), and a low-pass ramp on one live voice.
    Spatial,
    /// One SET_LOOP (class S: a voice-local split) on the next looping voice, alternating two regions.
    Loop,
    /// Music: 8 stems, an equal-power crossfade of one every 32 quanta (a PLAY with `fadeZero` and a FADE in, a FADE out
    /// with `stopAtEnd`), and a stinger voice started and stopped by a stamped STOP.
    Music,
    /// ADR 0171/0172 M5 (Bn1): a `BUS_RAMP` (runtime lane, gain, over `ramp_q` quanta) on each of the first `n` buses every 4th
    /// quantum, alternating 0.6 and 0.9 (a `ramp_q` of 0 steps to unity, once: the settled twin, the identity skip): `n` lanes ramping all the
    /// time (class B when stamped).
    BusRamp(u32, u32),
}

/// ADR 0162 C7: the bus aux sends go to (one of the presets' 32 buses).
const AUX_BUS: u16 = 2;
/// ADR 0162 C7 (`zones-swap`): seconds before the first swap, and between swaps. A ring-out lasts the IR (2 s) plus the
/// idle margin (0.13 s), and the standby path needs a free slot, so alternate swaps (standby, then eviction) 1.25 s
/// apart never find all three slots busy.
const SWAP_FIRST_S: f64 = 0.25;
const SWAP_EVERY_S: f64 = 1.25;
/// Send level into a zone slot, and aux level.
const ZONE_SEND_LEVEL: f32 = 0.3;
const AUX_LEVEL: f32 = 0.2;

/// ADR 0162 D6: where a filtered voice's cutoffs start, Hz (they sweep between [`LP_RANGE`] and [`HP_RANGE`] after).
const LP_START_HZ: f32 = 4_000.0;
const HP_START_HZ: f32 = 120.0;
/// Low-pass and high-pass sweeps, Hz: log-uniform between the ends, one slow sine per voice.
const LP_RANGE: (f32, f32) = (600.0, 14_000.0);
const HP_RANGE: (f32, f32) = (40.0, 500.0);

/// The voices in the HRTF window of `bed-xfade`'s rotating schedule.
const XFADE_WINDOW: u32 = 16;

/// Panner kind of mixed voice `k` (of `n`) at batch `b` in a crossing scene: HRTF while `(k + step * b) mod n` is
/// inside the window, else bed. Each batch the window moves by `step` voices: `step` enter and `step` leave.
fn xfade_kind(k: u32, b: u64, step: u32, n: u32) -> u8 {
    if ((k as u64 + step as u64 * b) % n as u64) < XFADE_WINDOW as u64 {
        wire::panner::HRTF as u8
    } else {
        wire::panner::BED as u8
    }
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
            bindings: 0,
            bus_automation: false,
            sustain: false,
            probe_automation: false,
            beds: 0,
            bed_voices: 0,
            magls: false,
            xfade: None,
            voice_lp: 0,
            voice_hp: 0,
            ambi: 0,
            ambi_private: 0,
            max_wide: 0,
            ambi_order: 3,
            listener: false,
            zone_slots: 0,
            zone_frames: 0,
            zones_active: 0,
            zone_sends: 0,
            sends_per_voice: 1,
            aux_voices: 0,
            swap: false,
            per_quantum: None,
            stamped: false,
            music: None,
            music_rings: 0,
        }
    }

    /// ADR 0166 M4-0 (Z5): `base` sending `per` every quantum, stamped or (the twin) `ASAP`.
    fn per(base: Scene, per: Per, stamped: bool) -> Scene {
        Scene { per_quantum: Some(per), stamped, ..base }
    }

    /// ADR 0166 M4b (Bench1): the default preset with `kind` of music on top. Music's voices are not among the scene's `mixed`
    /// (they take the preset's cap beyond it), so the scene less its `-twin` (`music: None`) is music's own cost.
    fn music(name: &str, kind: MusicKind, streamed: bool, with: bool) -> Scene {
        let base = Scene::preset(name, 4_096, 128, 16, 8);
        let peak = match kind {
            MusicKind::Typical => 8 + 2,
            MusicKind::Transition => 4 + 4 + 2,
            MusicKind::Worst => 16,
        };
        Scene { mixed: 128 - peak, virtual_voices: 4_096 - 128 - 64, music: with.then_some(Music { kind, streamed }), music_rings: MUSIC_RINGS, ..base }
    }

    /// ADR 0162 A7: `voices` looping voices of kind 2 (bed) into `beds` beds, decoded through MagLS (`magls`) or the
    /// matrix, each on its own clip of 64 MB ÷ `voices`, with per-frame direction updates (the voices drift).
    fn bed(name: &str, voices: u32, beds: u32, magls: bool) -> Scene {
        Scene { beds, bed_voices: voices, magls, buses: if beds > 1 { 1 + beds } else { 1 }, updates: true, ..Scene::looping(name, voices) }
    }

    /// ADR 0162 A7: `n` looping ambisonic clips of `order` (so `n` is `maxClips`), rotated by a turning listener into the
    /// bus's bed (MagLS) or, with `private`, into the private decoder of a bus that has none (MagLS too).
    fn ambient(name: &str, n: u32, order: u32, private: bool) -> Scene {
        Scene {
            beds: !private as u32,
            magls: true,
            ambi: n,
            ambi_private: if private { n } else { 0 },
            max_wide: n,
            ambi_order: order,
            listener: true,
            ..Scene::looping(name, n)
        }
    }

    /// ADR 0162 D6 (architecture §7.2 "Worst" rows): a preset's full scene with M3's terms at their limits. The HRTF
    /// voices drop to `hrtf` and every other mixed voice (the streams and the ambisonic ones apart) is a bed voice on the
    /// beds' host buses; `ambi` ambisonic clips (`ambi_private` private); `lp` low-passes and `hp` high-passes ramping;
    /// `zone_slots` of `zone_s` seconds.
    #[allow(clippy::too_many_arguments)]
    fn worst(name: &str, base: Scene, hrtf: u32, beds: u32, ambi: u32, ambi_private: u32, lp: u32, hp: u32, zone_slots: u32, zone_s: u32) -> Scene {
        Scene {
            name: name.to_string(),
            hrtf,
            beds,
            bed_voices: if beds > 0 { base.mixed } else { 0 },
            magls: beds > 0,
            buses: if beds > 1 { base.buses.max(1 + beds) } else { base.buses },
            ambi,
            ambi_private,
            max_wide: ambi,
            voice_lp: lp,
            voice_hp: hp,
            zone_slots,
            zone_frames: zone_s * RATE as u32,
            ..base
        }
    }

    /// ADR 0162 C7: `base` with its zone slots live: `active` slots convolving `zone_s`-second kernels, `voices` mixed
    /// voices sending into `per_voice` slots each, `aux` voices with an aux send.
    fn zoned(base: Scene, active: u32, voices: u32, per_voice: u32, aux: u32) -> Scene {
        Scene { zones_active: active, zone_sends: voices, sends_per_voice: per_voice, aux_voices: aux, ..base }
    }

    /// ADR 0166 M4-0 (`stamped-spatial`): 64 spatial one-shots, one started every quantum, each with a low-pass, two zone
    /// sends and (16 of them) an aux send, into 2 convolving 0.25 s zones.
    fn spatial_plays(name: &str) -> Scene {
        let base = Scene { one_shots: true, starts_per_sec: 375.0, pitch: (0.5, 2.0), voice_lp: 64, zone_slots: 2, zone_frames: RATE as u32 / 4, ..Scene::looping(name, 64) };
        Scene::zoned(base, 2, 64, 2, 16)
    }

    /// `mixed` looping voices at pitch 1, each reading its own clip of 64 MB ÷ `mixed`, on one bus (the sweeps' base).
    fn looping(name: &str, mixed: u32) -> Scene {
        Scene { mixed, ..Scene::base(name) }
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
        // The Stress sample's content (`samples/stress`, C1): the editor's high preset (256 mixed, 4,096 logical,
        // 32 HRTF), its 8 streams and pitch 0.5-16 for the one-shots. Informational: the sample's long quiet "beds"
        // are the scene's looping virtual voices, its "hits" the restarted one-shots. `starts_per_sec: 120` makes the
        // one-shots longer at pitch 1, so that pitch 16's short ones still come to about 200 starts a second.
        "stress" => Scene { pitch: (0.5, 16.0), starts_per_sec: 120.0, ..Scene::preset(name, 4_096, 256, 32, 8) },
        "stress-cap" => Scene { pitch: (0.5, 16.0), starts_per_sec: 120.0, cap: true, ..Scene::preset(name, 4_096, 256, 32, 8) },
        // Focused scenes for the metered gate (C1b, `tools/audio-bench/metered-gate.mjs`): each loads one part of the
        // core so a regression there moves its count by more than it moves a preset's. 32 looping voices unless named.
        // The bus graph: 32 buses each with lowpass, highpass, compressor and snapshot low-pass, 8 sending to the reverb.
        "fx" => Scene { buses: 32, biquads: 2, compressor: true, snapshot_lp: true, reverb: true, reverb_sends: 8, ..Scene::looping(name, 32) },
        // HRTF: all 32 voices on the HRTF panner, still (convolution only) and turning (kernel updates, crossfades).
        "hrtf-static" => Scene { hrtf: 32, ..Scene::looping(name, 32) },
        "hrtf-moving" => Scene { hrtf: 32, moving: true, ..Scene::looping(name, 32) },
        // Streams: 16 of the 32 voices read stream rings fed 4,096 frames at a time.
        "streams" => Scene { streams: 16, ..Scene::looping(name, 32) },
        // The resampler: 128 voices at pitch 4 (four source frames per output frame).
        "pitch4" => Scene { pitch: (4.0, 4.0), ..Scene::looping(name, 128) },
        // Virtual voices keeping time: 8,064 looping virtual voices beside 16 mixed.
        "virtual" => Scene { max_logical: 8_192, virtual_voices: 8_064, ..Scene::looping(name, 16) },
        // Records and the moving pan path: SET_PARAMS (gain and direction, ramped) for 256 voices every batch.
        "updates" => Scene { updates: true, ..Scene::looping(name, 256) },
        // ADR 0158 E2: 256 mixed voices with 3 bindings each (0158 §6's budget case) and its twin without them; the
        // same bindings on 256 virtual voices (the control-rate evaluation and pitch alone); 32 automated buses
        // (the twin is the `snapshot-true` sweep); sustain loops released and replaced.
        "automation" => Scene { bindings: 3, ..Scene::looping(name, 256) },
        "automation-base" => Scene::looping(name, 256),
        "automation-virtual" => Scene { bindings: 3, virtual_voices: 256, ..Scene::looping(name, 16) },
        "bus-automation" => Scene { buses: 32, snapshot_lp: true, bus_automation: true, ..Scene::looping(name, 32) },
        "sustain" => Scene { sustain: true, ..Scene::looping(name, 128) },
        // Not gated: the timed control-rate pass of `automation`, and the virtual scene's twin without bindings.
        "automation-probe" => Scene { bindings: 3, probe_automation: true, ..Scene::looping(name, 256) },
        "automation-virtual-base" => Scene { virtual_voices: 256, ..Scene::looping(name, 16) },
        // ADR 0162 A7 (bed bench): 64 voices into one bed and 256 into two (architecture §7.2's typical and full
        // high), MagLS decode; `bed-xfade`: 64 voices, 2 entering and 2 leaving the 16-voice HRTF window every
        // batch (12 or so crossfading at any time), the rest in one bed.
        "bed-64" => Scene::bed(name, 64, 1, true),
        "bed-256" => Scene::bed(name, 256, 2, true),
        "bed-xfade" => Scene { xfade: Some(2), ..Scene::bed(name, 64, 1, true) },
        // ADR 0162 D6: 256 looping voices, each with a low-pass and a high-pass ramping every batch (D1's pool); its
        // twin without filters is `updates`.
        // ADR 0162 A7 (architecture §7.1's `AMBI_ROTATE` and `AMBI_READ`): 4 looping 3rd-order (16-channel) clips rotated by a
        // turning listener into one MagLS bed (the clips are the only voices: the intercept is the bed's decode), and the same
        // clips into one private decoder (no bed; they share the bus's decoder).
        "ambi-o3" => Scene::ambient(name, 4, 3, false),
        "ambi-o3-private" => Scene::ambient(name, 4, 3, true),
        "filters-256" => Scene { updates: true, voice_lp: 256, voice_hp: 256, ..Scene::looping(name, 256) },
        // ADR 0162 D6 (architecture §7.2): each preset's worst case on top of its M1/M2 content. High: 8 HRTF, 4 beds,
        // 2 ambisonic clips (1 private), 256 low-pass, 32 high-pass, 3 slots of 4 s. Default: 8 HRTF, 2 beds, 1 private
        // clip, 128 + 16 filtered, 3 slots of 2 s. Low: 4 HRTF, no beds, 1 private clip, 64 + 8 filtered, 1 slot of 1 s.
        "m3-worst-high" => Scene::worst(name, Scene::preset(name, 8_192, 256, 32, 16), 8, 4, 2, 1, 256, 32, 3, 4),
        "m3-worst-default" => Scene::worst(name, Scene::preset(name, 4_096, 128, 16, 8), 8, 2, 1, 1, 128, 16, 3, 2),
        "m3-worst-low" => Scene::worst(name, Scene::preset(name, 1_024, 48, 4, 4), 4, 0, 1, 1, 64, 8, 1, 1),
        // ADR 0162 C7 (architecture §7.2, `zones-2x2s` of the model's c_zone row): 16 looping voices, every one sending into
        // both of two 2 s zones (S = 32), 3 slots (the high preset's standby slot idle); its twin is the same voices with the
        // zones left out (`zones-2x2s-dry`), so the difference of the two is the zones' cost.
        "zones-2x2s" => Scene::zoned(Scene { zone_slots: 3, zone_frames: 2 * RATE as u32, ..Scene::looping(name, 16) }, 2, 16, 2, 0),
        "zones-2x2s-dry" => Scene::looping(name, 16),
        // Zones swapping slots through the standby and the eviction paths, kernels uploaded as they go (see `Scene::swap`).
        "zones-swap" => Scene { swap: true, ..Scene::zoned(Scene { zone_slots: 3, zone_frames: 2 * RATE as u32, ..Scene::looping(name, 16) }, 2, 16, 2, 0) },
        // The high preset's typical M3 scene (§7.2): 8 HRTF voices (32 → 8), 2 beds with the rest of the voices in them,
        // one 3rd-order clip into a bed, 32 low-passes, 2 blending 2 s zones in 3 slots, 240 voices sending to one zone each.
        "m3-high" => Scene::zoned(
            Scene { zone_slots: 3, zone_frames: 2 * RATE as u32, ..Scene::worst(name, Scene::preset(name, 8_192, 256, 32, 16), 8, 2, 1, 0, 32, 0, 3, 2) },
            2,
            240,
            1,
            0,
        ),
        // D6's worst scenes with their zones convolving and sends flowing (the same scene content, §7.2's send and aux
        // counts): the zone cost D6 couldn't model without sends. High: 3 slots of 4 s all active, 248 voices into 2 slots
        // each, 32 aux. Default: 3 slots of 2 s, 120 voices into 2, 16 aux. Low: 1 slot of 1 s, 60 voices, 8 aux.
        "m3-worst-high-sends" => Scene::zoned(Scene { name: name.into(), ..scene("m3-worst-high").unwrap() }, 3, 248, 2, 32),
        "m3-worst-default-sends" => Scene::zoned(Scene { name: name.into(), ..scene("m3-worst-default").unwrap() }, 3, 120, 2, 16),
        "m3-worst-low-sends" => Scene::zoned(Scene { name: name.into(), ..scene("m3-worst-low").unwrap() }, 1, 60, 1, 8),
        // ADR 0166 M4-0 (Z5): per-quantum per-voice records stamped inside their quantum (applied in the voice, no quantum
        // split) beside the same records unstamped (`-twin`). `stamped-g`: a FADE on one of 256 voices every quantum;
        // `stamped-spatial`: a spatial play with 2 zone sends and an aux send every quantum (one-shots, 0.25 s zones in 2
        // slots) and a low-pass ramp; `stamped-loop`: a SET_LOOP (class S) on one of 128 voices every quantum;
        // `stamped-music`: 8 stems with equal-power crossfades and stamped stops.
        "stamped-g" => Scene::per(Scene::looping(name, 256), Per::Fade, true),
        "stamped-g-twin" => Scene::per(Scene::looping(name, 256), Per::Fade, false),
        "stamped-spatial" => Scene::per(Scene::spatial_plays(name), Per::Spatial, true),
        "stamped-spatial-twin" => Scene::per(Scene::spatial_plays(name), Per::Spatial, false),
        "stamped-loop" => Scene::per(Scene::looping(name, 128), Per::Loop, true),
        "stamped-loop-twin" => Scene::per(Scene::looping(name, 128), Per::Loop, false),
        "stamped-music" => Scene::per(Scene::looping(name, 8), Per::Music, true),
        "stamped-music-twin" => Scene::per(Scene::looping(name, 8), Per::Music, false),
        // ADR 0171/0172 M5 (Bn1): bus lanes ramping. `busramp-8`: 8 buses each with a stamped BUS_RAMP every 4th quantum
        // (class B), `-twin` the same asap, `-base` the same 8 buses settled; `busramp-32`: 32 buses configured, 4 ramping
        // (stamped), the other 28 settled (the identity skip), `-base` the 32 settled.
        "busramp-8" => Scene::per(Scene { buses: 8, ..Scene::looping(name, 32) }, Per::BusRamp(8, 4), true),
        "busramp-8-twin" => Scene::per(Scene { buses: 8, ..Scene::looping(name, 32) }, Per::BusRamp(8, 4), false),
        "busramp-8-base" => Scene::per(Scene { buses: 8, ..Scene::looping(name, 32) }, Per::BusRamp(8, 0), false),
        "busramp-32" => Scene::per(Scene { buses: 32, ..Scene::looping(name, 32) }, Per::BusRamp(4, 4), true),
        "busramp-32-base" => Scene::per(Scene { buses: 32, ..Scene::looping(name, 32) }, Per::BusRamp(4, 0), false),
        // ADR 0166 M4b (Bench1): music on the default preset, decoded and streamed, each beside its music-free twin (the
        // twin is shared: music's voices are on top of the same SFX). `MUSIC_PAIRS` in the gate holds the allowances.
        "music-typ-twin" => Scene::music(name, MusicKind::Typical, false, false),
        "music-typ" => Scene::music(name, MusicKind::Typical, false, true),
        "music-typ-streamed" => Scene::music(name, MusicKind::Typical, true, true),
        "music-trans-twin" => Scene::music(name, MusicKind::Transition, false, false),
        "music-trans" => Scene::music(name, MusicKind::Transition, false, true),
        "music-trans-streamed" => Scene::music(name, MusicKind::Transition, true, true),
        "music-worst-twin" => Scene::music(name, MusicKind::Worst, false, false),
        "music-worst" => Scene::music(name, MusicKind::Worst, false, true),
        "music-worst-streamed" => Scene::music(name, MusicKind::Worst, true, true),
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
    let looping = |name: String, mixed: u32| Scene::looping(&name, mixed);
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
    // ADR 0162 A7: kind 2 voices into one bed (one decode, MagLS). The slope is a whole mixed voice with its per-frame
    // direction updates (source read, ramps, encode); `bed_ep_twin` is the same voices on the equal-power panner, and
    // the difference of the two slopes is `BED_VOICE` (the encode against the pan matrix).
    out.push(Sweep {
        term: "bed_encode",
        unit: "µs per bed voice (one MagLS bed decoding; includes the mixed voice's own cost)",
        scenes: [16u32, 64, 128, 192, 256].iter().map(|&n| Scene::bed(&format!("bed-voices-{n}"), n, 1, true)).collect(),
        x: |r| r.mean_bed_voices,
    });
    out.push(Sweep {
        term: "bed_ep_twin",
        unit: "µs per equal-power voice (same voices and updates, no bed)",
        scenes: [16u32, 64, 128, 192, 256].iter().map(|&n| Scene { bed_voices: 0, ..Scene::bed(&format!("ep-voices-{n}"), n, 0, false) }).collect(),
        x: |r| r.mean_mixed,
    });
    // 32 voices over 1..4 beds (every bed gets some): the slope is `BED_DECODE` (MagLS: 16 forward FFTs, the partitions'
    // MACs, 2 inverses); 32 voices keep the base small so the decode shows above the run-to-run noise.
    out.push(Sweep {
        term: "bed_decode",
        unit: "µs per decoding bed (MagLS, 32 voices in all)",
        scenes: [1u32, 2, 3, 4].iter().map(|&b| Scene::bed(&format!("bed-decode-{b}"), 32, b, true)).collect(),
        x: |r| r.mean_beds,
    });
    // The same through the baked 16 → 2 matrix (the filters not loaded, or `audio.spatial: "equalPower"`).
    out.push(Sweep {
        term: "bed_decode_matrix",
        unit: "µs per decoding bed (matrix, 32 voices in all)",
        scenes: [1u32, 2, 3, 4].iter().map(|&b| Scene::bed(&format!("bed-decode-matrix-{b}"), 32, b, false)).collect(),
        x: |r| r.mean_beds,
    });
    // Crossings: 0, 1, 2 and 4 voices enter (and as many leave) the HRTF window per batch; x = voices in transit
    // (HRTF fading against the bed, both paths running).
    out.push(Sweep {
        term: "bed_xfade",
        unit: "µs per crossfading voice (HRTF and bed paths both running)",
        scenes: [0u32, 1, 2, 4].iter().map(|&x| Scene { xfade: Some(x), ..Scene::bed(&format!("bed-xfade-{x}"), 64, 1, true) }).collect(),
        x: |r| r.mean_transit,
    });
    // ADR 0162 C7: the zone terms of §7.1. 16 looping voices, 8 of them sending into the zone(s) (the sends are `c_send`'s,
    // so the base of each sweep holds them constant), 3 slots.
    let zoned = |name: String, active: u32, seconds: f32, senders: u32, per_voice: u32, aux: u32| {
        let frames = (seconds * RATE) as u32;
        Scene::zoned(Scene { zone_slots: 3, zone_frames: frames.max(RATE as u32 / 2), ..Scene::looping(&name, 16) }, active, senders, per_voice, aux)
    };
    // One active zone of 0.5, 1, 2, 4 s (the slot-region and kernel sized to each, 8 senders): intercept `ZONE_BASE`,
    // slope `ZONE_PER_S`.
    out.push(Sweep {
        term: "zone_len",
        unit: "µs per second of IR (one active zone, 8 senders)",
        scenes: [0.5f32, 1.0, 2.0, 4.0].iter().map(|&sec| zoned(format!("zone-len-{sec}"), 1, sec, 8, 1, 0)).collect(),
        x: |r| r.zone_seconds,
    });
    // 0..3 active 2 s zones, every sender into each of them (8 senders × the zones: the sends' share is fitted on its own below).
    out.push(Sweep {
        term: "zone_count",
        unit: "µs per active 2 s zone (8 senders into each, so includes 8 sends)",
        scenes: [0u32, 1, 2, 3].iter().map(|&n| zoned(format!("zone-count-{n}"), n, 2.0, if n == 0 { 0 } else { 8 }, 3, 0)).collect(),
        x: |r| r.mean_zones_active,
    });
    // Zone sends: two active 2 s zones, 4..32 of 32 voices each sending into both: slope per (voice, slot) send (the sweep
    // starts at 4 voices so that the one-off cost of the first send, the bus-gain table, is in the intercept).
    out.push(Sweep {
        term: "zone_send",
        unit: "µs per (voice, slot) send (two 2 s zones active; 32 voices, the first send also switches on the bus-gain table)",
        scenes: [4u32, 8, 16, 32]
            .iter()
            .map(|&n| Scene::zoned(Scene { zone_slots: 3, zone_frames: 2 * RATE as u32, ..Scene::looping(&format!("zone-send-{n}"), 32) }, 2, n, 2, 0))
            .collect(),
        x: |r| r.mean_senders * 2.0,
    });
    // ADR 0162 A7: the ambisonic voice (§7.1's `AMBI_READ` + `AMBI_ROTATE`): 1..16 looping clips rotated by a turning listener
    // into one MagLS bed at 3rd order and 1st order, and 3rd order into a private decoder. The slope is the whole voice (the
    // N-channel read and resample, the ramps, the gain, the rotation into the bed); the intercept holds the decode. The
    // rotation alone is `ambi_rotate` (`mode=fit term=ambi_rotate`, timed without the core), so READ is the slope less it.
    for (term, unit, order, private) in [
        ("ambi_o3", "µs per 3rd-order ambisonic voice (16 channels, into a bed)", 3, false),
        ("ambi_o1", "µs per 1st-order ambisonic voice (4 channels, into a bed)", 1, false),
        ("ambi_o3_private", "µs per 3rd-order ambisonic voice (into a private decoder)", 3, true),
    ] {
        out.push(Sweep {
            term,
            unit,
            scenes: [1u32, 2, 4, 8, 16].iter().map(|&n| Scene { ambi_order: order, ..Scene::ambient(&format!("{term}-{n}"), n, order, private) }).collect(),
            x: |r| r.mean_ambisonic,
        });
    }
    // Aux sends: no zones, 0..16 voices with an aux send (post-fader, panned): slope `AUX_SEND`.
    out.push(Sweep {
        term: "aux_send",
        unit: "µs per aux send (no zones)",
        scenes: [0u32, 4, 8, 16].iter().map(|&n| Scene { buses: 32, aux_voices: n, ..Scene::looping(&format!("aux-send-{n}"), 16) }).collect(),
        x: |r| r.mean_aux,
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
    /// ADR 0162 A7: mean voices encoded into beds, mean beds decoding, mean `workBed` (work units).
    pub mean_bed_voices: f64,
    pub mean_beds: f64,
    pub mean_work_bed: f64,
    /// Crossing scenes: voices mid-crossfade between HRTF and bed, 2 × (HRTF slots held − the window): the leaving
    /// voices hold their slot and the entering ones are in the window, so each direction counts as many.
    pub mean_transit: f64,
    pub mean_source_frames: f64,
    pub mean_moving: f64,
    /// ADR 0162 D6: mean STATUS `fxVoices` (pool entries whose filter ran) and `ambisonicVoices`.
    pub mean_fx_voices: f64,
    pub mean_ambisonic: f64,
    /// ADR 0162 C7: mean STATUS `zonesActive`, `zonesRinging` and `workZones` (work units), the largest slot wet peak seen,
    /// the zone IR seconds, mean mixed voices sending and with an aux send, and zone events (all kinds) seen.
    pub mean_zones_active: f64,
    pub mean_zones_ringing: f64,
    pub mean_work_zones: f64,
    pub zone_wet_peak: f64,
    pub zone_seconds: f64,
    pub mean_senders: f64,
    pub mean_aux: f64,
    pub zone_events: u32,
    pub standby_swaps: u32,
    pub evict_swaps: u32,
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
    /// ADR 0166 M4-0: the core's `splitQuanta` and `voiceSplits` at the run's end (cumulative since init).
    pub split_quanta: u32,
    pub voice_splits: u32,
    /// ADR 0166 M4b (Bench1): the core's music counters at the run's end, the largest STATUS block taken, and the mixed voices
    /// (last quantum).
    pub groups_held: u16,
    pub groups_late: u16,
    pub groups_abandoned: u16,
    pub group_table_full: u32,
    pub music_ring_refused: u32,
    pub music_rings_open: u16,
    pub status_max: usize,
    pub mixed_last: u16,
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
    /// `probe_automation`: the extra `begin_quantum`'s p50, p99, p99.9 and max (µs).
    pub automation: [f64; 4],
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
    /// ADR 0162 D6: what the voice stands for while mixed (the scene's counts are kept by these).
    bed: bool,
    ambi: bool,
    /// With `ambi`: on the bus with no bed.
    private: bool,
    lp: bool,
    hp: bool,
    /// ADR 0162 C7: carries zone sends / an aux send while mixed, and its ordinal among the senders (which slots it takes).
    send: bool,
    aux: bool,
    send_ord: u32,
}

/// ADR 0162 C7: main's picture of the zone table (`zones-swap` and the initial ZONE_CONFIG), and the kernel upload in flight.
struct ZoneMain {
    /// Prepared kernels (format 3 blobs), one per kernel id `ZONE_KERNEL_ID_FIRST + index`.
    blobs: Vec<Vec<u8>>,
    /// Per core slot: the kernel id it holds (0 none) and the ZONE_CONFIG state last sent for it.
    table: Vec<(u32, u32)>,
    /// Slots that were told active, oldest first.
    order: Vec<usize>,
    /// Slots taking sends, in order.
    accepting: Vec<usize>,
    swaps: u32,
    next_swap_q: u64,
    upload: Option<Upload>,
    /// Kernels to free (their slot is off).
    to_free: Vec<u32>,
    /// A slot being evicted: when it reads off, its kernel is freed and the next one uploaded into it.
    evicting: Option<usize>,
    /// Swaps performed by path, for the tests.
    standby_swaps: u32,
    evict_swaps: u32,
}

struct Upload {
    blob: usize,
    sent: usize,
    reserved: bool,
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
    /// ADR 0158 E2 (`sustain`): the next mixed voice to release, as an index into `mixed_ids`.
    release_at: usize,
    /// The stereo clips (ids `1..=stereo_clips`); the ambisonic ones follow (ADR 0162 D6).
    stereo_clips: u32,
    /// Mixed voices now standing for each of the scene's M3 counts.
    bed_now: u32,
    ambi_now: u32,
    ambi_private_now: u32,
    lp_now: u32,
    hp_now: u32,
    sends_now: u32,
    aux_now: u32,
    zone: ZoneMain,
    /// ADR 0166 M4-0 (Z5): the frame offset the next records carry (`wire::ASAP` unless the scene is stamped), the
    /// extra PLAY flags of the next start, the music scene's stems and stinger.
    stamp: u32,
    extra_flags: u16,
    stems: Vec<u32>,
    stinger: Option<u32>,
    /// ADR 0166 M4b (Bench1): the next PLAY's gate, whether the next start is a plain music voice (no spatial, filter or send
    /// terms; unity pitch; off main's mixed list so the SFX top-up and updates leave it alone), and the music scene's state.
    gate: u16,
    plain: bool,
    mus: MusicState,
}

/// A music scene's main side.
#[derive(Default)]
struct MusicState {
    /// Open music rings main keeps fed: stream id, frames fed.
    rings: Vec<(u32, u64)>,
    next_ring: u32,
    /// The ring whose feed is withheld (the held-group event), and `groupsHeld` when it was.
    withheld: Option<u32>,
    held_at: u16,
    /// The current segment's voices and rings (a transition's), the one before, and the bridge and tail.
    segment: Vec<u32>,
    segment_rings: Vec<u32>,
    voices: Vec<u32>,
    bridge: Option<u32>,
    tail: Option<u32>,
    /// Rings opened ahead for the next segment.
    next_rings: Vec<u32>,
    segments: u64,
    /// The largest STATUS block taken (bytes).
    status_max: usize,
}

/// The scene's init parameters. The arena's initial reserve holds all of the scene's clips (with
/// the size classes' rounding) and the HRTF bank, so it never grows and the block can be freed
/// after the run (wasm memory can't shrink; runs would otherwise pile up past 4 GB).
fn init_params(s: &Scene) -> InitParams {
    let kernel_mb = (audio_core::zones::kernel_budget_bytes(s.zone_slots, s.zone_frames) >> 20) as u32 + 1;
    let arena_mb = s.clip_mb + s.clip_mb / 2 + 16 + 2 * s.ambi + kernel_mb;
    InitParams { sample_rate: RATE, max_logical: s.max_logical, max_mixed: s.max_mixed, max_buses: 32, arena_initial_bytes: arena_mb << 20, max_beds: s.beds, max_wide: s.max_wide, max_zone_slots: s.zone_slots, zone_max_frames: s.zone_frames, max_music_rings: s.music_rings, ..InitParams::default() }
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

/// The committed MagLS asset (44.1 kHz, 256 taps, `[16][2][taps]` f32).
static MAGLS_ASSET: &[u8] = include_bytes!("../../../../../src/engine/audio/magls-o3.bin");

/// The asset as main would send it for `RATE`: the header's rate set to the context's (the responses stay as they
/// are: cost is independent of their values; listening needs `resampleMagls`).
fn magls_blob(rate: f32) -> Vec<u8> {
    let mut bytes = MAGLS_ASSET.to_vec();
    let (mut head, _) = wire::MaglsHeader::read(&bytes, 0).expect("the MagLS header");
    head.sample_rate = rate;
    head.write(&mut bytes, 0).expect("the MagLS header fits");
    bytes
}

/// Sends the blob as format 4 under `MAGLS_CLIP_ID` (CLIP_BEGIN with `frames` = bytes / 4, then chunks).
fn load_magls(core: &mut Core, bytes: &[u8]) {
    let id = wire::MAGLS_CLIP_ID;
    assert_eq!(clips::reserve(core, id, (bytes.len() / 4) as u32, 1, RATE, wire::clip_format::MAG_LS), wire::ERR_OK);
    for (k, chunk) in bytes.chunks(4096).enumerate() {
        let at = (k * 4096 / 4) as u32;
        let p = clips::chunk_ptr(core, id, at, chunk.len() as u32);
        assert!(!p.is_null());
        // SAFETY: chunk_ptr gave room for `chunk.len()` bytes.
        unsafe { core::ptr::copy_nonoverlapping(chunk.as_ptr(), p, chunk.len()) };
        assert_eq!(clips::commit(core, id, at, chunk.len() as u32), wire::ERR_OK);
    }
    assert!(status::counters(core).flags & audio_core::counters::flag::BED_DECODER_READY != 0, "the MagLS filters");
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

fn bytes_of(v: &mut [u64]) -> &mut [u8] {
    // SAFETY: a u64 buffer viewed as its bytes.
    unsafe { core::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, v.len() * 8) }
}

/// A prepared zone kernel (format 3) of a decaying noise IR of `frames`, seeded: what C2a's preparation would send for a
/// preset's IR (the cost of a slot depends on the kernel's length, not its values).
fn zone_kernel_blob(frames: u32, seed: u32) -> Vec<u8> {
    use audio_dsp::convolver::kernel::{kernel_bytes, prepare_ir, IrSpec};
    use audio_dsp::convolver::{Scratch, SCRATCH_BYTES};
    let mut sb = vec![0u64; SCRATCH_BYTES / 8];
    let mut scratch = Scratch::from_bytes(bytes_of(&mut sb)).unwrap();
    scratch.fill_twiddles();
    let n = kernel_bytes(frames as usize);
    let mut kb = vec![0u64; n.div_ceil(8)];
    let mut rng = Rng(seed.wrapping_mul(2_654_435_761) | 1);
    let mut i = 0u32;
    let mut next = move || {
        let t = (i % frames) as f32 / frames as f32;
        i += 1;
        (rng.unit() * 2.0 - 1.0) * (1.0 - t) * (1.0 - t)
    };
    prepare_ir(bytes_of(&mut kb), &mut scratch, IrSpec { frames: frames as usize, sample_rate: RATE, scale: 0.004, flags: 0 }, &mut next).unwrap();
    let mut out = bytes_of(&mut kb).to_vec();
    out.truncate(n);
    out
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
        } else {
            // A bench quantum never underruns, so a `-cap` scene measures the capped case with the work-unit
            // model driving the cap (§6.3's original table; production leaves the model informational).
            core.cap_mut().set_model_drives(true);
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
        // ADR 0162 D6: ambisonic clips, 1 s of 16-channel int16 noise each (looping), at ids after the stereo ones
        // (A7: 4 or 9 channels at order 1 or 2).
        let ambi_ch = (scene.ambi_order as usize + 1).pow(2);
        for k in 0..scene.ambi {
            let id = count as u32 + 1 + k;
            let frames = RATE as u32;
            core.clips_mut().reserve(id, frames, ambi_ch as u32, RATE, ClipFormat::I16).expect("ambisonic clip reserve");
            buf.clear();
            for _ in 0..frames as usize * ambi_ch {
                let s = (rng.next() >> 16) as i16 / 32;
                buf.extend_from_slice(&s.to_le_bytes());
            }
            core.clips_mut().write(id, 0, &buf).expect("ambisonic clip write");
            clip_frames.push(frames);
        }
        if scene.hrtf > 0 || scene.xfade.is_some() {
            load_hrir(&mut core, hrir.expect("the HRIR table"));
        }
        if scene.magls {
            load_magls(&mut core, &magls_blob(RATE));
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
            release_at: 0,
            stereo_clips: count as u32,
            bed_now: 0,
            ambi_now: 0,
            ambi_private_now: 0,
            lp_now: 0,
            hp_now: 0,
            sends_now: 0,
            stamp: wire::ASAP,
            extra_flags: 0,
            stems: Vec::new(),
            stinger: None,
            gate: 0,
            plain: false,
            mus: MusicState::default(),
            aux_now: 0,
            zone: ZoneMain {
                blobs: Vec::new(),
                table: vec![(0, wire::zone_slot_state::ACTIVE); scene.zone_slots as usize],
                order: Vec::new(),
                accepting: Vec::new(),
                swaps: 0,
                next_swap_q: (SWAP_FIRST_S * RATE as f64 / QUANTUM as f64).ceil() as u64,
                upload: None,
                to_free: Vec::new(),
                evicting: None,
                standby_swaps: 0,
                evict_swaps: 0,
            },
        };
        b.stream_data = (0..STREAM_CHUNK as usize * 2).map(|_| (b.rng.unit() - 0.5) * 0.1).collect();
        b.configure();
        b
    }

    /// BUS_CONFIG, the bus lanes (BUS_RAMP) and MASTER, the streams, the looping and first mixed voices.
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
        // What BUS_MIX of (0.9, lp) per bus was (B1a, 0171/0172 M5): per bus, an asap BUS_RAMP on
        // the runtime lane's gain and one on the snapshot lane's low-pass (bit-identical, R3).
        for bus in 0..s.buses as u32 {
            for (lane, mask) in [(wire::LANE_RUNTIME, wire::BUS_RAMP_MASK_GAIN), (wire::LANE_SNAPSHOT, wire::BUS_RAMP_MASK_LP_HZ)] {
                self.push(&wire::BusRamp { voice_id: bus, frame_offset: wire::ASAP, lane: lane as u16, mask, gain: 0.9, lp_hz: lp, frames: 0, shape: 0 });
            }
        }
        self.push(&wire::Master { voice_id: 0, frame_offset: wire::ASAP, volume: 0.5, muted: 0, ramp_frames: 0 });
        if s.beds > 0 {
            // One bed: hosted by bus 0. More: bed k by bus 1 + k (each a child of bus 0); bus 0 hosts none.
            let (bed_slot, host_bus): (Vec<u8>, Vec<u16>) = if s.beds == 1 {
                (vec![0], vec![0])
            } else {
                let none = wire::BED_SLOT_NONE as u8;
                (std::iter::once(none).chain(0..s.beds as u8).collect(), (1..=s.beds as u16).collect())
            };
            self.push(&wire::BedConfig { voice_id: 0, frame_offset: wire::ASAP, bed_slot, host_bus });
        }
        if s.zones_active > 0 {
            self.zones_init();
        }
        if s.bindings > 0 || s.bus_automation {
            self.push(&bench_curves());
            for slot in 0..2u16 {
                self.push(&wire::Param { voice_id: 0, frame_offset: wire::ASAP, group: 0, slot, value: 0.5, seek_per_second: 0.0 });
            }
        }
        if s.bus_automation {
            for bus in 0..s.buses {
                let bindings = vec![
                    wire::BusAutomateBindings { param: 0x8000, curve: 0, target: 0 },
                    wire::BusAutomateBindings { param: 0x8001, curve: 2, target: 2 },
                ];
                self.push(&wire::BusAutomate { voice_id: bus, frame_offset: wire::ASAP, bindings });
            }
        }
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

    /// ADR 0162 C7: prepares the scene's kernels (four for `swap`, else one per active slot), loads the first ones whole (resident
    /// before the first quantum, so their slots plan and start at once) and sends the ZONE_CONFIG that makes them active.
    fn zones_init(&mut self) {
        let s = self.scene.clone();
        let n = if s.swap { 4 } else { s.zones_active } as usize;
        self.zone.blobs = (0..n).map(|i| zone_kernel_blob(s.zone_frames, 1 + i as u32)).collect();
        for k in 0..s.zones_active as usize {
            let id = wire::ZONE_KERNEL_ID_FIRST + k as u32;
            let blob = &self.zone.blobs[k];
            assert_eq!(clips::reserve(&mut self.core, id, (blob.len() / 4) as u32, 1, RATE, wire::clip_format::ZONE_KERNEL), wire::ERR_OK, "reserve kernel {k}");
            assert_eq!(clips::write(&mut self.core, id, 0, blob), wire::ERR_OK, "write kernel {k}");
            self.zone.table[k] = (id, wire::zone_slot_state::ACTIVE);
            self.zone.order.push(k);
            self.zone.accepting.push(k);
        }
        self.push_zone_config();
    }

    /// The whole ZONE_CONFIG table as main last decided it (shared return at 0.5, no ramp).
    fn push_zone_config(&mut self) {
        let frames = self.scene.zone_frames;
        let slots = self
            .zone
            .table
            .iter()
            .map(|&(kernel_id, state)| wire::ZoneConfigSlots { kernel_id, return_bus: 0, state: state as u8, reserved: 0, wet: 1.0, ir_frames: if kernel_id == 0 { 0 } else { frames } })
            .collect();
        self.push(&wire::ZoneConfig { voice_id: 0, frame_offset: wire::ASAP, shared_return_gain: 0.5, ramp_frames: 0, slots });
    }

    /// The send levels voice ordinal `ord` takes: `sends_per_voice` of the accepting slots, starting at `ord`.
    fn send_levels(&self, ord: u32) -> [f32; 4] {
        let acc = &self.zone.accepting;
        let mut v = [0.0f32; 4];
        for j in 0..self.scene.sends_per_voice.min(acc.len() as u32) {
            v[acc[(ord + j) as usize % acc.len()]] = ZONE_SEND_LEVEL;
        }
        v
    }

    /// SET_VOICE_FX sends for every sending mixed voice (after the accepting slots changed), ramped over the frame.
    fn resend_sends(&mut self) {
        let ramp = BATCH_EVERY as u32 * QUANTUM as u32;
        for k in 0..self.mixed_ids.len() {
            let id = self.mixed_ids[k];
            let v = self.voices[(id & 0xFFFF) as usize].unwrap();
            if v.send {
                let send = self.send_levels(v.send_ord);
                self.push(&wire::SetVoiceFx { voice_id: id, frame_offset: wire::ASAP, mask: wire::SET_VOICE_FX_MASK_SENDS, ramp_frames: ramp, send, ..Default::default() });
            }
        }
    }

    /// `zones-swap`, main's side once a batch (not timed): frees the kernels of slots that went off, starts the eviction
    /// path's upload when its slot is off, and (when due and idle) starts the next swap: even swaps release the oldest
    /// active zone into the standby slot's ring-out and upload the incoming kernel into the free slot; odd swaps evict it.
    fn zone_step(&mut self, q: u64) {
        let slots = self.zone.table.len();
        let every = (SWAP_EVERY_S * RATE as f64 / QUANTUM as f64) as u64;
        let mut changed = false;
        for k in 0..slots {
            let (id, state) = self.zone.table[k];
            if id != 0 && state != wire::zone_slot_state::ACTIVE && zones::slot_state(&self.core, k) == wire::zone_state::OFF as u8 {
                self.zone.to_free.push(id);
                self.zone.table[k] = (0, wire::zone_slot_state::ACTIVE);
                if self.zone.evicting == Some(k) {
                    self.zone.evicting = None;
                    self.start_upload(k);
                    changed = true;
                }
            }
        }
        if self.scene.swap && q >= self.zone.next_swap_q && self.zone.upload.is_none() && self.zone.evicting.is_none() && self.zone.order.len() >= 2 {
            let victim = self.zone.order[0];
            if self.zone.swaps % 2 == 0 {
                // Standby path: a slot with no kernel takes the incoming zone while the victim rings out.
                if let Some(free) = (0..slots).find(|&k| self.zone.table[k].0 == 0 && !self.zone.order.contains(&k)) {
                    self.zone.order.remove(0);
                    self.zone.accepting.retain(|&k| k != victim);
                    self.zone.table[victim].1 = wire::zone_slot_state::RELEASE;
                    self.start_upload(free);
                    self.zone.standby_swaps += 1;
                    self.zone.swaps += 1;
                    self.zone.next_swap_q += every;
                    changed = true;
                }
            } else {
                // Eviction path: the victim fades out in 150 ms; its slot takes the incoming kernel once it is off.
                self.zone.order.remove(0);
                self.zone.accepting.retain(|&k| k != victim);
                self.zone.table[victim].1 = wire::zone_slot_state::EVICT;
                self.zone.evicting = Some(victim);
                self.zone.evict_swaps += 1;
                self.zone.swaps += 1;
                self.zone.next_swap_q += every;
                changed = true;
            }
        }
        if changed {
            self.push_zone_config();
            self.resend_sends();
        }
    }

    /// Starts uploading the next kernel no slot holds into slot `k` (told active at once: it waits for the kernel).
    fn start_upload(&mut self, k: usize) {
        let blob = (0..self.zone.blobs.len()).find(|&i| !self.zone.table.iter().any(|t| t.0 == wire::ZONE_KERNEL_ID_FIRST + i as u32)).expect("a free kernel id");
        self.zone.table[k] = (wire::ZONE_KERNEL_ID_FIRST + blob as u32, wire::zone_slot_state::ACTIVE);
        self.zone.order.push(k);
        self.zone.accepting.push(k);
        self.zone.upload = Some(Upload { blob, sent: 0, reserved: false });
    }

    /// The kernel traffic of a swap, per quantum (timed: the audio thread's `onmessage` work): frees, then the reserve, then
    /// one chunk of the kernel a quantum; the chunk that completes it starts the waiting slot (`zones::kernel_resident`).
    fn pump_zones(&mut self) {
        for id in std::mem::take(&mut self.zone.to_free) {
            assert_eq!(clips::free(&mut self.core, id), wire::ERR_OK, "free kernel");
        }
        let Some(u) = self.zone.upload.as_mut() else { return };
        let id = wire::ZONE_KERNEL_ID_FIRST + u.blob as u32;
        let blob = &self.zone.blobs[u.blob];
        if !u.reserved {
            assert_eq!(clips::reserve(&mut self.core, id, (blob.len() / 4) as u32, 1, RATE, wire::clip_format::ZONE_KERNEL), wire::ERR_OK, "reserve swapped kernel");
            u.reserved = true;
            return;
        }
        let n = (blob.len() - u.sent).min(clips::MAX_CHUNK_BYTES);
        let at = (u.sent / 4) as u32;
        let p = clips::chunk_ptr(&mut self.core, id, at, n as u32);
        assert!(!p.is_null(), "kernel chunk");
        // SAFETY: chunk_ptr gave room for `n` bytes.
        unsafe { core::ptr::copy_nonoverlapping(blob[u.sent..].as_ptr(), p, n) };
        assert_eq!(clips::commit(&mut self.core, id, at, n as u32), wire::ERR_OK, "commit kernel chunk");
        u.sent += n;
        if u.sent >= blob.len() {
            self.zone.upload = None;
        }
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
    fn start(&mut self, stream: Option<u32>, mixed: bool) -> Option<u32> {
        let index = self.free.pop()?;
        let g = &mut self.gens[index as usize];
        *g = g.wrapping_add(1).max(1);
        let id = ((*g as u32) << 16) | index;
        let s = self.scene.clone();
        let looping = stream.is_some() || !mixed || !(s.one_shots || s.sustain);
        let plain = self.plain;
        let hrtf = mixed && !plain && self.hrtf_now < s.hrtf;
        // ADR 0162 D6: the scene's M3 counts are kept by what the mixed voices stand for (streams stay plain).
        let eligible = mixed && stream.is_none() && !plain;
        let ambi = eligible && self.ambi_now < s.ambi;
        let ambi_private = ambi && self.ambi_private_now < s.ambi_private;
        let bed = eligible && !ambi && !hrtf && self.bed_now < s.bed_voices;
        let lp = eligible && !ambi && self.lp_now < s.voice_lp;
        let hp = eligible && !ambi && self.hp_now < s.voice_hp;
        let send = eligible && !ambi && self.sends_now < s.zone_sends;
        let aux = eligible && !ambi && self.aux_now < s.aux_voices;
        let send_ord = self.sends_now;
        let looping = looping || ambi;
        let clip = match stream {
            Some(sid) => sid,
            // (A7: the ambisonic arm comes first: in a looping scene the next arm would give them a stereo clip.)
            None if ambi => self.stereo_clips + 1 + self.ambi_now,
            None if mixed && !s.one_shots => {
                // Looping mixed voices each read their own clip.
                let n = self.stereo_clips;
                1 + (self.mixed_ids.len() as u32 % n)
            }
            None if mixed => self.next_clip(),
            None => 1 + self.rng.below(self.stereo_clips),
        };
        // Bed scenes: with several beds the voices spread over their host buses (1..=beds).
        let bus = if plain {
            3 % s.buses as u16
        } else if ambi_private {
            assert!(s.beds != 1, "a private ambisonic voice needs a bus with no bed");
            0
        } else if s.beds > 1 && (bed || ambi) {
            1 + self.rng.below(s.beds) as u16
        } else {
            self.rng.below(s.buses) as u16
        };
        let ordinal = self.mixed_ids.len() as u32;
        let phase = self.rng.unit() * 6.283;
        let mut flags = if ambi || plain { 0 } else { wire::PLAY_FLAGS_SPATIAL } | self.extra_flags;
        if ambi {
            flags |= wire::PLAY_FLAGS_AMBISONIC;
        }
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
        if let (true, Some(step)) = (mixed, s.xfade) {
            flags |= (xfade_kind(ordinal, 0, step, s.mixed) as u16) << wire::PLAY_FLAGS_PANNER_SHIFT;
        } else if bed {
            flags |= (wire::panner::BED as u16) << wire::PLAY_FLAGS_PANNER_SHIFT;
        }
        let frames = if stream.is_some() { 0 } else { self.clip_frames[clip as usize] };
        // Looping and first voices start anywhere in their clip, so ends spread out.
        let offset = if s.sustain && mixed {
            self.rng.below(frames / 3 + 1)
        } else if frames > 0 && (looping || self.starts == 0) {
            self.rng.below(frames)
        } else {
            0
        };
        let pitch = if stream.is_some() || plain { 1.0 } else { self.pitch() };
        let score = self.rng.unit();
        self.push(&wire::Play {
            voice_id: id,
            frame_offset: self.stamp,
            clip,
            bus,
            flags,
            gain: 0.3,
            pitch,
            dir_x: libm::sinf(phase),
            dir_y: 0.0,
            dir_z: -libm::cosf(phase),
            lp_hz: if lp { LP_START_HZ } else { wire::BUS_LP_OFF_HZ as f32 },
            score,
            start_offset_frames: offset,
            group: if s.bindings > 0 { 1 + (index % 1_024) as u16 } else { 0 },
            gate: self.gate,
            ..Default::default()
        });
        if hp {
            self.push(&wire::SetVoiceFx { voice_id: id, frame_offset: wire::ASAP, mask: wire::SET_VOICE_FX_MASK_HP_HZ, hp_hz: HP_START_HZ, ..Default::default() });
        }
        if send || aux {
            let mut mask = 0;
            let mut levels = [0.0f32; 4];
            if send {
                mask |= wire::SET_VOICE_FX_MASK_SENDS;
                levels = self.send_levels(send_ord);
            }
            if aux {
                mask |= wire::SET_VOICE_FX_MASK_AUX;
            }
            self.push(&wire::SetVoiceFx {
                voice_id: id,
                frame_offset: self.stamp,
                mask,
                send: levels,
                aux_level: if aux { AUX_LEVEL } else { 0.0 },
                aux_bus: if aux { AUX_BUS } else { wire::AUX_BUS_NONE as u16 },
                ..Default::default()
            });
        }
        if s.bindings > 0 && stream.is_none() {
            let all = [(0x8000u16, 0u16, 0u32), (0, 1, 1), (0x8001, 2, 2)];
            let bindings = all[..s.bindings.min(3) as usize].iter().map(|&(param, curve, target)| wire::AutomateBindings { param, curve, target }).collect();
            self.push(&wire::Automate { voice_id: id, frame_offset: wire::ASAP, bindings });
        }
        if s.sustain && mixed && stream.is_none() {
            // A region in the clip's middle third; the voice starts before it.
            self.push(&wire::SetLoop { voice_id: id, frame_offset: wire::ASAP, loop_start_frame: frames / 3, loop_end_frame: 2 * frames / 3, flags: wire::SET_LOOP_FLAGS_LOOPING });
        }
        // A plain music voice stays off main's mixed list (the core counts it in the cap all the same).
        let mut v = Voice { id, mixed: mixed && !plain, hrtf, at: u32::MAX, phase, bed, ambi, private: ambi_private, lp, hp, send, aux, send_ord };
        if mixed && !plain {
            v.at = self.mixed_ids.len() as u32;
            self.mixed_ids.push(id);
            self.hrtf_now += hrtf as u32;
            self.bed_now += bed as u32;
            self.ambi_now += ambi as u32;
            self.ambi_private_now += ambi_private as u32;
            self.lp_now += lp as u32;
            self.hp_now += hp as u32;
            self.sends_now += send as u32;
            self.aux_now += aux as u32;
        }
        self.voices[index as usize] = Some(v);
        Some(id)
    }

    /// Main's view loses a mixed voice (ended or demoted).
    fn unmix(&mut self, index: usize) {
        let Some(v) = self.voices[index].as_mut() else { return };
        if !v.mixed {
            return;
        }
        v.mixed = false;
        let (at, hrtf, bed, ambi, private, lp, hp, send, aux) = (v.at as usize, v.hrtf, v.bed, v.ambi, v.private, v.lp, v.hp, v.send, v.aux);
        v.hrtf = false;
        (v.bed, v.ambi, v.private, v.lp, v.hp, v.send, v.aux) = (false, false, false, false, false, false, false);
        self.hrtf_now -= hrtf as u32;
        self.bed_now -= bed as u32;
        self.ambi_now -= ambi as u32;
        self.ambi_private_now -= private as u32;
        self.lp_now -= lp as u32;
        self.hp_now -= hp as u32;
        self.sends_now -= send as u32;
        self.aux_now -= aux as u32;
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

    /// ADR 0166 M4-0 (Z5), main's work for one quantum of a `stamped-*` scene or its twin: the quantum's records, each at
    /// its own frame inside the quantum when stamped (varied across it, so the due list takes them in any order of
    /// arrival), else `ASAP`.
    fn build_per_quantum(&mut self, q: u64, per: Per) {
        let s = self.scene.clone();
        let stamped = s.stamped;
        let at = |k: u64| if stamped { 8 + ((q * 53 + k * 29) % 112) as u32 } else { wire::ASAP };
        match per {
            Per::Fade => {
                let id = self.mixed_ids[q as usize % self.mixed_ids.len()];
                // Down to 0.4 and back up, each over 6 quanta, so a voice's fade is mostly moving.
                let target = if (q / self.mixed_ids.len() as u64) % 2 == 0 { 0.4 } else { 1.0 };
                self.push(&wire::Fade { voice_id: id, frame_offset: at(0), target, frames: 6 * QUANTUM as u32, flags: 0, shape: 0 });
            }
            Per::Spatial => {
                self.stamp = at(0);
                while (self.mixed_ids.len() as u32) < s.mixed && !self.free.is_empty() {
                    self.start(None, true);
                    self.starts += 1;
                    self.stamp = at(self.starts);
                }
                // A low-pass ramp on one voice with a filter, over the next 6 quanta.
                for k in 0..self.mixed_ids.len() {
                    let id = self.mixed_ids[(q as usize + k) % self.mixed_ids.len()];
                    if self.voices[(id & 0xFFFF) as usize].is_some_and(|v| v.lp) {
                        let u = 0.5 + 0.5 * libm::sinf(0.03 * q as f32 + k as f32);
                        let lp_hz = LP_RANGE.0 * libm::powf(LP_RANGE.1 / LP_RANGE.0, u);
                        self.push(&wire::SetParams { voice_id: id, frame_offset: at(1), mask: wire::SET_PARAMS_MASK_LP_HZ, lp_hz, ramp_frames: 6 * QUANTUM as u32, ..Default::default() });
                        break;
                    }
                }
                self.stamp = wire::ASAP;
            }
            Per::Loop => {
                let id = self.mixed_ids[q as usize % self.mixed_ids.len()];
                let frames = self.clip_frames[(1 + (id & 0xFFFF) % self.stereo_clips) as usize].max(8);
                // Two nested regions, alternately (the voice is wherever it is: it wraps into the new region).
                let (a, b) = if (q / self.mixed_ids.len() as u64) % 2 == 0 { (frames / 4, 3 * frames / 4) } else { (frames / 8, 7 * frames / 8) };
                self.push(&wire::SetLoop { voice_id: id, frame_offset: at(0), loop_start_frame: a, loop_end_frame: b, flags: wire::SET_LOOP_FLAGS_LOOPING });
            }
            Per::BusRamp(n, ramp_q) => {
                if q % 4 == 0 {
                    let gain = if ramp_q == 0 { 1.0 } else if (q / 4) % 2 == 0 { 0.6 } else { 0.9 };
                    for bus in 0..n {
                        self.push(&wire::BusRamp { voice_id: bus, frame_offset: at(bus as u64), lane: wire::LANE_RUNTIME as u16, mask: wire::BUS_RAMP_MASK_GAIN, gain, lp_hz: wire::BUS_LP_OFF_HZ as f32, frames: ramp_q * QUANTUM as u32, shape: 0 });
                    }
                }
            }
            Per::Music => {
                if self.stems.is_empty() {
                    self.stems = self.mixed_ids.clone();
                }
                let equal_in = wire::pack_shape(wire::fade_law::EQUAL_POWER_IN, 0);
                let equal_out = wire::pack_shape(wire::fade_law::EQUAL_POWER_OUT, 0);
                match q % 32 {
                    // An equal-power crossfade of one stem into its replacement over 2,048 frames (16 quanta).
                    4 => {
                        let stem = (q / 32) as usize % self.stems.len();
                        let old = self.stems[stem];
                        self.stamp = at(0);
                        self.extra_flags = wire::PLAY_FLAGS_FADE_ZERO;
                        let new = self.start(None, true);
                        self.extra_flags = 0;
                        self.stamp = wire::ASAP;
                        if let Some(new) = new {
                            self.push(&wire::Fade { voice_id: old, frame_offset: at(0), target: 0.0, frames: 2_048, flags: wire::FADE_FLAGS_STOP_AT_END, shape: equal_out });
                            self.push(&wire::Fade { voice_id: new, frame_offset: at(0), target: 1.0, frames: 2_048, flags: 0, shape: equal_in });
                            self.stems[stem] = new;
                        }
                    }
                    // A stinger starts.
                    20 => {
                        self.stamp = at(2);
                        self.stinger = self.start(None, true);
                        self.stamp = wire::ASAP;
                    }
                    // And is stopped with a 600-frame equal-power fade.
                    28 => {
                        if let Some(id) = self.stinger.take() {
                            self.push(&wire::Stop { voice_id: id, frame_offset: at(3), fade_frames: 600, reason: 0, shape: equal_out });
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    /// The frame's batch (main's work, not timed): replacement one-shots up to the mixed target
    /// (`min(mixed, mixedCap)` with the cap), HRTF directions, parameter updates.
    fn build_batch(&mut self, q: u64) {
        if let Some(per) = self.scene.per_quantum {
            return self.build_per_quantum(q, per);
        }
        if let Some(music) = self.scene.music {
            // Music's records every quantum; the preset's SFX work (below) only on a batch frame.
            self.build_music(q, music);
            if q % BATCH_EVERY != 0 {
                return;
            }
        }
        let s = self.scene.clone();
        if s.zones_active > 0 {
            self.zone_step(q);
        }
        let mut target = s.mixed;
        if s.cap {
            target = target.min(status::counters(&self.core).mixed_cap as u32);
        }
        if s.one_shots || s.sustain {
            while (self.mixed_ids.len() as u32) < target && !self.free.is_empty() {
                self.start(None, true);
                self.starts += 1;
            }
        }
        let t = q as f32 * QUANTUM as f32 / RATE;
        if s.listener && q % BATCH_EVERY == 0 {
            // ADR 0162 A7: the head turns 0.5 rad/s in yaw with a slow nod (0.3 rad at 0.7 rad/s), q = qy(yaw) * qx(pitch),
            // slerped over the batch's frames (the next LISTENER arrives as the ramp ends).
            let (ha, hb) = (0.25 * t, 0.15 * libm::sinf(0.7 * t));
            let (sa, ca, sb, cb) = (libm::sinf(ha), libm::cosf(ha), libm::sinf(hb), libm::cosf(hb));
            self.push(&wire::Listener { voice_id: 0, frame_offset: wire::ASAP, qx: ca * sb, qy: sa * cb, qz: -sa * sb, qw: ca * cb, ramp_frames: BATCH_EVERY as u32 * QUANTUM as u32, flags: 0 });
        }
        if s.bindings > 0 || s.bus_automation {
            // ADR 0158 E2: the globals seek toward new targets every batch (≈ 0.25 s to cross), and 32 groups' locals.
            for slot in 0..2u16 {
                let value = 0.5 + 0.5 * libm::sinf(t * (1.0 + slot as f32));
                self.push(&wire::Param { voice_id: 0, frame_offset: wire::ASAP, group: 0, slot, value, seek_per_second: 4.0 });
            }
            if s.bindings > 0 {
                for k in 0..32u64 {
                    let group = 1 + ((q / BATCH_EVERY * 32 + k) % (s.mixed + s.virtual_voices).max(1) as u64) as u16;
                    let value = self.rng.unit();
                    self.push(&wire::Param { voice_id: 0, frame_offset: wire::ASAP, group, slot: 0, value, seek_per_second: 2.0 });
                }
            }
        }
        if s.sustain {
            // Two releases a batch (key-offs): those voices play their tails and end, and new ones replace them.
            for _ in 0..2 {
                if self.mixed_ids.is_empty() {
                    break;
                }
                self.release_at = (self.release_at + 1) % self.mixed_ids.len();
                let id = self.mixed_ids[self.release_at];
                self.push(&wire::SetLoop { voice_id: id, frame_offset: wire::ASAP, loop_start_frame: 0, loop_end_frame: 0, flags: 0 });
            }
        }
        let ramp = if s.ramps { (BATCH_EVERY as u32) * QUANTUM as u32 } else { 0 };
        for k in 0..self.mixed_ids.len() {
            let id = self.mixed_ids[k];
            let v = self.voices[(id & 0xFFFF) as usize].unwrap();
            if v.ambi {
                // Ambisonic clips follow the listener, not a direction.
                continue;
            }
            let turning = v.hrtf && s.moving;
            // The window crosses `xfade` voices each way every batch.
            let crossing = if let Some(step) = s.xfade {
                let b = q / BATCH_EVERY;
                let (now, before) = (xfade_kind(k as u32, b, step, s.mixed), xfade_kind(k as u32, b.saturating_sub(1), step, s.mixed));
                (b > 0 && now != before).then_some(now)
            } else {
                None
            };
            if v.hp {
                // D1's high-pass: a log-uniform sweep, a slow sine per voice (its own rate), ramped over the frame.
                let u = 0.5 + 0.5 * libm::sinf(0.9 * t + 2.0 * v.phase);
                let hp_hz = HP_RANGE.0 * libm::powf(HP_RANGE.1 / HP_RANGE.0, u);
                self.push(&wire::SetVoiceFx { voice_id: id, frame_offset: wire::ASAP, mask: wire::SET_VOICE_FX_MASK_HP_HZ, ramp_frames: ramp, hp_hz, ..Default::default() });
            }
            if !(turning || crossing.is_some() || v.lp || (s.updates && !v.hrtf)) {
                continue;
            }
            // Turning: 120° a second; otherwise a slow drift.
            let w = if turning { 2.094 } else { 0.2 };
            let a = v.phase + w * t;
            let mut mask = wire::SET_PARAMS_MASK_DIR;
            if s.updates {
                mask |= wire::SET_PARAMS_MASK_GAIN;
            }
            let mut lp_hz = 0.0;
            if v.lp {
                // D1's low-pass: the same kind of sweep, ramped in log-Hz by the core over `ramp`.
                let u = 0.5 + 0.5 * libm::sinf(0.6 * t + v.phase);
                lp_hz = LP_RANGE.0 * libm::powf(LP_RANGE.1 / LP_RANGE.0, u);
                mask |= wire::SET_PARAMS_MASK_LP_HZ;
            }
            let mut flags = 0;
            if let Some(kind) = crossing {
                mask |= wire::SET_PARAMS_MASK_FLAGS;
                flags = wire::SET_PARAMS_FLAGS_MIXED | wire::SET_PARAMS_FLAGS_SPATIAL | wire::SET_PARAMS_FLAGS_LOOP | ((kind as u32) << wire::SET_PARAMS_FLAGS_PANNER_SHIFT);
            }
            self.push(&wire::SetParams {
                voice_id: id,
                frame_offset: wire::ASAP,
                flags,
                mask,
                gain: 0.25 + 0.05 * libm::sinf(a),
                lp_hz,
                dir_x: libm::sinf(a),
                dir_z: -libm::cosf(a),
                ramp_frames: ramp,
                ..Default::default()
            });
        }
    }

    /// Opens a music ring main will feed; returns its stream id.
    fn open_music_ring(&mut self) -> u32 {
        let id = MUSIC_STREAM_ID + self.mus.next_ring;
        self.mus.next_ring += 1;
        let o = wire::StreamOpen { stream_id: id, channels: 2, sample_rate: RATE, total_frames: wire::STREAM_TOTAL_FRAMES_UNKNOWN, flags: wire::STREAM_OPEN_FLAG_MUSIC, epoch: 1, ..Default::default() };
        assert!(self.core.streams_mut().open(&o), "music stream open");
        self.mus.rings.push((id, 0));
        id
    }

    /// STREAM_CLOSE of a retired ring: freed when its voice ends. Main stops feeding it.
    fn close_music_ring(&mut self, id: u32) {
        self.mus.rings.retain(|r| r.0 != id);
        assert!(self.core.streams_mut().close(id), "music stream close");
    }

    /// A plain music voice: on a ring (`ring`) or a decoded looping clip, gated (`gate`, 0 none), stamped at `at` (a frame in
    /// this quantum), fading from zero when `fade_zero`.
    fn start_music(&mut self, ring: Option<u32>, gate: u16, at: u32, fade_zero: bool) -> u32 {
        (self.plain, self.gate, self.stamp) = (true, gate, at);
        self.extra_flags = wire::PLAY_FLAGS_LOOP | if fade_zero { wire::PLAY_FLAGS_FADE_ZERO } else { 0 };
        let id = self.start(ring, true).expect("a free voice for music");
        (self.plain, self.gate, self.stamp, self.extra_flags) = (false, 0, wire::ASAP, 0);
        id
    }

    fn fade_music(&mut self, id: u32, at: u32, target: f32, frames: u32, stop: bool, law_in: bool) {
        let law = if law_in { wire::fade_law::EQUAL_POWER_IN } else { wire::fade_law::EQUAL_POWER_OUT };
        let flags = if stop { wire::FADE_FLAGS_STOP_AT_END } else { 0 };
        self.push(&wire::Fade { voice_id: id, frame_offset: at, target, frames, flags, shape: wire::pack_shape(law, 0) });
    }

    /// ADR 0166 M4b (Bench1), main's work for one quantum of a music scene: starts, fades and stops stamped inside the
    /// quantum (varied across it), rings opened ahead of the groups that use them. [`MusicKind`] says what each plays.
    fn build_music(&mut self, q: u64, m: Music) {
        let at = |k: u64| 8 + ((q * 53 + k * 29) % 112) as u32;
        match m.kind {
            MusicKind::Typical => {
                if q == MUSIC_START_Q - 4 && m.streamed {
                    for _ in 0..8 {
                        let id = self.open_music_ring();
                        self.mus.next_rings.push(id);
                    }
                }
                if q == MUSIC_START_Q {
                    let stamp = at(0);
                    for k in 0..8 {
                        let ring = m.streamed.then(|| self.mus.next_rings[k]);
                        let id = self.start_music(ring, wire::pack_gate(1, 8), stamp, false);
                        self.mus.voices.push(id);
                    }
                }
                if q > MUSIC_START_Q && q % 16 == 0 {
                    // One stem fading at a time: down to 0.4 and back, over 16 quanta each.
                    let id = self.mus.voices[(q / 16) as usize % 8];
                    let down = (q / 128) % 2 == 0;
                    self.fade_music(id, at(1), if down { 0.4 } else { 1.0 }, MUSIC_XFADE, false, !down);
                }
                // The held group. Streamed: ring 0's feed stops until it runs dry (a ring holds 32,768 frames), the group
                // holds and resumes once it is fed again. Decoded: a group of three with two members present waits for the
                // third, and the core gives it up after a second.
                if m.streamed {
                    if q == 300 {
                        self.mus.withheld = Some(self.mus.next_rings[0]);
                        self.mus.held_at = status::counters(&self.core).music.groups_held;
                    }
                    if self.mus.withheld.is_some() && (status::counters(&self.core).music.groups_held > self.mus.held_at || q >= 700) {
                        self.mus.withheld = None;
                    }
                } else if q >= 20 && (q - 20) % 480 == 0 {
                    let stamp = at(2);
                    for _ in 0..2 {
                        let id = self.start_music(None, wire::pack_gate(2, 3), stamp, false);
                        self.mus.tail = Some(id);
                    }
                }
            }
            MusicKind::Transition => {
                let t = q.wrapping_sub(MUSIC_START_Q) % MUSIC_CYCLE_Q;
                if q + 4 >= MUSIC_START_Q && (q + 4 - MUSIC_START_Q) % MUSIC_CYCLE_Q == 0 && m.streamed {
                    // Rings for the next segment, primed from now.
                    self.mus.next_rings.clear();
                    for _ in 0..4 {
                        let id = self.open_music_ring();
                        self.mus.next_rings.push(id);
                    }
                }
                if q >= MUSIC_START_Q && t == 0 {
                    // The seam: the next segment's group starts stamped and fades in, the last one fades out and stops, a
                    // bridge starts, a tail span of the last segment starts.
                    let n = self.mus.segments;
                    self.mus.segments += 1;
                    let gid = 1 + (n % 2) as u32;
                    let stamp = at(0);
                    let rings = std::mem::take(&mut self.mus.next_rings);
                    let mut next = Vec::new();
                    for k in 0..4 {
                        let ring = m.streamed.then(|| rings[k]);
                        let id = self.start_music(ring, wire::pack_gate(gid, 4), stamp, n > 0);
                        if n > 0 {
                            self.fade_music(id, stamp, 1.0, MUSIC_XFADE, false, true);
                        }
                        next.push(id);
                    }
                    for id in std::mem::replace(&mut self.mus.segment, next) {
                        self.fade_music(id, stamp, 0.0, MUSIC_XFADE, true, false);
                    }
                    for id in std::mem::replace(&mut self.mus.segment_rings, rings) {
                        self.close_music_ring(id);
                    }
                    self.mus.bridge = Some(self.start_music(None, 0, at(2), false));
                    self.mus.tail = (n > 0).then(|| self.start_music(None, 0, at(3), false));
                }
                if t == 40 {
                    if let Some(id) = self.mus.bridge.take() {
                        self.push(&wire::Stop { voice_id: id, frame_offset: at(4), fade_frames: 600, reason: 0, shape: wire::pack_shape(wire::fade_law::EQUAL_POWER_OUT, 0) });
                    }
                }
                if t == 60 {
                    if let Some(id) = self.mus.tail.take() {
                        self.push(&wire::Stop { voice_id: id, frame_offset: at(5), fade_frames: MUSIC_XFADE, reason: 0, shape: wire::pack_shape(wire::fade_law::EQUAL_POWER_OUT, 0) });
                    }
                }
            }
            MusicKind::Worst => {
                if q == MUSIC_START_Q - 4 && m.streamed {
                    for _ in 0..MUSIC_RINGS {
                        let id = self.open_music_ring();
                        self.mus.next_rings.push(id);
                    }
                }
                if q == MUSIC_START_Q {
                    // 12 stems and 4 stingers, each its own group: the table's 16 entries. Streamed, the rings take the
                    // first 8 stems.
                    for k in 0..16usize {
                        let ring = (m.streamed && k < MUSIC_RINGS as usize).then(|| self.mus.next_rings[k]);
                        let id = self.start_music(ring, wire::pack_gate(1 + k as u32, 1), at(k as u64), false);
                        self.mus.voices.push(id);
                    }
                }
                if q > MUSIC_START_Q {
                    // Every voice fading all the time: each voice a new 6-quantum fade every 6 quanta.
                    let down = (q / 6) % 2 == 0;
                    for k in 0..16usize {
                        if (q + k as u64) % 6 == 0 {
                            let id = self.mus.voices[k];
                            self.fade_music(id, at(k as u64), if down { 0.4 } else { 1.0 }, 6 * QUANTUM as u32, false, !down);
                        }
                    }
                }
            }
        }
    }

    /// Feeds the music rings: a chunk a quantum while the ring has room (the credit window), except the withheld one.
    fn feed_music(&mut self) {
        for k in 0..self.mus.rings.len() {
            let id = self.mus.rings[k].0;
            if self.mus.withheld == Some(id) {
                continue;
            }
            let Ok(p) = self.core.streams_mut().chunk_ptr(id, STREAM_CHUNK) else { continue };
            // SAFETY: room for STREAM_CHUNK stereo f32 frames.
            unsafe { core::ptr::copy_nonoverlapping(self.stream_data.as_ptr(), p as *mut f32, self.stream_data.len()) };
            if self.core.streams_mut().commit(id, STREAM_CHUNK, 1, 0) == wire::ERR_OK {
                self.mus.rings[k].1 += STREAM_CHUNK as u64;
            }
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
wire_record!(wire::ZoneConfig, wire::BedConfig, wire::Play, wire::SetParams, wire::BusConfig, wire::BusRamp, wire::Master, wire::Automate, wire::BusAutomate, wire::Curves, wire::Param, wire::SetLoop, wire::SetVoiceFx, wire::Listener, wire::Fade, wire::Stop);

/// ADR 0158 E2: the automation scenes' curves. 0 volume over 0..1 (a smooth rise, 8 keys), 1 pitch 0.8..1.25
/// (easeIn), 2 lowpass 800..20,000 Hz (easeOut, 16 keys, so the search takes a few steps).
fn bench_curves() -> wire::Curves {
    let key = |x: f32, y: f32, interp: u32| wire::CurvesCurvesKeys { x, y, interp };
    let volume = (0..8).map(|i| key(i as f32 / 7.0, 0.2 + 0.8 * (i as f32 / 7.0), 2)).collect();
    let pitch = vec![key(0.0, 0.8, 3), key(1.0, 1.25, 0)];
    let lowpass = (0..16).map(|i| key(i as f32 / 15.0, 800.0 + 19_200.0 * (i as f32 / 15.0) * (i as f32 / 15.0), 4)).collect();
    wire::Curves {
        voice_id: 0,
        frame_offset: wire::ASAP,
        first_curve: 0,
        curves: [volume, pitch, lowpass].into_iter().map(|keys| wire::CurvesCurves { reserved: 0, keys }).collect(),
    }
}

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
    let (mut sum_bed_voices, mut sum_beds, mut sum_work_bed) = (0f64, 0f64, 0f64);
    let (mut sum_fx, mut sum_ambi) = (0f64, 0f64);
    let (mut sum_zact, mut sum_zring, mut sum_zwork, mut sum_senders, mut sum_aux) = (0f64, 0f64, 0f64, 0f64, 0f64);
    let mut status_buf = vec![0u8; wire::STATUS_BUFFER_BYTES as usize];
    let mut probe: Vec<f32> = Vec::new();
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
        } else if q % BATCH_EVERY == 0 || scene.per_quantum.is_some() || scene.music.is_some() {
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
        b.feed_music();
        b.pump_zones();
        if scene.probe_automation {
            let t1 = platform::now_us();
            audio_core::automation::begin_quantum(&mut b.core);
            let pt = platform::now_us() - t1;
            if recording {
                probe.push(pt as f32);
            }
        }
        b.core.process(frame);
        status::after_quantum(&mut b.core);
        clips::flush_events(&mut b.core);
        let mut dt = platform::now_us() - t0;
        if q % BATCH_EVERY == BATCH_EVERY - 1 {
            if recording {
                r.zone_events += status::counters(&b.core).spatial.zone_events.as_slice().len() as u32;
            }
            b.read_status();
            let t1 = platform::now_us();
            let taken = status::take(&mut b.core, &mut status_buf, 1);
            dt += platform::now_us() - t1;
            b.mus.status_max = b.mus.status_max.max(taken);
        }
        if recording {
            let c = status::counters(&b.core);
            let w = b.core.cap().render_work();
            let (src, xf, kern) = (w.source_frames, w.hrtf_crossfading, w.hrtf_kernels);
            sum_moving += w.moving as f64;
            times.push(dt as f32);
            wus.push(b.core.work_units() as f32);
            sum_bed_voices += c.spatial.bed_voices as f64;
            sum_beds += c.spatial.beds_active as f64;
            sum_work_bed += c.spatial.work_bed as f64;
            sum_fx += c.spatial.fx_voices as f64;
            sum_ambi += c.spatial.ambisonic_voices as f64;
            sum_zact += c.spatial.zones_active as f64;
            sum_zring += c.spatial.zones_ringing as f64;
            sum_zwork += c.spatial.work_zones as f64;
            sum_senders += b.sends_now as f64;
            sum_aux += b.aux_now as f64;
            for z in c.spatial.sent_zones() {
                r.zone_wet_peak = r.zone_wet_peak.max(z.wet_peak as f64);
            }
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
    r.mean_bed_voices = sum_bed_voices / n;
    r.mean_beds = sum_beds / n;
    r.mean_work_bed = sum_work_bed / n;
    r.mean_fx_voices = sum_fx / n;
    r.mean_ambisonic = sum_ambi / n;
    r.mean_zones_active = sum_zact / n;
    r.mean_zones_ringing = sum_zring / n;
    r.mean_work_zones = sum_zwork / n;
    r.mean_senders = sum_senders / n;
    r.mean_aux = sum_aux / n;
    r.zone_seconds = if scene.zones_active > 0 { scene.zone_frames as f64 / RATE as f64 } else { 0.0 };
    r.standby_swaps = b.zone.standby_swaps;
    r.evict_swaps = b.zone.evict_swaps;
    r.mean_source_frames = sum_src / n;
    r.mean_moving = sum_moving / n;
    r.mean_hrtf = h_v.iter().map(|&x| x as f64).sum::<f64>() / n;
    r.mean_crossfading = xf_v.iter().map(|&x| x as f64).sum::<f64>() / n;
    r.mean_kernels = k_v.iter().map(|&x| x as f64).sum::<f64>() / n;
    r.mean_transit = if scene.xfade.is_some() { 2.0 * (r.mean_hrtf - XFADE_WINDOW as f64).max(0.0) } else { 0.0 };
    r.records_per_quantum = (b.records_sent - records_at_warm) as f64 / n;
    r.starts_per_quantum = (b.starts - starts_at_warm) as f64 / n;
    r.demoted = b.core.cap().demoted;
    let music = &status::counters(&b.core).music;
    (r.groups_held, r.groups_late, r.groups_abandoned, r.group_table_full, r.music_ring_refused, r.music_rings_open) = (music.groups_held, music.groups_late, music.groups_abandoned, music.group_table_full, music.music_ring_refused, music.music_rings_open);
    r.status_max = b.mus.status_max;
    r.mixed_last = status::counters(&b.core).mixed_voices;
    (r.split_quanta, r.voice_splits) = (music.split_quanta, music.voice_splits);
    if scene.stamped {
        // M4-0's exit: stamped per-voice records apply inside their voice. A whole-quantum split here is a regression, and
        // so is a stamped scene whose records never reached the due list (a class S scene splits voices, class G does not).
        assert_eq!(r.split_quanta, 0, "{}: a stamped scene must not split the quantum", scene.name);
        assert_eq!(r.voice_splits > 0, matches!(scene.per_quantum, Some(Per::Loop | Per::Spatial)), "{}: voiceSplits {} (only the class S scenes, a loop region and a low-pass ramp, split voices)", scene.name, r.voice_splits);
    }
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
    probe.sort_by(|a, b| a.partial_cmp(b).unwrap());
    r.automation = [percentile(&probe, 0.5), percentile(&probe, 0.99), percentile(&probe, 0.999), *probe.last().unwrap_or(&0.0) as f64];
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
    let mut line = format!(
        "{{\"target\":\"{target}\",\"scene\":\"{name}\",\"run\":{run},\"quanta\":{},\"p50\":{:.2},\"p99\":{:.2},\"p999\":{:.2},\"max\":{:.2},\"mean\":{:.2},\"p99Quiet\":{:.2},\"p999Quiet\":{:.2},\"mixed\":{:.1},\"live\":{:.0},\"hrtf\":{:.2},\"crossfading\":{:.2},\"kernels\":{:.3},\"kernelsMax\":{},\"budgetMax\":{},\"sourceFrames\":{:.0},\"moving\":{:.1},\"recordsPerQuantum\":{:.2},\"startsPerSecond\":{:.1},\"wuMean\":{:.0},\"wuP99\":{:.0},\"wuMax\":{:.0},\"capMin\":{},\"capLast\":{},\"demoted\":{},\"bedVoices\":{:.1},\"beds\":{:.2},\"workBed\":{:.0},\"transit\":{:.2},\"fxVoices\":{:.1},\"ambisonic\":{:.1},\"zonesActive\":{:.2},\"zonesRinging\":{:.2},\"workZones\":{:.0},\"zoneWetPeak\":{:.4},\"senders\":{:.1},\"aux\":{:.1},\"zoneEvents\":{},\"standbySwaps\":{},\"evictSwaps\":{},\"splitQuanta\":{},\"voiceSplits\":{},\"groupsHeld\":{},\"groupsLate\":{},\"groupsAbandoned\":{},\"groupTableFull\":{},\"musicRingRefused\":{},\"musicRingsOpen\":{},\"statusMax\":{}}}",
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
        r.demoted,
        r.mean_bed_voices,
        r.mean_beds,
        r.mean_work_bed,
        r.mean_transit,
        r.mean_fx_voices,
        r.mean_ambisonic,
        r.mean_zones_active,
        r.mean_zones_ringing,
        r.mean_work_zones,
        r.zone_wet_peak,
        r.mean_senders,
        r.mean_aux,
        r.zone_events,
        r.standby_swaps,
        r.evict_swaps,
        r.split_quanta,
        r.voice_splits,
        r.groups_held,
        r.groups_late,
        r.groups_abandoned,
        r.group_table_full,
        r.music_ring_refused,
        r.music_rings_open,
        r.status_max
    );
    if r.automation[3] > 0.0 {
        line.pop();
        line.push_str(&format!(",\"automationP50\":{:.3},\"automationP99\":{:.3},\"automationP999\":{:.3},\"automationMax\":{:.3}}}", r.automation[0], r.automation[1], r.automation[2], r.automation[3]));
    }
    line
}

/// The fixed regions of a preset, for architecture §5.1.
fn memory(name: &str, logical: u32, mixed: u32, arena_mb: u32) -> String {
    let p = InitParams { sample_rate: RATE, max_logical: logical, max_mixed: mixed, max_buses: 32, arena_initial_bytes: arena_mb << 20, ..InitParams::default() };
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
            if only.is_none_or(|t| t.split(',').any(|x| x == "ambi_rotate")) {
                ambi_rotate_micro(target, num(args, "reps", 20_000.0) as usize, runs);
            }
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

/// ADR 0162 A7: the rotation of one ambisonic voice on its own, timed without the core (`mode=fit term=ambi_rotate`): per
/// quantum the core builds two matrices (`ShRotation::from_mat3` of the listener's and the clip's rotation at the quantum's
/// ends) and calls `rotate_ramp_add`; this times each at orders 1 and 3 over `reps` quanta of a turning listener, and
/// `rotate_dedicated`, the dedicated block kernel that B3's per-channel form replaced (84 row passes at order 3 against
/// 170): the difference of the two kernels is what that trade costs. Prints p50 and p99 (µs per call) per run.
fn ambi_rotate_micro(target: &str, reps: usize, runs: usize) {
    use audio_dsp::ambisonic::{mat3_mul, quat_to_ambix, rotate_ramp_add, yaw_ambix, ShRotation, CHANNELS};
    let mut rng = Rng(0x2545_f491);
    let mut input = [[0.0f32; QUANTUM]; CHANNELS];
    for row in input.iter_mut() {
        for v in row.iter_mut() {
            *v = rng.unit() - 0.5;
        }
    }
    // The listener's turn, a rotation per quantum (built outside the timing).
    let turns: Vec<_> = (0..=reps)
        .map(|k| {
            let (a, b) = (0.01 * k as f32, 0.15 * libm::sinf(0.007 * k as f32));
            let (sa, ca, sb, cb) = (libm::sinf(a / 2.0), libm::cosf(a / 2.0), libm::sinf(b / 2.0), libm::cosf(b / 2.0));
            mat3_mul(&quat_to_ambix([ca * sb, sa * cb, -sa * sb, ca * cb]).unwrap(), &yaw_ambix(0.003 * k as f32))
        })
        .collect();
    for run_i in 0..runs {
        for order in [1usize, 3] {
            let ch = (order + 1) * (order + 1);
            let (mut t_mat, mut t_kernel, mut t_ref) = (Vec::with_capacity(reps), Vec::with_capacity(reps), Vec::with_capacity(reps));
            let mut out = [[0.0f32; QUANTUM]; CHANNELS];
            let mut out_ref = [[0.0f32; QUANTUM]; CHANNELS];
            for k in 0..reps {
                let t0 = platform::now_us();
                let m0 = ShRotation::from_mat3(core::hint::black_box(&turns[k]));
                let m1 = ShRotation::from_mat3(core::hint::black_box(&turns[k + 1]));
                let t1 = platform::now_us();
                rotate_ramp_add(core::hint::black_box(&input), &mut out, ch, &m0, &m1);
                let t2 = platform::now_us();
                rotate_dedicated(core::hint::black_box(&input), &mut out_ref, ch, &m0, &m1);
                let t3 = platform::now_us();
                t_mat.push((t1 - t0) as f32);
                t_kernel.push((t2 - t1) as f32);
                t_ref.push((t3 - t2) as f32);
                if k % 64 == 63 {
                    out = [[0.0; QUANTUM]; CHANNELS];
                    out_ref = [[0.0; QUANTUM]; CHANNELS];
                }
            }
            // The same without a clock read between calls: blocks of 50 quanta timed whole (the per-call p50 above
            // includes two clock reads), the median block's per-call time.
            let (m0, m1) = (ShRotation::from_mat3(&turns[0]), ShRotation::from_mat3(&turns[1]));
            for (what, f) in [("rotate_ramp_add", 0), ("dedicated", 1), ("matrices", 2)] {
                let mut blocks = Vec::with_capacity(reps / 50);
                for _ in 0..reps / 50 {
                    let t0 = platform::now_us();
                    for k in 0..50 {
                        match f {
                            0 => rotate_ramp_add(core::hint::black_box(&input), &mut out, ch, &m0, &m1),
                            1 => rotate_dedicated(core::hint::black_box(&input), &mut out_ref, ch, &m0, &m1),
                            _ => {
                                core::hint::black_box(ShRotation::from_mat3(core::hint::black_box(&turns[k])));
                                core::hint::black_box(ShRotation::from_mat3(core::hint::black_box(&turns[k + 1])));
                            }
                        }
                    }
                    blocks.push(((platform::now_us() - t0) / 50.0) as f32);
                    out = [[0.0; QUANTUM]; CHANNELS];
                    out_ref = [[0.0; QUANTUM]; CHANNELS];
                }
                blocks.sort_by(|a, b| a.total_cmp(b));
                platform::print(&format!(
                    "{{\"target\":\"{target}\",\"micro\":\"ambi_rotate_block\",\"what\":\"{what}\",\"order\":{order},\"run\":{run_i},\"p50\":{:.3},\"p99\":{:.3}}}",
                    percentile(&blocks, 0.5),
                    percentile(&blocks, 0.99)
                ));
            }
            core::hint::black_box((&out, &out_ref));
            for (what, mut t) in [("matrices", t_mat), ("rotate_ramp_add", t_kernel), ("dedicated", t_ref)] {
                let mean = t.iter().sum::<f32>() as f64 / t.len() as f64;
                t.sort_by(|a, b| a.total_cmp(b));
                platform::print(&format!(
                    "{{\"target\":\"{target}\",\"micro\":\"ambi_rotate\",\"what\":\"{what}\",\"order\":{order},\"run\":{run_i},\"reps\":{reps},\"p50\":{:.3},\"p99\":{:.3},\"mean\":{mean:.3}}}",
                    percentile(&t, 0.5),
                    percentile(&t, 0.99)
                ));
            }
        }
    }
}

/// The dedicated block-diagonal rotation kernel: each order's `n x n` block applied once (1 + 9 + 25 + 49 MACs per frame at
/// order 3), the matrix ramped per sample as in [`audio_dsp::ambisonic::rotate_ramp_add`] (frame `i` uses `m0 + (m1 - m0)(i + 1)/128`).
fn rotate_dedicated(
    input: &[[f32; QUANTUM]; audio_dsp::ambisonic::CHANNELS],
    out: &mut [[f32; QUANTUM]; audio_dsp::ambisonic::CHANNELS],
    channels: usize,
    m0: &audio_dsp::ambisonic::ShRotation,
    m1: &audio_dsp::ambisonic::ShRotation,
) {
    let mut ramp = [0.0f32; QUANTUM];
    for (i, w) in ramp.iter_mut().enumerate() {
        *w = (i + 1) as f32 / QUANTUM as f32;
    }
    let blocks: [(usize, usize, &[f32], &[f32]); 4] = [
        (0, 1, core::slice::from_ref(&m0.b0), core::slice::from_ref(&m1.b0)),
        (1, 3, m0.b1.as_flattened(), m1.b1.as_flattened()),
        (4, 5, m0.b2.as_flattened(), m1.b2.as_flattened()),
        (9, 7, m0.b3.as_flattened(), m1.b3.as_flattened()),
    ];
    for (base, n, a, b) in blocks {
        if base + n > channels.max(1) {
            break;
        }
        for i in 0..n {
            for j in 0..n {
                let (c0, dc) = (a[i * n + j], b[i * n + j] - a[i * n + j]);
                let x = &input[base + j];
                for (f, o) in out[base + i].iter_mut().enumerate() {
                    *o += (c0 + dc * ramp[f]) * x[f];
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A short run of a bed scene (ADR 0162 A7): the counters say what the scene is for.
    fn short(name: &str) -> RunResult {
        let hrir = hrir_table(RATE);
        run(&scene(name).unwrap(), 0.5, 0.25, 1, false, Some(&hrir))
    }

    #[test]
    fn bed_64_encodes_64_voices_into_one_bed() {
        let r = short("bed-64");
        assert_eq!((r.mean_bed_voices, r.mean_beds, r.mean_hrtf), (64.0, 1.0, 0.0));
        assert!(r.mean_work_bed > 0.0 && r.p50 > 0.0);
    }

    #[test]
    fn bed_256_spreads_256_voices_over_two_beds() {
        let r = short("bed-256");
        assert_eq!((r.mean_bed_voices, r.mean_beds), (256.0, 2.0));
    }

    #[test]
    fn bed_xfade_moves_voices_across_the_hrtf_bed_boundary() {
        let r = short("bed-xfade");
        // 16 in the window, plus the leaving voices still holding their slots; the rest in the bed or fading into it.
        assert!(r.mean_hrtf > XFADE_WINDOW as f64 && r.mean_hrtf < 32.0, "hrtf {}", r.mean_hrtf);
        assert!(r.mean_bed_voices > 40.0 && r.mean_bed_voices < 64.0, "bed voices {}", r.mean_bed_voices);
        assert!(r.mean_transit > 0.0);
        // Still window: no crossings.
        let still = run(&Scene { xfade: Some(0), ..scene("bed-xfade").unwrap() }, 0.5, 0.25, 1, false, Some(&hrir_table(RATE)));
        assert_eq!((still.mean_hrtf, still.mean_transit), (XFADE_WINDOW as f64, 0.0));
    }

    #[test]
    fn filters_256_runs_256_low_and_high_passes() {
        let r = short("filters-256");
        assert_eq!(r.mean_mixed, 256.0);
        assert_eq!(r.mean_fx_voices, 256.0, "every pool entry filters");
        assert_eq!((r.mean_ambisonic, r.mean_bed_voices), (0.0, 0.0));
        // The unfiltered twin keeps the pool idle.
        let twin = run(&Scene { voice_lp: 0, voice_hp: 0, ..scene("filters-256").unwrap() }, 0.5, 0.25, 1, false, None);
        assert_eq!(twin.mean_fx_voices, 0.0);
    }

    /// Each worst scene's composition: the counters say what it is for (STATUS fxVoices, ambisonicVoices, bedVoices).
    #[test]
    fn the_worst_scenes_hold_their_m3_terms() {
        // (name, beds, HRTF, ambisonic, minimum filtered: the mixed voices less streams and clips, less one-shot churn)
        for (name, beds, hrtf, ambi, fx) in [("m3-worst-low", 0.0, 4.0, 1.0, 38.0), ("m3-worst-default", 2.0, 8.0, 1.0, 100.0), ("m3-worst-high", 4.0, 8.0, 2.0, 200.0)] {
            let r = short(name);
            assert_eq!((r.mean_beds, r.mean_ambisonic), (beds, ambi), "{name}");
            assert!(r.mean_hrtf >= hrtf - 0.5 && r.mean_hrtf <= hrtf, "{name}: hrtf {}", r.mean_hrtf);
            assert!(r.mean_fx_voices >= fx, "{name}: fx voices {}", r.mean_fx_voices);
            assert!(r.mean_mixed > 0.0 && r.p50 > 0.0);
            if beds > 0.0 {
                assert!(r.mean_bed_voices > 0.0, "{name}: bed voices");
            }
        }
    }

    /// ADR 0162 C7: two active 2 s zones fed by 16 voices sending into both, a quiet twin without them.
    #[test]
    fn zones_2x2s_convolves_two_zones_from_sending_voices() {
        let r = short("zones-2x2s");
        assert_eq!((r.mean_zones_active, r.mean_senders, r.mean_zones_ringing, r.zone_events), (2.0, 16.0, 0.0, 0));
        assert!(r.zone_wet_peak > 0.0, "the zones are heard");
        assert!(r.mean_work_zones >= 2.0 * audio_core::zones::SLOT_WU as f64, "work units {}", r.mean_work_zones);
        let dry = short("zones-2x2s-dry");
        assert_eq!((dry.mean_zones_active, dry.mean_work_zones, dry.zone_wet_peak), (0.0, 0.0, 0.0));
    }

    /// ADR 0162 C7: a run long enough for a standby swap and an eviction swap (0.25 s, 1.5 s): no refused kernel or slot,
    /// a zone rang out beside two active ones, and two zones were convolving at the end.
    #[test]
    fn zones_swap_goes_through_the_standby_and_the_eviction_paths() {
        let hrir = hrir_table(RATE);
        let r = run(&scene("zones-swap").unwrap(), 1.75, 0.25, 1, false, Some(&hrir));
        assert_eq!((r.standby_swaps, r.evict_swaps), (1, 1));
        assert_eq!(r.zone_events, 0, "no refused kernel, refused slot or bad blob");
        assert!(r.mean_zones_ringing > 0.0 && r.zone_wet_peak > 0.0);
    }

    /// ADR 0162 C7: `m3-high` is §7.2's typical high scene, with its sends.
    #[test]
    fn m3_high_holds_its_typical_terms() {
        let r = short("m3-high");
        assert_eq!((r.mean_beds, r.mean_ambisonic, r.mean_zones_active), (2.0, 1.0, 2.0));
        assert!(r.mean_hrtf >= 7.5 && r.mean_hrtf <= 8.0, "hrtf {}", r.mean_hrtf);
        assert!(r.mean_senders >= 200.0, "senders {}", r.mean_senders);
        assert!(r.mean_fx_voices >= 20.0 && r.zone_wet_peak > 0.0);
    }

    /// ADR 0162 C7: the worst scenes with zones convolving, sends flowing and aux sends.
    #[test]
    fn the_worst_scenes_with_sends_run_their_slots() {
        for (name, slots, aux) in [("m3-worst-low-sends", 1.0, 8.0), ("m3-worst-default-sends", 3.0, 16.0), ("m3-worst-high-sends", 3.0, 32.0)] {
            let r = short(name);
            // One-shots end and are replaced (a replacement takes its send at the next batch), so the counts sit just under.
            assert_eq!(r.mean_zones_active, slots, "{name}");
            assert!(r.mean_aux >= 0.9 * aux && r.mean_aux <= aux, "{name}: aux {}", r.mean_aux);
            assert!(r.mean_senders > 30.0 && r.zone_wet_peak > 0.0 && r.zone_events == 0, "{name}: senders {} peak {}", r.mean_senders, r.zone_wet_peak);
        }
    }

    /// ADR 0162 A7: `ambi-o3` rotates four 3rd-order clips into one bed, `ambi-o3-private` into a private decoder (no bed);
    /// both under a turning listener, and the dedicated reference kernel computes what `rotate_ramp_add` does.
    #[test]
    fn ambi_o3_rotates_clips_into_a_bed_and_a_private_decoder() {
        let r = short("ambi-o3");
        assert_eq!((r.mean_ambisonic, r.mean_beds, r.mean_bed_voices), (4.0, 1.0, 0.0));
        let p = short("ambi-o3-private");
        assert_eq!((p.mean_ambisonic, p.mean_beds), (4.0, 0.0));
        assert!(r.p50 > 0.0 && p.p50 > 0.0);
        use audio_dsp::ambisonic::{rotate_ramp_add, yaw_ambix, ShRotation, CHANNELS};
        let mut x = [[0.0f32; QUANTUM]; CHANNELS];
        let mut rng = Rng(7);
        x.iter_mut().flatten().for_each(|v| *v = rng.unit() - 0.5);
        let (m0, m1) = (ShRotation::from_mat3(&yaw_ambix(0.3)), ShRotation::from_mat3(&yaw_ambix(0.5)));
        for ch in [4, 16] {
            let (mut a, mut b) = ([[0.0f32; QUANTUM]; CHANNELS], [[0.0f32; QUANTUM]; CHANNELS]);
            rotate_ramp_add(&x, &mut a, ch, &m0, &m1);
            rotate_dedicated(&x, &mut b, ch, &m0, &m1);
            let worst = a.iter().flatten().zip(b.iter().flatten()).map(|(p, q)| (p - q).abs()).fold(0.0f32, f32::max);
            assert!(worst < 1e-5, "{ch} channels: kernels differ by {worst}");
        }
    }

    #[test]
    fn the_matrix_twin_decodes_without_the_filters() {
        let r = run(&Scene::bed("bed-matrix", 64, 1, false), 0.25, 0.25, 1, false, None);
        assert_eq!((r.mean_bed_voices, r.mean_beds), (64.0, 1.0));
    }

    /// ADR 0166 M4b (Bench1): each music scene does what its doc says, by the core's own counters: no refusal, no table
    /// overflow, no late group, no split, and a STATUS that fits its buffer.
    #[test]
    fn the_music_scenes_play_their_groups_and_rings() {
        let hrir = hrir_table(RATE);
        let long = |name: &str| run(&scene(name).unwrap(), 3.0, 1.0, 1, false, Some(&hrir));
        let mut results = Vec::new();
        for name in ["music-typ", "music-typ-streamed", "music-trans", "music-trans-streamed", "music-worst", "music-worst-streamed"] {
            let r = long(name);
            assert_eq!((r.group_table_full, r.music_ring_refused, r.groups_late, r.split_quanta), (0, 0, 0, 0), "{name}");
            assert!(r.status_max > 0 && r.status_max <= audio_core::status::BUFFER_BYTES, "{name}: STATUS {} B", r.status_max);
            results.push((name, r));
        }
        let find = |n: &str| &results.iter().find(|(m, _)| *m == n).unwrap().1;
        // Streamed scenes hold music rings; decoded ones none.
        assert_eq!((find("music-typ").music_rings_open, find("music-worst").music_rings_open), (0, 0));
        assert_eq!((find("music-typ-streamed").music_rings_open, find("music-worst-streamed").music_rings_open), (8, 8));
        // Transition: one segment's 4 rings stay open (the retired ones are freed as their voices end).
        assert_eq!(find("music-trans-streamed").music_rings_open, 4);
        // The held group: a streamed ring runs dry and the group holds; a decoded group missing a member is given up.
        assert!(find("music-typ-streamed").groups_held >= 1, "held {}", find("music-typ-streamed").groups_held);
        assert_eq!(find("music-typ-streamed").groups_abandoned, 0);
        assert!(find("music-typ").groups_abandoned >= 1 && find("music-typ").groups_held == 0);
        // The twins play no music at all.
        let twin = long("music-worst-twin");
        assert_eq!((twin.music_rings_open, twin.groups_held, twin.groups_abandoned), (0, 0, 0));
        assert!(find("music-worst").mean_mixed - twin.mean_mixed > 15.5, "worst adds its 16 voices to the twin's {}", twin.mean_mixed);
    }
}
