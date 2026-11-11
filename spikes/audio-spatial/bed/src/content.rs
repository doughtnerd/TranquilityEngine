//! Distinct music-like buffers per voice: a note (4 decaying harmonics, slow tremolo) over a little
//! noise, from a per-voice seed. Oscillators run on the Chebyshev recurrence, so generating
//! 1,024 voices is cheap even in wasm.
pub struct Rng(pub u32);
impl Rng {
    #[inline]
    pub fn next(&mut self) -> u32 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.0 = s;
        s
    }
    /// 0..1
    #[inline]
    pub fn f(&mut self) -> f32 {
        (self.next() >> 8) as f32 * (1.0 / 16777216.0)
    }
    #[inline]
    pub fn sym(&mut self) -> f32 {
        self.f() * 2.0 - 1.0
    }
}

pub fn music(seed: u32, frames: usize, rate: f32, out: &mut [f32]) {
    let mut r = Rng(seed.wrapping_mul(2654435761).wrapping_add(12345) | 1);
    for _ in 0..4 { r.next(); }
    let semis = [0, 2, 4, 7, 9, 12, 14, 16];
    let f0 = 110.0 * libm::powf(2.0, (semis[(r.next() % 8) as usize] + 12 * (r.next() % 3) as i32) as f32 / 12.0);
    let mut osc = [(0.0f32, 0.0f32, 0.0f32, 0.0f32); 4]; // (y1, y2, 2cos, amp)
    for (h, o) in osc.iter_mut().enumerate() {
        let w = 2.0 * std::f32::consts::PI * f0 * (h + 1) as f32 / rate;
        let ph = r.f() * 6.28318;
        *o = (libm::sinf(ph - w), libm::sinf(ph - 2.0 * w), 2.0 * libm::cosf(w), 0.5 / (h + 1) as f32);
    }
    let trem_w = 2.0 * std::f32::consts::PI * (0.5 + 4.0 * r.f()) / rate;
    let (mut ts1, mut ts2, tc) = (libm::sinf(-trem_w), libm::sinf(-2.0 * trem_w), 2.0 * libm::cosf(trem_w));
    for i in 0..frames {
        let mut s = 0.0;
        for o in osc.iter_mut() {
            let y = o.2 * o.0 - o.1;
            o.1 = o.0;
            o.0 = y;
            s += y * o.3;
        }
        let t = tc * ts1 - ts2;
        ts2 = ts1;
        ts1 = t;
        out[i] = 0.35 * s * (0.75 + 0.25 * t) + 0.03 * r.sym();
    }
}

pub fn noise(seed: u32, out: &mut [f32]) {
    let mut r = Rng(seed | 1);
    for v in out.iter_mut() { *v = r.sym(); }
}
