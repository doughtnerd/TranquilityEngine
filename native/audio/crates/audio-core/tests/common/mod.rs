//! Shared helpers for the bus tests (`bus.rs`, `golden_buses.rs`): a core over a zeroed block, a
//! generated clip, and BATCH messages written with `audio-wire`'s generated writers and submitted
//! through `audio_core::scheduler::submit` (the path `myco_audio_submit` takes).
//!
//! **Latency** (A2.9): the master limiter's look-ahead delays all output by a fixed
//! `bus::output_latency_frames` (72 frames at 48 kHz for the default 1.5 ms). The tests still
//! write what they expect in **core time** (the frame a voice or a gain change is rendered at);
//! [`Heard`] compares that with the output shifted by the latency: heard frame `h` carries core
//! frame `h − latency`, and the first `latency` frames are the delay line's silence.
#![allow(dead_code)]

use audio_core::clips::ClipFormat;
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{bus, scheduler, Core, QUANTUM};
use audio_wire::generated as wire;

pub const RATE: f32 = 48_000.0;
pub const ROOT: u16 = wire::BUS_ROOT as u16;
pub const OFF: f32 = wire::BUS_LP_OFF_HZ as f32;
pub const MIXED: u16 = wire::PLAY_FLAGS_MIXED;
pub const LOOP: u16 = wire::PLAY_FLAGS_LOOP;
pub const SPATIAL: u16 = wire::PLAY_FLAGS_SPATIAL;
/// A DC 1.0 clip.
pub const DC: u32 = 1;

pub fn params(max_buses: u32) -> InitParams {
    InitParams { sample_rate: RATE, max_logical: 64, max_mixed: 16, max_buses, arena_initial_bytes: 0 }
}

/// A core over a leaked, zeroed, page-aligned block, as `myco_audio_init` would get it.
pub fn new_core(max_buses: u32) -> Core {
    let p = params(max_buses);
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: `base` is a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

/// One record of a BATCH.
pub enum Rec {
    Play(wire::Play),
    Set(wire::SetParams),
    Config(wire::BusConfig),
    Mix(wire::BusMix),
    Master(wire::Master),
    Reset(wire::Reset),
    /// A record already written, head included (ADR 0158's variable records in `automation.rs`).
    Raw(Vec<u8>),
}

impl Rec {
    /// Writes the record at `at`; returns its size.
    fn write(&self, out: &mut [u8], at: usize) -> usize {
        match self {
            Rec::Play(r) => r.write(out, at),
            Rec::Set(r) => r.write(out, at),
            Rec::Config(r) => r.write(out, at),
            Rec::Mix(r) => r.write(out, at),
            Rec::Master(r) => r.write(out, at),
            Rec::Reset(r) => r.write(out, at),
            Rec::Raw(b) => {
                out[at..at + b.len()].copy_from_slice(b);
                Ok(b.len())
            }
        }
        .unwrap()
    }
}

/// A whole BATCH message of `recs`.
pub fn batch(first_frame: f64, recs: &[Rec]) -> Vec<u8> {
    let mut buf = vec![0u8; 32 + 64 * 1024];
    let mut at = 32;
    for rec in recs {
        at += rec.write(&mut buf, at);
    }
    buf.truncate(at);
    wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame, count: recs.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
    buf
}

/// A PLAY of `clip` on `bus`, gain 1, pitch 1, facing forward, asap.
pub fn play(voice: u32, clip: u32, bus: u16, flags: u16) -> Rec {
    Rec::Play(wire::Play {
        voice_id: voice,
        frame_offset: wire::ASAP,
        clip,
        bus,
        flags,
        gain: 1.0,
        pitch: 1.0,
        dir_z: -1.0,
        lp_hz: OFF,
        ..Default::default()
    })
}

/// A looping, mixed PLAY of the DC clip on `bus`, panned hard to `side` (-1 left, 1 right) when
/// `side` isn't 0 (then spatial).
pub fn dc(voice: u32, bus: u16, side: f32) -> Rec {
    let mut flags = MIXED | LOOP;
    if side != 0.0 {
        flags |= SPATIAL;
    }
    let Rec::Play(mut p) = play(voice, DC, bus, flags) else { unreachable!() };
    if side != 0.0 {
        p.dir_x = side;
        p.dir_z = 0.0;
    }
    Rec::Play(p)
}

/// SET_PARAMS moving `voice` to `bus`, asap.
pub fn set_bus(voice: u32, bus: u32) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_BUS, bus, ..Default::default() })
}

/// BUS_CONFIG of `parents` with no effects, asap.
pub fn config(parents: &[u16]) -> Rec {
    config_fx(&parents.iter().map(|&p| (p, vec![])).collect::<Vec<_>>())
}

/// BUS_CONFIG of `(parent, effects)` per bus; an effect is `(type, p0, p1)`.
pub fn config_fx(buses: &[(u16, Vec<(u32, f32, f32)>)]) -> Rec {
    Rec::Config(wire::BusConfig {
        voice_id: 0,
        frame_offset: wire::ASAP,
        buses: buses
            .iter()
            .map(|(parent, fx)| wire::BusConfigBuses {
                parent: *parent,
                effects: fx.iter().map(|&(t, p0, p1)| wire::BusConfigBusesEffects { type_: t, p: [p0, p1, 0.0, 0.0, 0.0, 0.0, 0.0] }).collect(),
            })
            .collect(),
    })
}

/// BUS_MIX of `(gain, lpHz)` per bus over `ramp` frames, asap.
pub fn mix(ramp: u32, buses: &[(f32, f32)]) -> Rec {
    Rec::Mix(wire::BusMix {
        voice_id: 0,
        frame_offset: wire::ASAP,
        ramp_frames: ramp,
        buses: buses.iter().map(|&(gain, lp_hz)| wire::BusMixBuses { gain, lp_hz }).collect(),
    })
}

/// BUS_MIX of gains only (low-pass off).
pub fn gains(ramp: u32, gains: &[f32]) -> Rec {
    mix(ramp, &gains.iter().map(|&g| (g, OFF)).collect::<Vec<_>>())
}

pub fn master(volume: f32, muted: bool, ramp: u32) -> Rec {
    Rec::Master(wire::Master { voice_id: 0, frame_offset: wire::ASAP, volume, muted: muted as u32, ramp_frames: ramp })
}

pub fn reset(keep_clips: bool) -> Rec {
    Rec::Reset(wire::Reset { voice_id: 0, frame_offset: wire::ASAP, keep_clips: keep_clips as u32 })
}

/// Left or right, for [`Heard::expect`].
pub const L: usize = 0;
pub const R: usize = 1;

/// The output as heard, and what the test expects of it in core time (see the module comment).
pub struct Heard {
    /// The output latency in frames.
    pub latency: usize,
    /// The rendered output, per channel, from frame 0.
    out: [Vec<f32>; 2],
    /// The expected core-time output, per channel; NaN where the test said nothing.
    want: [Vec<f32>; 2],
}

impl Heard {
    pub fn new(latency: usize) -> Heard {
        Heard { latency, out: [Vec::new(), Vec::new()], want: [Vec::new(), Vec::new()] }
    }

    /// Appends rendered output.
    pub fn push(&mut self, l: &[f32], r: &[f32]) {
        for (ch, x) in [l, r].into_iter().enumerate() {
            self.out[ch].extend_from_slice(x);
            let n = self.out[ch].len();
            self.want[ch].resize(n, f32::NAN);
        }
    }

    /// Frames rendered so far.
    pub fn len(&self) -> usize {
        self.out[0].len()
    }

    /// Says channel `ch` is `want(k)` at core frames `start + k` for `start..start + len`, then
    /// checks every heard frame of that span against the core frame `latency` before it (silence
    /// before frame 0; skipped where nothing was said).
    pub fn expect(&mut self, ch: usize, start: usize, len: usize, tol: f32, what: &str, want: impl Fn(usize) -> f32) {
        for k in 0..len {
            self.want[ch][start + k] = want(k);
        }
        for h in start..start + len {
            let w = match h.checked_sub(self.latency) {
                None => 0.0,
                Some(c) => self.want[ch][c],
            };
            if w.is_nan() {
                continue;
            }
            let a = self.out[ch][h];
            assert!((a - w).abs() <= tol, "{what}: heard frame {h} (core frame {}) is {a}, expected {w}", h as isize - self.latency as isize);
        }
    }
}

/// A core that renders quanta in order from frame 0, with the DC clip loaded.
pub struct Mixer {
    pub core: Core,
    pub frame: u64,
    /// The output as heard, and the expectations (see the module comment).
    pub heard: Heard,
    /// The first frame of the last `render` or `render_n`.
    pub span: usize,
}

impl Mixer {
    pub fn new(max_buses: u32) -> Mixer {
        Mixer::over(new_core(max_buses))
    }

    /// A mixer over `core` (rendering from frame 0), with the DC clip loaded.
    pub fn over(core: Core) -> Mixer {
        let latency = bus::output_latency_frames(&core) as usize;
        let mut m = Mixer { core, frame: 0, heard: Heard::new(latency), span: 0 };
        m.load_clip(DC, &[1.0f32; 64]);
        m
    }

    /// Sets the master limiter's look-ahead (before the first render) and the latency the checks
    /// expect with it.
    pub fn set_lookahead(&mut self, ms: f32) {
        assert!(bus::set_limiter_lookahead(&mut self.core, ms), "before the first render");
        self.heard.latency = bus::output_latency_frames(&self.core) as usize;
    }

    /// The output latency in frames.
    pub fn latency(&self) -> usize {
        self.heard.latency
    }

    /// Expects channel `ch` of the last `render`/`render_n` span to be `want(k)` in core time (frame
    /// `k` of the span) and checks what was heard (see [`Heard::expect`]).
    pub fn expect(&mut self, ch: usize, tol: f32, what: &str, want: impl Fn(usize) -> f32) {
        let len = self.heard.len() - self.span;
        self.heard.expect(ch, self.span, len, tol, what, want);
    }

    /// Reserves a mono f32 clip at the context rate and writes its samples.
    pub fn load_clip(&mut self, id: u32, samples: &[f32]) {
        self.core.clips_mut().reserve(id, samples.len() as u32, 1, RATE, ClipFormat::F32).unwrap();
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        self.core.clips_mut().write(id, 0, &bytes).unwrap();
    }

    /// Submits one BATCH; returns `submit`'s result.
    pub fn try_submit(&mut self, recs: &[Rec]) -> i32 {
        let msg = batch(self.frame as f64, recs);
        scheduler::submit(&mut self.core, &msg)
    }

    /// Submits one BATCH and asserts it was accepted.
    pub fn submit(&mut self, recs: &[Rec]) {
        assert_eq!(self.try_submit(recs), 0, "the batch was refused");
    }

    /// Renders the next quantum; returns its left and right channels.
    pub fn render(&mut self) -> (Vec<f32>, Vec<f32>) {
        self.span = self.heard.len();
        self.quantum()
    }

    fn quantum(&mut self) -> (Vec<f32>, Vec<f32>) {
        let out = self.core.process(self.frame);
        let pair = (out[..QUANTUM].to_vec(), out[QUANTUM..2 * QUANTUM].to_vec());
        self.heard.push(&pair.0, &pair.1);
        self.frame += QUANTUM as u64;
        pair
    }

    /// Renders `n` quanta, concatenated.
    pub fn render_n(&mut self, n: usize) -> (Vec<f32>, Vec<f32>) {
        self.span = self.heard.len();
        let (mut left, mut right) = (Vec::new(), Vec::new());
        for _ in 0..n {
            let (l, r) = self.quantum();
            left.extend(l);
            right.extend(r);
        }
        (left, right)
    }
}

/// Asserts every sample of `actual` is within `tol` of `want(index)`.
pub fn check(actual: &[f32], tol: f32, what: &str, want: impl Fn(usize) -> f32) {
    for (i, &a) in actual.iter().enumerate() {
        let w = want(i);
        assert!((a - w).abs() <= tol, "{what}: sample {i} is {a}, expected {w}");
    }
}

/// The linear ramp of `audio_dsp::ramp::Ramp`: frame `k` of an `n`-frame ramp from `start` is
/// `start + (target - start) * (k + 1) / n`, then `target`.
pub fn ramp_to(start: f32, target: f32, n: usize, k: usize) -> f32 {
    if k < n {
        start + (target - start) * (k + 1) as f32 / n as f32
    } else {
        target
    }
}
