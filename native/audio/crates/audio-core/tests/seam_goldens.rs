//! T2, the seam goldens, native half (0166 M4b; api-and-models §10 row T2; waves plan, Wave 8
//! exit "every seam nulls to 1e-5").
//!
//! Each `src/plugins/audio/runtime/golden/seams/seam-<case>.json` is a music seam as the whole TypeScript
//! runtime played it on the real wasm core (`music/seam.test.ts` writes it with `UPDATE_GOLDENS=1`):
//! every BATCH and clip message the core received, each at the core frame it was delivered on, the
//! clips as run-length sample words, the output's FNV-1a 64 digest, and the offline reference the
//! output nulls against. This test replays the messages natively, the way the shell
//! (`worklet/coreDriver.ts`) hands them to the core: a BATCH straight to `scheduler::submit`; clip
//! messages through a queue drained under the shell's 256 KB copy budget per quantum (reserve,
//! chunk copy and commit, free); each quantum `Core::process`, then `status::after_quantum` and
//! `clips::flush_events`, as `myco_audio_process` does. The digest must be the fixture's: **native
//! equals wasm**. The wasm half (`golden/audioGoldenSeams.test.ts`) replays the same fixture and
//! nulls it against the reference, so both null.

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{bus, clips, scheduler, status, Core, QUANTUM};
use std::collections::{HashMap, VecDeque};

/// The cases (`audioGoldenSeams.test.ts`' `SEAM_CASES`).
const CASES: [&str; 8] = [
    "seam-cut",
    "seam-crossfade-linear",
    "seam-crossfade-s-curve",
    "seam-crossfade-equal-power",
    "seam-bridge",
    "seam-loop-exit-tail",
    "seam-stinger",
    "seam-switch-default",
];

/// The shell's clip copy budget per quantum (`CLIP_BYTES_PER_QUANTUM`).
const CLIP_BYTES_PER_QUANTUM: usize = 256 * 1024;
const RATE: f32 = 48_000.0;

// --- A minimal JSON reader (the fixtures are the only input) ----------------------------------

#[derive(Debug)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn at(&self, key: &str) -> &Json {
        self.get(key).unwrap_or_else(|| panic!("fixture: no \"{key}\""))
    }
    fn num(&self) -> f64 {
        match self {
            Json::Num(n) => *n,
            _ => panic!("fixture: not a number: {self:?}"),
        }
    }
    fn u(&self) -> u32 {
        self.num() as u32
    }
    fn str(&self) -> &str {
        match self {
            Json::Str(s) => s,
            _ => panic!("fixture: not a string: {self:?}"),
        }
    }
    fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(a) => a,
            _ => panic!("fixture: not an array: {self:?}"),
        }
    }
}

struct Reader<'a> {
    s: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn eat(&mut self, c: u8) {
        self.ws();
        assert_eq!(self.s[self.i], c, "fixture JSON: expected '{}' at {}", c as char, self.i);
        self.i += 1;
    }
    fn value(&mut self) -> Json {
        self.ws();
        match self.s[self.i] {
            b'{' => {
                self.i += 1;
                let mut fields = Vec::new();
                self.ws();
                if self.s[self.i] == b'}' {
                    self.i += 1;
                    return Json::Obj(fields);
                }
                loop {
                    self.ws();
                    let Json::Str(k) = self.value() else { panic!("fixture JSON: key") };
                    self.eat(b':');
                    fields.push((k, self.value()));
                    self.ws();
                    self.i += 1;
                    if self.s[self.i - 1] == b'}' {
                        return Json::Obj(fields);
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.s[self.i] == b']' {
                    self.i += 1;
                    return Json::Arr(items);
                }
                loop {
                    items.push(self.value());
                    self.ws();
                    self.i += 1;
                    if self.s[self.i - 1] == b']' {
                        return Json::Arr(items);
                    }
                }
            }
            b'"' => {
                self.i += 1;
                let mut out = String::new();
                while self.s[self.i] != b'"' {
                    if self.s[self.i] == b'\\' {
                        self.i += 1;
                        match self.s[self.i] {
                            b'n' => out.push('\n'),
                            b't' => out.push('\t'),
                            b'u' => {
                                let hex = std::str::from_utf8(&self.s[self.i + 1..self.i + 5]).unwrap();
                                out.push(char::from_u32(u32::from_str_radix(hex, 16).unwrap()).unwrap_or('?'));
                                self.i += 4;
                            }
                            c => out.push(c as char),
                        }
                        self.i += 1;
                    } else {
                        let start = self.i;
                        while self.s[self.i] != b'"' && self.s[self.i] != b'\\' {
                            self.i += 1;
                        }
                        out.push_str(std::str::from_utf8(&self.s[start..self.i]).unwrap());
                    }
                }
                self.i += 1;
                Json::Str(out)
            }
            b't' => {
                self.i += 4;
                Json::Bool(true)
            }
            b'f' => {
                self.i += 5;
                Json::Bool(false)
            }
            b'n' => {
                self.i += 4;
                Json::Null
            }
            _ => {
                let start = self.i;
                while self.i < self.s.len() && matches!(self.s[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                    self.i += 1;
                }
                Json::Num(std::str::from_utf8(&self.s[start..self.i]).unwrap().parse().unwrap())
            }
        }
    }
}

fn parse(text: &str) -> Json {
    Reader { s: text.as_bytes(), i: 0 }.value()
}

fn bytes_of(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

/// FNV-1a 64 over the left channel's f32 bytes (little-endian), then the right's.
fn fnv1a64(left: &[f32], right: &[f32]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for x in left.iter().chain(right) {
        for b in x.to_le_bytes() {
            h = (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

/// Bytes per sample of a clip format (`clipSampleBytes`): int16 2, the rest f32.
fn sample_bytes(format: u32) -> usize {
    if format == 1 { 2 } else { 4 }
}

// --- The replay ------------------------------------------------------------------------------

/// A core over a leaked, zeroed, page-aligned block, as `myco_audio_init` would get it.
fn core_for(preset: &Json) -> Core {
    // The arena is sized for every clip up front (the wasm grows its Memory instead; where a clip
    // sits doesn't change the output).
    let p = InitParams {
        sample_rate: RATE,
        max_logical: preset.at("maxLogical").u(),
        max_mixed: preset.at("maxMixed").u(),
        max_buses: preset.at("maxBuses").u(),
        arena_initial_bytes: 32 << 20,
        ..InitParams::default()
    };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: `base` is a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    let mut core = unsafe { Core::new(p, layout, base) };
    assert!(bus::set_limiter_lookahead(&mut core, preset.at("limiterLookaheadMs").num() as f32));
    core
}

struct Clip {
    frames: u32,
    channels: u32,
    rate: f32,
    format: u32,
    bytes: Vec<u8>,
}

enum ClipMsg {
    Begin(u32),
    Chunk(u32, u32, u32),
    Unload(u32),
}

/// Replays a fixture; returns its left and right output.
fn replay(fx: &Json) -> (Vec<f32>, Vec<f32>) {
    let mut core = core_for(fx.at("preset"));
    let mut clip_data: HashMap<u32, Clip> = HashMap::new();
    for c in fx.at("clips").arr() {
        let format = c.at("format").u();
        let w = sample_bytes(format);
        let mut bytes = Vec::new();
        for run in c.at("runs").arr() {
            let [word, count] = run.arr() else { panic!("fixture: run") };
            let word = bytes_of(word.str());
            assert_eq!(word.len(), w);
            for _ in 0..count.u() {
                bytes.extend_from_slice(&word);
            }
        }
        let clip = Clip { frames: c.at("frames").u(), channels: c.at("channels").u(), rate: c.at("sampleRate").num() as f32, format, bytes };
        assert_eq!(clip.bytes.len(), clip.frames as usize * clip.channels as usize * w);
        clip_data.insert(c.at("id").u(), clip);
    }

    let (mut left, mut right) = (Vec::new(), Vec::new());
    let mut frame: u64 = 0;
    let mut queue: VecDeque<ClipMsg> = VecDeque::new();
    let mut reserved: HashMap<u32, usize> = HashMap::new();
    let mut budget = CLIP_BYTES_PER_QUANTUM;

    // The shell's `drainClips`: in order while the budget lasts (a chunk larger than a whole budget
    // goes through on a fresh one).
    let drain = |core: &mut Core, queue: &mut VecDeque<ClipMsg>, reserved: &mut HashMap<u32, usize>, budget: &mut usize| {
        while let Some(msg) = queue.front() {
            if let ClipMsg::Chunk(id, _, frames) = *msg {
                let bytes = reserved.get(&id).map_or(0, |fb| frames as usize * fb);
                if bytes > *budget && *budget < CLIP_BYTES_PER_QUANTUM {
                    return;
                }
                *budget -= bytes.min(*budget);
            }
            match queue.pop_front().unwrap() {
                ClipMsg::Begin(id) => {
                    let c = &clip_data[&id];
                    if clips::reserve(core, id, c.frames, c.channels, c.rate, c.format) == 0 {
                        reserved.insert(id, c.channels as usize * sample_bytes(c.format));
                    }
                }
                ClipMsg::Chunk(id, offset, frames) => {
                    let Some(&fb) = reserved.get(&id) else { continue };
                    let bytes = frames as usize * fb;
                    let ptr = clips::chunk_ptr(core, id, offset, bytes as u32);
                    if ptr.is_null() {
                        continue;
                    }
                    let src = &clip_data[&id].bytes[offset as usize * fb..offset as usize * fb + bytes];
                    // SAFETY: `chunk_ptr` returned room for `bytes` bytes in the clip's block.
                    unsafe { std::ptr::copy_nonoverlapping(src.as_ptr(), ptr, bytes) };
                    clips::commit(core, id, offset, bytes as u32);
                }
                ClipMsg::Unload(id) => {
                    reserved.remove(&id);
                    clips::free(core, id);
                }
            }
        }
    };

    let mut render_to = |core: &mut Core, queue: &mut VecDeque<ClipMsg>, reserved: &mut HashMap<u32, usize>, budget: &mut usize, to: u64, left: &mut Vec<f32>, right: &mut Vec<f32>| {
        assert!(to >= frame, "a step at frame {to} after {frame}");
        while frame < to {
            *budget = CLIP_BYTES_PER_QUANTUM;
            drain(core, queue, reserved, budget);
            let out = core.process(frame);
            left.extend_from_slice(&out[..QUANTUM]);
            right.extend_from_slice(&out[QUANTUM..2 * QUANTUM]);
            status::after_quantum(core);
            clips::flush_events(core);
            frame += QUANTUM as u64;
        }
    };

    for step in fx.at("steps").arr() {
        render_to(&mut core, &mut queue, &mut reserved, &mut budget, step.at("frame").num() as u64, &mut left, &mut right);
        if let Some(b) = step.get("batch") {
            assert_eq!(scheduler::submit(&mut core, &bytes_of(b.str())), 0, "a BATCH was refused");
            continue;
        }
        let msg = if let Some(id) = step.get("begin") {
            ClipMsg::Begin(id.u())
        } else if let Some(c) = step.get("chunk") {
            let c = c.arr();
            ClipMsg::Chunk(c[0].u(), c[1].u(), c[2].u())
        } else {
            ClipMsg::Unload(step.at("unload").u())
        };
        queue.push_back(msg);
        drain(&mut core, &mut queue, &mut reserved, &mut budget);
    }
    render_to(&mut core, &mut queue, &mut reserved, &mut budget, fx.at("frames").num() as u64, &mut left, &mut right);
    (left, right)
}

#[test]
fn every_seam_fixture_replays_natively_to_the_wasm_digest() {
    for name in CASES {
        let path = format!("{}/../../../../src/plugins/audio/runtime/golden/seams/{name}.json", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{name}: no fixture; run UPDATE_GOLDENS=1 npx vitest run src/plugins/audio/runtime/music/seam.test.ts"));
        let fx = parse(&text);
        assert_eq!(fx.at("scene").str(), name);
        let (left, right) = replay(&fx);
        assert_eq!(left.len(), fx.at("frames").num() as usize, "{name}: frames");
        assert!(left.iter().chain(&right).all(|x| x.is_finite()), "{name}: finite output");
        let peak = left.iter().fold(0.0f32, |p, x| p.max(x.abs()));
        assert!(peak > 0.1, "{name}: audible (peak {peak})");
        let digest = fnv1a64(&left, &right);
        eprintln!("{name}: native digest {digest}");
        assert_eq!(digest, fx.at("fnv1a64").str(), "{name}: native digest != the wasm's (golden/seams/{name}.json)");
    }
}

#[test]
fn the_json_reader_reads_what_the_fixtures_hold() {
    let j = parse(r#"{"a":[1,-2.5e-3,"x\"y"],"b":{"c":true,"d":null},"e":[]}"#);
    assert_eq!(j.at("a").arr()[1].num(), -2.5e-3);
    assert_eq!(j.at("a").arr()[2].str(), "x\"y");
    assert!(matches!(j.at("b").at("c"), Json::Bool(true)));
    assert!(matches!(j.at("b").at("d"), Json::Null));
    assert!(j.at("e").arr().is_empty());
    assert_eq!(fnv1a64(&[], &[]), "cbf29ce484222325");
}
