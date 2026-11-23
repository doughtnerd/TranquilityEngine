//! Band-limited oscillators (ADR 0346 §3): a phase accumulator in `f64` (long drones keep their pitch) read as a saw
//! or a pulse with a two-sample polynomial residual at each discontinuity (PolyBLEP, Välimäki and Huovilainen), a
//! triangle with the integrated residual at each corner (PolyBLAMP, Esqueda et al.: no leaky integrator to drift), and a
//! sine through a polynomial. Every read takes `dt`, the phase increment of this sample (frequency × pitch ÷ rate), so a
//! pitch that moves per sample bends the residuals with it. `dt` must stay below [`MAX_DT`].

/// The largest phase increment an oscillator takes (0.45 × the rate): the residuals assume one discontinuity at most in
/// two samples, so callers clamp their frequency to this ([`dt_of`]).
pub const MAX_DT: f64 = 0.45;

/// The phase increment of `hz` at `inv_rate` (1 ÷ the rate), clamped to `0..=MAX_DT`.
#[inline]
pub fn dt_of(hz: f64, inv_rate: f64) -> f64 {
    let dt = hz * inv_rate;
    if dt > MAX_DT {
        MAX_DT
    } else if dt > 0.0 {
        dt
    } else {
        0.0
    }
}

/// The PolyBLEP residual at phase `t` (0..1, the discontinuity at 0) for increment `dt`: the band-limited unit-height
/// step less the naive one, times 2 (so a jump of `d` takes `d / 2` of it). Zero away from the discontinuity.
#[inline]
pub fn blep(t: f64, dt: f64) -> f64 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

/// The PolyBLAMP residual at phase `t` for increment `dt`: the integral of [`blep`] (a corner where the slope changes by
/// `s` per sample takes `s / 2` of it). Zero away from the corner.
#[inline]
pub fn blamp(t: f64, dt: f64) -> f64 {
    if t < dt {
        let x = t / dt - 1.0;
        -(x * x * x) * (1.0 / 3.0)
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt + 1.0;
        x * x * x * (1.0 / 3.0)
    } else {
        0.0
    }
}

/// `sin(2π t)` for any `t` (in cycles), from a 9th-order odd polynomial on a quarter cycle: error below 4e-6 (−108 dB).
#[inline]
pub fn sine_cycles(t: f64) -> f32 {
    // Wrap to [-0.5, 0.5), then fold to [-0.25, 0.25] (sin(π - θ) = sin θ). `f64::floor` (exact, one wasm instruction),
    // not `libm::floor` (a software routine on wasm32: libm's intrinsics need an unstable feature).
    let mut u = (t - (t + 0.5).floor()) as f32;
    if u > 0.25 {
        u = 0.5 - u;
    } else if u < -0.25 {
        u = -0.5 - u;
    }
    let x = u * core::f32::consts::TAU;
    let x2 = x * x;
    x * (1.0 + x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 * (-1.0 / 5_040.0 + x2 * (1.0 / 362_880.0)))))
}

/// One oscillator's phase (cycles, `0..1`). All-zero is a fresh oscillator at phase 0.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Osc {
    pub phase: f64,
}

impl Osc {
    #[inline]
    fn step(&mut self, dt: f64) {
        let p = self.phase + dt;
        self.phase = if p >= 1.0 { p - 1.0 } else { p };
    }

    /// A rising saw, −1..1, band-limited.
    #[inline]
    pub fn saw(&mut self, dt: f64) -> f32 {
        let y = saw_at(self.phase, dt);
        self.step(dt);
        y as f32
    }

    /// A pulse of `amp` (high for the first `width` of the cycle, 0..1), band-limited.
    #[inline]
    pub fn pulse(&mut self, dt: f64, width: f64, amp: f64) -> f32 {
        let y = pulse_at(self.phase, dt, width, amp);
        self.step(dt);
        y as f32
    }

    /// A triangle, −1 at phase 0, +1 at 0.5, band-limited at both corners.
    #[inline]
    pub fn triangle(&mut self, dt: f64) -> f32 {
        let y = triangle_at(self.phase, dt);
        self.step(dt);
        y as f32
    }

    /// A sine.
    #[inline]
    pub fn sine(&mut self, dt: f64) -> f32 {
        let y = sine_cycles(self.phase);
        self.step(dt);
        y
    }
}

/// A rising saw at phase `t` (−1..1), band-limited for increment `dt`.
#[inline]
pub fn saw_at(t: f64, dt: f64) -> f64 {
    t + t - 1.0 - blep(t, dt)
}

/// A pulse of `amp` at phase `t`, high for the first `width` of the cycle, band-limited for increment `dt`.
#[inline]
pub fn pulse_at(t: f64, dt: f64, width: f64, amp: f64) -> f64 {
    let naive = if t < width { amp } else { -amp };
    // Most samples sit more than `dt` from both edges, where both residuals are 0: the naive value, with four compares
    // (the residuals are continuous at the edges of their support, so where a compare rounds either way both are ~0).
    let far = 1.0 - dt;
    let u = (t - width).abs();
    if t >= dt && t <= far && u >= dt && u <= far {
        return naive;
    }
    let mut down = t - width;
    if down < 0.0 {
        down += 1.0;
    }
    naive + amp * (blep(t, dt) - blep(down, dt))
}

/// A triangle at phase `t`, −1 at 0 and +1 at 0.5, band-limited at both corners for increment `dt`.
#[inline]
pub fn triangle_at(t: f64, dt: f64) -> f64 {
    let naive = if t < 0.5 { 4.0 * t - 1.0 } else { 3.0 - 4.0 * t };
    let mut top = t - 0.5;
    if top < 0.0 {
        top += 1.0;
    }
    // The slope changes by 8 dt per sample at each corner: +8 dt at the bottom, -8 dt at the top.
    naive + 4.0 * dt * (blamp(t, dt) - blamp(top, dt))
}

/// A sample-and-hold source stepping `rate` times a cycle of its own phase (sfxr's noise: 32 steps a period), each
/// step band-limited by PolyBLEP: the next value is drawn a step ahead so the residual before the jump knows its height.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Held {
    pub phase: f64,
    pub cur: f32,
    pub next: f32,
    /// The height of the step just taken (the residual after it).
    pub last: f32,
}

impl Held {
    /// The held value at increment `dt` (the step rate ÷ the rate); `draw` gives the next random value. With `dt` past
    /// [`MAX_DT`] the steps come faster than the rate holds them: a fresh value every sample (white).
    #[inline]
    pub fn next(&mut self, dt: f64, mut draw: impl FnMut() -> f32) -> f32 {
        if dt >= MAX_DT {
            self.cur = draw();
            return self.cur;
        }
        let t = self.phase;
        let mut y = self.cur as f64;
        if t > 1.0 - dt {
            y += 0.5 * (self.next - self.cur) as f64 * blep(t, dt);
        } else if t < dt {
            y += 0.5 * self.last as f64 * blep(t, dt);
        }
        let p = t + dt;
        if p >= 1.0 {
            self.phase = p - 1.0;
            self.last = self.next - self.cur;
            self.cur = self.next;
            self.next = draw();
        } else {
            self.phase = p;
        }
        y as f32
    }
}
