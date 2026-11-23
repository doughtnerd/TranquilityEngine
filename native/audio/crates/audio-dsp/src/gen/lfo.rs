//! The synth's LFO (ADR 0360 §2): sine, triangle, square, saw and sample-and-hold at 0.05–20 Hz, read once per control
//! block (it moves slower than a block is long, so it needs no band-limiting). Output −1..1.

pub const SINE: u8 = 0;
pub const TRIANGLE: u8 = 1;
pub const SQUARE: u8 = 2;
pub const SAW: u8 = 3;
pub const SAMPLE_HOLD: u8 = 4;

/// The LFO's phase, its held value and its own generator (seeded beside the voice's noise). All-zero is phase 0.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Lfo {
    pub phase: f32,
    pub held: f32,
    pub state: u32,
}

impl Lfo {
    pub fn seeded(seed: u32) -> Lfo {
        let mut state = super::noise::seed_state(seed.rotate_left(16) ^ 0x51_7CC1);
        let held = super::noise::uniform(&mut state);
        Lfo { phase: 0.0, held, state }
    }

    /// The value at the current phase.
    #[inline]
    pub fn value(&self, wave: u8) -> f32 {
        let p = self.phase;
        match wave {
            TRIANGLE => 1.0 - 4.0 * (p - 0.5).abs(),
            SQUARE => {
                if p < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            SAW => 2.0 * p - 1.0,
            SAMPLE_HOLD => self.held,
            _ => super::osc::sine_cycles(p as f64),
        }
    }

    /// Moves the phase by `cycles` (a sample-and-hold draws a new value at each wrap).
    #[inline]
    pub fn advance(&mut self, cycles: f32) {
        let p = self.phase + cycles;
        if p >= 1.0 {
            self.phase = p - libm::floorf(p);
            self.held = super::noise::uniform(&mut self.state);
        } else {
            self.phase = p;
        }
    }
}
