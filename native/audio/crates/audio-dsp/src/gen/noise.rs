//! Noise (ADR 0346 §3): white from xorshift32 seeded per voice (the GEN seed), pink by Paul Kellet's refined filter on
//! white, brown by a leaky integrator (−6 dB/octave above [`BROWN_CORNER_HZ`]). The three are normalised to white's RMS
//! (1/√3), so a colour change keeps the level. Deterministic: the same seed gives the same samples on every build.

/// Where the brown noise's integrator leaks (its −6 dB/octave slope holds above this).
pub const BROWN_CORNER_HZ: f32 = 20.0;

/// Brings Kellet's sum back to white's RMS (its gain at 44.1 to 48 kHz; `tests/gen.rs` measures the colours' RMS).
const PINK_GAIN: f32 = 0.3313;

/// The first state of a xorshift32 from `seed` (never 0, which xorshift can't leave).
#[inline]
pub fn seed_state(seed: u32) -> u32 {
    let s = seed ^ 0x6D2B_79F5;
    if s == 0 {
        0x9E37_79B9
    } else {
        s
    }
}

/// One xorshift32 step on `state`; returns the new state.
#[inline]
pub fn xorshift32(state: &mut u32) -> u32 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    x
}

/// A uniform value in `-1..1` from `state`.
#[inline]
pub fn uniform(state: &mut u32) -> f32 {
    (xorshift32(state) as i32) as f32 * (1.0 / 2_147_483_648.0)
}

/// A noise source: its generator and the pink and brown filters. All-zero is not seeded: call [`Noise::seeded`].
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Noise {
    pub state: u32,
    pink: [f32; 7],
    brown: f32,
    /// The brown integrator's pole and the gain that restores white's RMS.
    brown_a: f32,
    brown_g: f32,
}

impl Noise {
    /// A source seeded with `seed` at `rate` Hz.
    pub fn seeded(seed: u32, rate: f32) -> Noise {
        let a = libm::expf(-core::f32::consts::TAU * BROWN_CORNER_HZ / rate);
        // An AR(1) of pole a fed (1 - a) w has variance var(w) (1 - a) / (1 + a).
        let g = libm::sqrtf((1.0 + a) / (1.0 - a));
        Noise { state: seed_state(seed), pink: [0.0; 7], brown: 0.0, brown_a: a, brown_g: g }
    }

    /// Re-seeds the generator, keeping the filters' state.
    pub fn reseed(&mut self, seed: u32) {
        self.state = seed_state(seed);
    }

    #[inline]
    pub fn white(&mut self) -> f32 {
        uniform(&mut self.state)
    }

    /// Kellet's refined pink filter (seven poles, within ±0.05 dB of −3 dB/octave from 9 Hz at 44.1 kHz).
    #[inline]
    pub fn pink(&mut self) -> f32 {
        let w = self.white();
        let b = &mut self.pink;
        b[0] = 0.99886 * b[0] + w * 0.055_517_9;
        b[1] = 0.99332 * b[1] + w * 0.075_075_9;
        b[2] = 0.96900 * b[2] + w * 0.153_852;
        b[3] = 0.86650 * b[3] + w * 0.310_485_6;
        b[4] = 0.55000 * b[4] + w * 0.532_952_2;
        b[5] = -0.7616 * b[5] - w * 0.016_898;
        let y = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
        b[6] = w * 0.115_926;
        y * PINK_GAIN
    }

    /// Brown: white through a leaky integrator, at white's RMS.
    #[inline]
    pub fn brown(&mut self) -> f32 {
        let w = self.white();
        self.brown = self.brown_a * self.brown + (1.0 - self.brown_a) * w;
        self.brown * self.brown_g
    }

    /// Colour `colour` (0 white, 1 pink, 2 brown).
    #[inline]
    pub fn colour(&mut self, colour: u8) -> f32 {
        match colour {
            1 => self.pink(),
            2 => self.brown(),
            _ => self.white(),
        }
    }
}
