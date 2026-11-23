//! A topology-preserving state-variable filter (Zavalishin, *The Art of VA Filter Design*; Simper's form): low-, high-
//! and band-pass from one structure, stable under per-sample coefficient changes (ADR 0360 §3), and the one-pole TPT
//! high-pass the blip's sfxr filter maps onto.

/// Highest cut-off a filter takes, as a fraction of the rate (`tan` grows without bound towards 0.5).
pub const MAX_CUTOFF: f32 = 0.45;
/// Lowest cut-off in Hz.
pub const MIN_CUTOFF_HZ: f32 = 1.0;

/// The filter types (the synth's `filterType` choice order).
pub const LOWPASS: u8 = 0;
pub const HIGHPASS: u8 = 1;
pub const BANDPASS: u8 = 2;

/// The SVF's state and coefficients. All-zero is a filter that outputs 0 until [`Svf::set`] runs.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Svf {
    pub ic1: f32,
    pub ic2: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    k: f32,
}

impl Svf {
    /// Sets the cut-off (`hz`, clamped to the filter's range at `rate`) and the Q (at least 0.005: sfxr's heavily damped
    /// low-pass maps below 0.1). Keeps the state.
    #[inline]
    pub fn set(&mut self, hz: f32, q: f32, rate: f32) {
        let hz = hz.clamp(MIN_CUTOFF_HZ, MAX_CUTOFF * rate);
        let g = libm::tanf(core::f32::consts::PI * hz / rate);
        let k = 1.0 / q.max(0.005);
        self.k = k;
        self.a1 = 1.0 / (1.0 + g * (g + k));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
    }

    /// One sample: `(low, band, high)`.
    #[inline]
    pub fn tick(&mut self, v0: f32) -> (f32, f32, f32) {
        let v3 = v0 - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        (v2, v1, v0 - self.k * v1 - v2)
    }

    /// One sample of type `kind` ([`LOWPASS`], [`HIGHPASS`], [`BANDPASS`]: the band-pass normalised to 0 dB at its centre).
    #[inline]
    pub fn process(&mut self, kind: u8, v0: f32) -> f32 {
        let (low, band, high) = self.tick(v0);
        match kind {
            HIGHPASS => high,
            BANDPASS => band * self.k,
            _ => low,
        }
    }

    pub fn clear(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }
}

/// A one-pole TPT high-pass. All-zero passes nothing until [`OnePole::set`] runs.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OnePole {
    pub s: f32,
    g: f32,
}

impl OnePole {
    /// Cut-off `hz` at `rate` (clamped like the SVF's).
    #[inline]
    pub fn set(&mut self, hz: f32, rate: f32) {
        let hz = hz.clamp(0.01, MAX_CUTOFF * rate);
        let g = libm::tanf(core::f32::consts::PI * hz / rate);
        self.g = g / (1.0 + g);
    }

    /// One sample of the high-pass.
    #[inline]
    pub fn highpass(&mut self, x: f32) -> f32 {
        let v = (x - self.s) * self.g;
        let low = v + self.s;
        self.s = low + v;
        x - low
    }
}
