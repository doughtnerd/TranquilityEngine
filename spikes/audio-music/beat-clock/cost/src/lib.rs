// Design B's audio-thread work: per quantum, per playing music instance, "does a beat (or a cue) fall inside
// [q0, q0+128)?". State per instance is the next beat frame and the next cue frame (both u64), the beat index and a
// small tempo map. The no-crossing path is two compares; a crossing computes the offset in the quantum, writes one
// event into a fixed ring and advances the beat with a tempo-map multiply (done at ~2 Hz at 120 BPM).
// Std only, no allocation in the loop: this is the code that would sit in the core's per-quantum music step.
pub const QUANTUM: u64 = 128;
pub const RING: usize = 256;

#[derive(Clone, Copy)]
pub struct Tempo { pub beat: u32, pub sec_per_beat: f64, pub base_frame: f64 }

#[derive(Clone, Copy)]
pub struct Inst {
    pub start: u64,
    pub next_beat: u64,
    pub beat_idx: u32,
    pub next_cue: u64,
    pub cue_idx: u32,
    pub tempo_idx: u32,
    pub tempos: [Tempo; 4],
    pub n_tempos: u32,
    pub sr: f64,
    pub cues: [u64; 8],
    pub n_cues: u32,
}

#[derive(Clone, Copy, Default)]
pub struct Ev { pub frame: u64, pub kind: u32, pub idx: u32 }

pub struct Ring { pub buf: [Ev; RING], pub head: usize }

impl Inst {
    pub fn new(start: u64, bpm0: f64, bpm1: f64, change_beat: u32, sr: f64) -> Inst {
        let t0 = Tempo { beat: 0, sec_per_beat: 60.0 / bpm0, base_frame: 0.0 };
        let t1 = Tempo { beat: change_beat, sec_per_beat: 60.0 / bpm1, base_frame: change_beat as f64 * 60.0 / bpm0 * sr };
        let mut cues = [0u64; 8];
        for (i, c) in cues.iter_mut().enumerate() { *c = start + ((i as u64 + 1) * 3 * sr as u64) + 17; }
        let mut s = Inst { start, next_beat: start, beat_idx: 0, next_cue: cues[0], cue_idx: 0, tempo_idx: 0, tempos: [t0, t1, t1, t1], n_tempos: 2, sr, cues, n_cues: 8 };
        s.next_beat = s.beat_frame(0);
        s
    }
    #[inline(always)]
    fn beat_frame(&self, n: u32) -> u64 {
        let mut i = self.tempo_idx as usize;
        while i + 1 < self.n_tempos as usize && n >= self.tempos[i + 1].beat { i += 1; }
        let t = &self.tempos[i];
        self.start + (t.base_frame + (n - t.beat) as f64 * t.sec_per_beat * self.sr).round() as u64
    }
    /// One quantum of the beat/cue crossing check. Returns the number of events written.
    #[inline(always)]
    pub fn step(&mut self, q0: u64, ring: &mut Ring) -> u32 {
        let q1 = q0 + QUANTUM;
        let mut n = 0;
        while self.next_beat < q1 {
            ring.buf[ring.head & (RING - 1)] = Ev { frame: self.next_beat, kind: 0, idx: self.beat_idx };
            ring.head += 1; n += 1;
            self.beat_idx += 1;
            while self.tempo_idx + 1 < self.n_tempos && self.beat_idx >= self.tempos[self.tempo_idx as usize + 1].beat { self.tempo_idx += 1; }
            self.next_beat = self.beat_frame(self.beat_idx);
        }
        if self.next_cue < q1 {
            ring.buf[ring.head & (RING - 1)] = Ev { frame: self.next_cue, kind: 1, idx: self.cue_idx };
            ring.head += 1; n += 1;
            self.cue_idx = (self.cue_idx + 1) % self.n_cues;
            self.next_cue = self.cues[self.cue_idx as usize] + q1; // wraps: keeps firing rarely
        }
        n
    }
}

/// Runs `quanta` quanta over `n` instances. `force`: 1 = every quantum is a crossing quantum (tempo so fast that every
/// 128 frames holds a beat: the worst case), 0 = a normal 120/90 BPM grid. Returns an event count (a sink).
#[no_mangle]
pub extern "C" fn run(n: u32, quanta: u32, force: u32) -> u64 {
    let sr = 44100.0;
    let bpm = if force == 1 { 60.0 * sr / 100.0 } else { 120.0 }; // force: a beat every 100 frames
    let mut v: Vec<Inst> = (0..n).map(|i| Inst::new(i as u64 * 37, bpm, if force == 1 { bpm } else { 90.0 }, 64, sr)).collect();
    let mut ring = Ring { buf: [Ev::default(); RING], head: 0 };
    let mut total = 0u64;
    let mut q0 = 0u64;
    for _ in 0..quanta {
        for inst in v.iter_mut() { total += inst.step(q0, &mut ring) as u64; }
        q0 += QUANTUM;
    }
    total + ring.head as u64
}
