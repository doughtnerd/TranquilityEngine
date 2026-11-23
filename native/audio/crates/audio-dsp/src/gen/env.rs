//! ADSR envelopes (ADR 0346 §3): a linear attack, then an exponential decay to the sustain level and an exponential
//! release, each reaching 1 % of its span at its set time. The envelope is done once a release falls below [`END_LEVEL`].
//! [`Adsr::advance`] moves it `n` samples in O(1) (a virtual voice keeps its envelopes' time without rendering).

/// A release below this is silence: the envelope is done (−60 dB).
pub const END_LEVEL: f32 = 0.001;
/// What is left of an exponential segment's span at its set time.
pub const SPAN_LEFT: f32 = 0.01;

pub mod stage {
    pub const IDLE: u8 = 0;
    pub const ATTACK: u8 = 1;
    pub const DECAY: u8 = 2;
    pub const SUSTAIN: u8 = 3;
    pub const RELEASE: u8 = 4;
    pub const DONE: u8 = 5;
}

/// One envelope. All-zero is idle at 0.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Adsr {
    pub value: f32,
    /// The decay's distance above the sustain level, kept apart so a slow decay never stalls on `f32` rounding near it.
    dist: f32,
    pub stage: u8,
    /// The attack's step per sample (1 for an attack of 0).
    attack: f32,
    /// The decay's and release's per-sample factors on the distance to their targets.
    decay: f32,
    release: f32,
    pub sustain: f32,
}

/// The per-sample factor of an exponential segment of `seconds` at `rate` (0 for no time: it jumps).
#[inline]
fn factor(seconds: f32, rate: f32) -> f32 {
    let n = seconds * rate;
    if n < 1.0 {
        0.0
    } else {
        libm::expf(libm::logf(SPAN_LEFT) / n)
    }
}

impl Adsr {
    /// Sets the times (seconds) and the sustain level (0..1); the stage and value are kept.
    pub fn configure(&mut self, attack: f32, decay: f32, sustain: f32, release: f32, rate: f32) {
        let n = attack * rate;
        self.attack = if n < 1.0 { 1.0 } else { 1.0 / n };
        self.decay = factor(decay, rate);
        self.release = factor(release, rate);
        self.sustain = sustain.clamp(0.0, 1.0);
    }

    /// Key-on: the attack starts from the current value.
    pub fn gate_on(&mut self) {
        self.stage = stage::ATTACK;
    }

    /// Key-off: the release starts from the current value (an idle or finished envelope stays so).
    pub fn gate_off(&mut self) {
        if self.stage != stage::IDLE && self.stage != stage::DONE {
            self.stage = stage::RELEASE;
        }
    }

    #[inline]
    pub fn done(&self) -> bool {
        self.stage == stage::DONE
    }

    /// `true` while the value stays where it is (sustaining, idle or done).
    #[inline]
    pub fn settled(&self) -> bool {
        matches!(self.stage, stage::SUSTAIN | stage::IDLE | stage::DONE)
    }

    /// The next sample's value.
    #[inline]
    pub fn next(&mut self) -> f32 {
        match self.stage {
            stage::ATTACK => {
                self.value += self.attack;
                if self.value >= 1.0 {
                    self.value = 1.0;
                    self.dist = 1.0 - self.sustain;
                    self.stage = stage::DECAY;
                }
            }
            stage::DECAY => {
                self.dist *= self.decay;
                self.value = self.sustain + self.dist;
                if self.dist.abs() < 1e-5 {
                    self.value = self.sustain;
                    self.stage = stage::SUSTAIN;
                }
            }
            stage::SUSTAIN => self.value = self.sustain,
            stage::RELEASE => {
                self.value *= self.release;
                if self.value < END_LEVEL {
                    self.value = 0.0;
                    self.stage = stage::DONE;
                }
            }
            _ => {}
        }
        self.value
    }

    /// Moves `n` samples on in O(1) per segment (the same stages as `n` calls of [`Adsr::next`], to rounding).
    pub fn advance(&mut self, mut n: u32) {
        while n > 0 {
            match self.stage {
                stage::ATTACK => {
                    let need = libm::ceilf((1.0 - self.value) / self.attack).max(1.0);
                    if (n as f32) < need {
                        self.value += self.attack * n as f32;
                        return;
                    }
                    n -= need as u32;
                    self.value = 1.0;
                    self.dist = 1.0 - self.sustain;
                    self.stage = stage::DECAY;
                }
                stage::DECAY => {
                    self.dist *= libm::powf(self.decay, n as f32);
                    self.value = self.sustain + self.dist;
                    if self.dist.abs() < 1e-5 {
                        self.value = self.sustain;
                        self.stage = stage::SUSTAIN;
                    }
                    return;
                }
                stage::SUSTAIN => {
                    self.value = self.sustain;
                    return;
                }
                stage::RELEASE => {
                    self.value *= libm::powf(self.release, n as f32);
                    if self.value < END_LEVEL {
                        self.value = 0.0;
                        self.stage = stage::DONE;
                    }
                    return;
                }
                _ => return,
            }
        }
    }
}
