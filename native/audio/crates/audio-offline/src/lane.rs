//! An automation lane's curve, evaluated by the core's own evaluator
//! (`audio_core::automation::eval`, which matches `src/engine/core/curve.ts`).
//!
//! The core keeps at most `CURVE_KEYS` keys a curve; a sample's lane may hold more. The value at
//! `x` depends only on the segment holding `x` (its two keys, their interps and handles) and on
//! the first and last keys, so the lane keeps every key and evaluates through a window of
//! `CURVE_KEYS` of them that holds the segment, rebuilt when `x` leaves it (time only moves
//! forward in a render, so that is rare).

use audio_core::automation::{eval, Curve, CURVE_KEYS};

use crate::spec::Key;

pub struct Lane {
    keys: Vec<Key>,
    /// The first key in the window.
    from: usize,
    window: Curve,
}

impl Lane {
    pub fn new(keys: Vec<Key>) -> Lane {
        let window = Curve::from_keys(&keys[..keys.len().min(CURVE_KEYS)]);
        Lane { keys, from: 0, window }
    }

    /// The lane's value at `x` (source seconds).
    pub fn at(&mut self, x: f32) -> f32 {
        let n = self.keys.len();
        if n <= CURVE_KEYS {
            return eval(&self.window, x);
        }
        // The segment's first key: the last key at or before x (0 before the first key, NaN too),
        // and never the last key (its segment would need a key past it).
        let k = self.keys.partition_point(|key| key.0 <= x).saturating_sub(1).min(n - 2);
        if !(k >= self.from && k + 1 < self.from + CURVE_KEYS) {
            self.from = k.min(n - CURVE_KEYS);
            self.window = Curve::from_keys(&self.keys[self.from..self.from + CURVE_KEYS]);
        }
        eval(&self.window, x)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_lane_reads_like_its_segments_and_ends() {
        // 200 keys: a sawtooth, linear, x = 0..199, y = x % 7.
        let keys: Vec<Key> = (0..200).map(|i| (i as f32, (i % 7) as f32, 0u8, [0.0; 4])).collect();
        let mut lane = Lane::new(keys);
        assert_eq!(lane.at(-3.0), 0.0);
        assert_eq!(lane.at(250.0), (199 % 7) as f32);
        for i in 0..398 {
            let x = i as f32 * 0.5;
            let a = (x.floor() as i32 % 7) as f32;
            let b = ((x.floor() as i32 + 1) % 7) as f32;
            let want = a + (b - a) * (x - x.floor());
            assert!((lane.at(x) - want).abs() < 1e-5, "x {x}");
        }
        // Backwards too (rebuilds the window).
        assert!((lane.at(3.5) - 3.5).abs() < 1e-5);
    }

    #[test]
    fn a_bezier_lane_matches_the_core_curve() {
        let keys: Vec<Key> = vec![(0.0, 0.0, 5, [0.0, 0.0, 0.2, 1.0]), (1.0, 1.0, 5, [-0.5, 0.0, 0.0, 0.0])];
        let core = Curve::from_keys(&keys);
        let mut lane = Lane::new(keys);
        for i in 0..=10 {
            let x = i as f32 / 10.0;
            assert_eq!(lane.at(x), eval(&core, x));
        }
    }
}
