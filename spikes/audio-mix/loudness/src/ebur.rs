//! The `ebur128` crate behind the same interface the checks and the bench use.
use ebur128::{EbuR128, Mode};

pub struct Ref {
    pub m: EbuR128,
}

impl Ref {
    pub fn new(rate: u32, mode: Mode) -> Self {
        Ref { m: EbuR128::new(2, rate, mode).unwrap() }
    }
    pub fn full(rate: u32) -> Self {
        Self::new(rate, Mode::M | Mode::S | Mode::I | Mode::LRA | Mode::TRUE_PEAK | Mode::SAMPLE_PEAK)
    }
    pub fn add(&mut self, l: &[f32], r: &[f32]) {
        self.m.add_frames_planar_f32(&[l, r]).unwrap();
    }
}
