//! Bus meters (api-and-models §4.3 `peaks`; architecture §8 "Bus meters").
//!
//! Each bus keeps a [`Meter`]: its left and right peak, measured on the bus's output (after its
//! effects, snapshot low-pass and gain: the level the bus sends to its parent). Per quantum the
//! level falls by [`DECAY_DB_PER_SECOND`] and rises at once to any louder sample:
//! `level = max(level * decay, max |x|)`. So a transient between two STATUS blocks is never
//! missed, and the value in STATUS is already a display level. The design decays on main at
//! -20 dB/s; with the decay here at the same rate, main's decay holds the same value, so A2.3 can
//! read `peaks` as they are.
//!
//! `bus.rs` updates the meters after each bus's mixdown and copies the first
//! [`crate::counters::PEAKS_CAP`] into the counters (K12). All-zero is a silent meter. Nothing here
//! allocates.

/// How fast a meter falls, in dB per second (architecture §8).
pub const DECAY_DB_PER_SECOND: f32 = 20.0;

/// One bus's peak level, left and right (linear). All-zero is silent.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Meter {
    pub l: f32,
    pub r: f32,
}

impl Meter {
    /// Folds one block of the bus's output into the meter: each channel decays by `decay` (the
    /// per-block factor from [`decay_per_block`]), then rises to the block's largest magnitude.
    /// A NaN sample is ignored (`f32::max` keeps the other operand).
    pub fn update(&mut self, left: &[f32], right: &[f32], decay: f32) {
        self.l = peak(left).max(self.l * decay);
        self.r = peak(right).max(self.r * decay);
    }

    /// Silences the meter (RESET).
    pub fn reset(&mut self) {
        *self = Meter::default();
    }
}

/// The largest magnitude in `samples` (0 for an empty slice; NaNs ignored).
pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

/// The per-block decay factor for blocks of `frames` frames at `sample_rate`:
/// `10^(-DECAY_DB_PER_SECOND * frames / sample_rate / 20)`. 0 for a non-positive rate.
pub fn decay_per_block(sample_rate: f32, frames: usize) -> f32 {
    if !(sample_rate > 0.0) {
        return 0.0;
    }
    let seconds = frames as f32 / sample_rate;
    libm::powf(10.0, -DECAY_DB_PER_SECOND * seconds / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DECAY: f32 = 0.5;

    #[test]
    fn a_zeroed_meter_is_silent() {
        let m = Meter::default();
        assert_eq!((m.l, m.r), (0.0, 0.0));
    }

    #[test]
    fn the_meter_rises_at_once_to_the_largest_magnitude() {
        let mut m = Meter::default();
        m.update(&[0.1, -0.8, 0.3], &[0.2, 0.25, -0.05], DECAY);
        assert_eq!((m.l, m.r), (0.8, 0.25));
    }

    #[test]
    fn the_meter_decays_when_the_signal_is_quieter() {
        let mut m = Meter { l: 1.0, r: 0.5 };
        m.update(&[0.1], &[0.0], DECAY);
        assert_eq!((m.l, m.r), (0.5, 0.25));
        m.update(&[0.4], &[0.2], DECAY);
        assert_eq!((m.l, m.r), (0.4, 0.2), "a louder block than the decayed level wins");
    }

    #[test]
    fn nan_samples_are_ignored() {
        let mut m = Meter::default();
        m.update(&[f32::NAN, 0.5], &[f32::NAN], DECAY);
        assert_eq!((m.l, m.r), (0.5, 0.0));
    }

    #[test]
    fn the_decay_is_twenty_db_per_second() {
        // 375 quanta of 128 frames at 48 kHz is one second: the product is -20 dB = 0.1.
        let d = decay_per_block(48_000.0, 128);
        let mut level = 1.0f32;
        for _ in 0..375 {
            level *= d;
        }
        assert!((level - 0.1).abs() < 1e-4, "{level}");
        assert_eq!(decay_per_block(0.0, 128), 0.0);
        assert_eq!(decay_per_block(48_000.0, 0), 1.0);
    }

    #[test]
    fn reset_silences() {
        let mut m = Meter { l: 0.7, r: 0.9 };
        m.reset();
        assert_eq!(m, Meter::default());
    }
}
