//! Which source second an output frame of a stage plays: automation lanes run over source time
//! (`clipTime`, ADR 0342/D23), while the render's frames have the trim and closed gaps removed.
//!
//! The map is the spec's segments, `(output frame, source seconds)`: frame `f` at or after a
//! segment's frame plays `seconds + (f − frame) / rate` (before the first segment, the first
//! segment extended backwards; no segment: frame / rate). A tail past the end extends the last
//! segment. After a reverse of `len` frames, frame `f` plays what frame `len − 1 − f` did.

pub struct TimeMap {
    segments: Vec<(f64, f64)>,
    rate: f64,
    /// Frame `f` reads the segments at `a·f + b`.
    a: f64,
    b: f64,
}

impl TimeMap {
    pub fn new(segments: Vec<(f64, f64)>, rate: f64) -> TimeMap {
        let segments = if segments.is_empty() { vec![(0.0, 0.0)] } else { segments };
        TimeMap { segments, rate, a: 1.0, b: 0.0 }
    }

    /// The source second at output frame `frame`.
    pub fn at(&self, frame: f64) -> f64 {
        let f = self.a * frame + self.b;
        let i = self.segments.partition_point(|s| s.0 <= f).saturating_sub(1);
        let (start, secs) = self.segments[i];
        secs + (f - start) / self.rate
    }

    /// The map after reversing `len` frames.
    pub fn reverse(&mut self, len: usize) {
        let last = len.saturating_sub(1) as f64;
        // f -> a·(last − f) + b
        self.b += self.a * last;
        self.a = -self.a;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_segments_tails_and_reverses() {
        let mut m = TimeMap::new(vec![(0.0, 0.5), (100.0, 2.0)], 100.0);
        assert_eq!(m.at(0.0), 0.5);
        assert_eq!(m.at(50.0), 1.0);
        assert_eq!(m.at(100.0), 2.0);
        assert_eq!(m.at(150.0), 2.5, "a tail extends the last segment");
        m.reverse(200);
        assert_eq!(m.at(199.0), 0.5);
        assert_eq!(m.at(0.0), 2.99);
        m.reverse(200);
        assert_eq!(m.at(50.0), 1.0, "twice is the identity");
        assert_eq!(TimeMap::new(vec![], 10.0).at(5.0), 0.5);
    }
}
