//! Sync-marker phase maths, for sync groups (ADR 0372): members of a group follow the leader's
//! *phase*, so blended walk and run cycles keep their feet in step.
//!
//! A clip's sync markers are `(id, time)` pairs, `id` the interned id of the marker's name
//! (`L_foot`, `R_foot`), **sorted by time, times in `[0, duration]`**. The caller passes only the
//! markers of the group's names. Consecutive markers bound *segments*:
//!
//! - looping clip: segment `i` runs from marker `i` to marker `i + 1`, the last from marker `k-1`
//!   to marker `0` plus `duration` (it wraps, so times before marker 0 lie in that last
//!   segment);
//! - non-looping clip: the same, except the last segment ends at `duration`, and times before
//!   marker 0 have no marker (they use the normalised-time fallback).
//!
//! A [`SyncPhase`] is the segment (index and id of its first marker) plus the fraction of the way
//! through it, and also the normalised time (`time / duration`). [`SyncClip::time_at`] turns a
//! phase into a time in another clip: it looks for the phase's marker id at the same index, else
//! at the nearest index with that id; if that clip has no such marker, or the phase has none, it
//! falls back to the normalised time. Two clips with the same marker sequence (the same ids in
//! the same order, e.g. `L R L R`) therefore stay aligned however the markers are spaced.
//!
//! Plain `f32` arithmetic (`+ - × ÷` and `floor`), so all targets agree bit for bit.

/// The `marker` of a phase that has no marker (see [`SyncPhase`]).
pub const NO_MARKER: u32 = u32::MAX;

/// A named point in a clip.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SyncMarker {
    /// The interned id of the marker's name.
    pub id: u32,
    /// Seconds from the clip start.
    pub time: f32,
}

/// Where a clip is in its cycle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SyncPhase {
    /// Index of the segment's first marker, or [`NO_MARKER`] (the clip has no markers, or the
    /// time is before the first marker of a non-looping clip).
    pub marker: u32,
    /// That marker's id (0 with no marker).
    pub id: u32,
    /// Progress through the segment, in [0, 1] (the normalised time when `marker` is
    /// [`NO_MARKER`]).
    pub fraction: f32,
    /// `time / duration` in [0, 1], always, for the fallback.
    pub normalized: f32,
}

/// A clip's sync data.
#[derive(Clone, Copy, Debug)]
pub struct SyncClip<'a> {
    pub markers: &'a [SyncMarker],
    pub duration: f32,
    pub looping: bool,
}

impl SyncClip<'_> {
    /// `time` folded into the clip: wrapped into `[0, duration)` when looping, clamped to
    /// `[0, duration]` otherwise. 0 for a clip without duration, a NaN time, or (looping) an
    /// infinite one.
    pub fn wrap_time(&self, time: f32) -> f32 {
        let d = self.duration;
        if !(d > 0.0) || time.is_nan() {
            return 0.0;
        }
        if self.looping {
            // An infinite time has no phase (it would make `inf - inf` below).
            if time.abs() == f32::INFINITY {
                return 0.0;
            }
            let t = time - (time / d).floor() * d;
            // Rounding can land exactly on d (a tiny negative time).
            if t >= d || t < 0.0 {
                0.0
            } else {
                t
            }
        } else if time > 0.0 {
            if time < d {
                time
            } else {
                d
            }
        } else {
            0.0
        }
    }

    /// The phase at `time` (wrapped or clamped as [`wrap_time`](Self::wrap_time)).
    pub fn phase_at(&self, time: f32) -> SyncPhase {
        let d = self.duration;
        if !(d > 0.0) {
            return SyncPhase {
                marker: NO_MARKER,
                id: 0,
                fraction: 0.0,
                normalized: 0.0,
            };
        }
        let t = self.wrap_time(time);
        let normalized = t / d;
        let ms = self.markers;
        let k = ms.len();
        let idx = ms.partition_point(|m| m.time <= t);
        let fallback = SyncPhase {
            marker: NO_MARKER,
            id: 0,
            fraction: normalized,
            normalized,
        };
        if k == 0 {
            return fallback;
        }
        let (prev, start, end);
        if idx == 0 {
            if !self.looping {
                return fallback;
            }
            prev = k - 1;
            start = ms[k - 1].time - d;
            end = ms[0].time;
        } else {
            prev = idx - 1;
            start = ms[prev].time;
            end = self.segment_end(prev);
        }
        let len = end - start;
        let fraction = if len > 0.0 {
            let f = (t - start) / len;
            if f > 0.0 {
                if f < 1.0 {
                    f
                } else {
                    1.0
                }
            } else {
                0.0
            }
        } else {
            0.0
        };
        SyncPhase {
            marker: prev as u32,
            id: ms[prev].id,
            fraction,
            normalized,
        }
    }

    /// The time in this clip at `phase`, from a phase taken in this or another clip. See the
    /// module docs for the marker lookup and the normalised-time fallback.
    pub fn time_at(&self, phase: SyncPhase) -> f32 {
        let d = self.duration;
        if !(d > 0.0) {
            return 0.0;
        }
        let by_normalized = self.wrap_time(phase.normalized * d);
        if phase.marker == NO_MARKER || self.markers.is_empty() {
            return by_normalized;
        }
        let Some(m) = self.find_marker(phase.marker as usize, phase.id) else {
            return by_normalized;
        };
        let start = self.markers[m].time;
        let end = self.segment_end(m);
        let t = start + phase.fraction * (end - start);
        self.wrap_time_end(t)
    }

    /// The end of the segment that starts at marker `m`.
    fn segment_end(&self, m: usize) -> f32 {
        let ms = self.markers;
        if m + 1 < ms.len() {
            ms[m + 1].time
        } else if self.looping {
            ms[0].time + self.duration
        } else {
            self.duration
        }
    }

    /// The marker with `id` nearest to index `near` (the lower index on a tie).
    fn find_marker(&self, near: usize, id: u32) -> Option<usize> {
        let ms = self.markers;
        if near < ms.len() && ms[near].id == id {
            return Some(near);
        }
        let mut best: Option<(usize, usize)> = None;
        for (i, m) in ms.iter().enumerate() {
            if m.id == id {
                let dist = i.abs_diff(near);
                if best.is_none_or(|(_, b)| dist < b) {
                    best = Some((i, dist));
                }
            }
        }
        best.map(|(i, _)| i)
    }

    /// A time computed inside a segment: the last segment of a looping clip runs past
    /// `duration`, so it wraps; a non-looping clip clamps.
    fn wrap_time_end(&self, t: f32) -> f32 {
        let d = self.duration;
        if self.looping {
            if t >= d {
                t - d
            } else {
                t
            }
        } else if t < d {
            t
        } else {
            d
        }
    }
}
