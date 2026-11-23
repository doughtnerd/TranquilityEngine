//! Timeline helpers (ADR 0371, 0372): a playhead's wrap modes turned into track windows, subclip
//! track tables, and the crossfade mix of overlapping entries. Pure functions over caller-owned
//! slices; nothing here allocates.
//!
//! # Playhead
//!
//! [`advance`] moves a [`Playhead`] by a signed `delta` seconds under a [`Wrap`] mode and returns
//! the [`Window`]s the move covers, to feed [`BoundClip::evaluate`](crate::BoundClip::evaluate):
//!
//! - **once, hold:** one non-looping window, clamped to `[0, d]`; `finished` when the move reaches
//!   `d` (forward) or 0 (backward). Keys at `d` are crossed by that window (the end is inclusive).
//! - **loop:** one *looping* window ([`Window::looping`]), which crosses the loop point as the
//!   track windows define (a key at `d` and a key at 0 both fire), capped at [`MAX_WRAPS`]
//!   durations; the playhead wraps into `[0, d)` and `wraps` counts the crossings.
//! - **pingpong:** one non-looping window per leg (at most [`MAX_LEGS`]; a move longer than two
//!   durations is first reduced by whole round trips), reversing at each end, `wraps` counting the
//!   turns. The key at an end is crossed by the leg that arrives; the leg that leaves doesn't cross
//!   it again.
//!
//! The first window of a play carries [`WINDOW_START`] (`first`). The playhead is f32, the same
//! precision the windows use, so consecutive windows meet exactly (the next `from` is the last
//! window's end).
//!
//! # Subclip tracks
//!
//! [`ClipBindings::subclip_tracks`] lists a clip's `subclip` tracks with their key ranges;
//! [`ClipBindings::same_layout`] says whether two clips' column blocks are laid out alike.
//!
//! # Mixing
//!
//! Entries that overlap on one subclip track are mixed column by column ([`mix_add`],
//! [`mix_resolve`]) by their weights: f32 columns (`float`…`vec4`, `color`, `morph`, `curve`) by
//! weighted average, `quat` columns by weighted nlerp (each addend sign-aligned to what has
//! accumulated), `u32` columns (`discrete`, `activation`) take the heaviest entry's word (the
//! first of equals). With blend regions that cross (A's blend out over B's blend in) the weights
//! sum to 1 and the average is the crossfade. Default (dropped) columns are never touched.

use anim_format::clip::{KeyData, TrackKind};
use anim_math::AosQuat;

use crate::window::{Window, MAX_WRAPS, WINDOW_START};
use crate::{ClipBindings, ColumnType};

/// What a playhead does at the ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wrap {
    /// Play to the end and finish.
    Once,
    /// Play to the end, finish and stay there.
    Hold,
    /// Wrap around.
    Loop,
    /// Reverse at each end.
    PingPong,
}

impl Wrap {
    /// From `anim-wire` timeline's `WRAP_*` id (unknown ids read as once).
    pub fn from_id(id: u32) -> Wrap {
        match id {
            1 => Wrap::Hold,
            2 => Wrap::Loop,
            3 => Wrap::PingPong,
            _ => Wrap::Once,
        }
    }
}

/// The most windows one [`advance`] returns.
pub const MAX_LEGS: usize = 4;

/// A playhead: where it is and (pingpong) which way it travels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Playhead {
    /// Seconds into the timeline, in `[0, duration]`.
    pub time: f32,
    /// 1 forward, -1 backward (pingpong's current leg direction; the sign of `delta` flips it).
    pub dir: f32,
}

impl Default for Playhead {
    fn default() -> Self {
        Playhead {
            time: 0.0,
            dir: 1.0,
        }
    }
}

/// The result of [`advance`].
#[derive(Clone, Copy, Debug)]
pub struct Advance {
    /// The windows, in travel order (`count` are valid).
    pub windows: [Window; MAX_LEGS],
    /// How many windows.
    pub count: usize,
    /// Once and hold: the move reached the end of its travel.
    pub finished: bool,
    /// Loop wraps or pingpong turns during the move.
    pub wraps: u32,
}

impl Advance {
    /// The valid windows.
    pub fn windows(&self) -> &[Window] {
        &self.windows[..self.count]
    }
}

fn finite_or_zero(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

/// Moves `head` by `delta` seconds in a timeline of `duration` (see the module docs). `first`
/// marks the first window of a play ([`WINDOW_START`]). A NaN or infinite `delta` counts as 0; a
/// duration that isn't positive (or is NaN) counts as 0, which can't wrap or turn. An infinite
/// duration never ends (once, hold and pingpong run on).
pub fn advance(wrap: Wrap, duration: f32, head: &mut Playhead, delta: f32, first: bool) -> Advance {
    let d = if duration > 0.0 { duration } else { 0.0 };
    let delta = finite_or_zero(delta);
    let flags = if first { WINDOW_START } else { 0 };
    let t0 = if head.time > 0.0 {
        head.time.min(d)
    } else {
        0.0
    };
    let mut out = Advance {
        windows: [Window::new(0.0, 0.0, false); MAX_LEGS],
        count: 0,
        finished: false,
        wraps: 0,
    };
    let single = |head: &mut Playhead, out: &mut Advance, looping: bool| {
        let w = Window::new(t0, delta, looping).with(flags);
        out.windows[0] = w;
        out.count = 1;
        let end = if looping {
            w.end_time(d)
        } else {
            (t0 + delta).clamp(0.0, d)
        };
        head.time = end;
    };
    match wrap {
        Wrap::Loop if d > 0.0 && d.is_finite() => {
            let capped = delta.clamp(-MAX_WRAPS * d, MAX_WRAPS * d);
            let a = t0 - (t0 / d).floor() * d;
            let b = a + capped;
            out.wraps = (b / d).floor().abs() as u32;
            single(head, &mut out, true);
        }
        Wrap::PingPong if d > 0.0 => {
            let mut r = delta.abs();
            if d.is_finite() && r > 2.0 * d {
                r -= (r / (2.0 * d)).floor() * 2.0 * d;
            }
            let reversed = delta < 0.0;
            let mut dir = if reversed { -head.dir } else { head.dir };
            let mut t = t0;
            let mut w_flags = flags;
            while out.count < MAX_LEGS && (r > 0.0 || out.count == 0) {
                let room = if dir > 0.0 { d - t } else { t };
                if r > room {
                    if room > 0.0 {
                        let to = if dir > 0.0 { d } else { 0.0 };
                        out.windows[out.count] = Window::new(t, to - t, false).with(w_flags);
                        out.count += 1;
                        w_flags = 0;
                        r -= room;
                        t = to;
                    }
                    dir = -dir;
                    out.wraps += 1;
                } else {
                    let to = t + dir * r;
                    out.windows[out.count] = Window::new(t, to - t, false).with(w_flags);
                    out.count += 1;
                    t = to.clamp(0.0, d);
                    break;
                }
            }
            if out.count == 0 {
                out.windows[0] = Window::new(t, 0.0, false).with(flags);
                out.count = 1;
            }
            head.time = t;
            head.dir = if reversed { -dir } else { dir };
        }
        _ => {
            single(head, &mut out, false);
            out.finished = (delta > 0.0 && head.time >= d) || (delta < 0.0 && head.time <= 0.0);
            if matches!(wrap, Wrap::Loop | Wrap::PingPong) {
                // A zero-length timeline can't wrap or turn and never finishes.
                out.finished = false;
            }
        }
    }
    out
}

/// A subclip track of a clip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubclipTrack {
    /// The track index.
    pub track: u32,
    /// Its first key (an index into the clip's `KEYS`).
    pub first_key: u32,
    /// Its key count.
    pub key_count: u32,
}

impl ClipBindings {
    /// The clip's `subclip` tracks, in track order.
    pub fn subclip_tracks(&self) -> impl Iterator<Item = SubclipTrack> + '_ {
        self.tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.kind == TrackKind::Subclip)
            .map(|(i, t)| SubclipTrack {
                track: i as u32,
                first_key: t.first_key,
                key_count: t.key_count,
            })
    }

    /// Whether `other` lays out its column block as this clip does: the same columns (track kind,
    /// type, offset, width, default flag) in the same order.
    pub fn same_layout(&self, other: &ClipBindings) -> bool {
        self.column_words() == other.column_words() && self.columns().eq(other.columns())
    }

    /// Whether key `index` is a subclip key.
    pub fn is_subclip_key(&self, index: usize) -> bool {
        self.key(index)
            .is_some_and(|k| matches!(k.data, KeyData::Subclip { .. }))
    }
}

/// Zeroes a block's accumulators before the first [`mix_add`].
pub fn mix_begin(acc: &mut [u32], best: &mut [f32]) {
    acc.fill(0);
    best.fill(0.0);
}

fn is_quat(kind: TrackKind, width: u32) -> bool {
    kind == TrackKind::Quat && width == 4
}

/// Adds one entry's column block `cols` at weight `w` (> 0) to the accumulators `acc` and `best`
/// (both `layout.column_words()` long, aligned to the block's words).
pub fn mix_add(layout: &ClipBindings, acc: &mut [u32], best: &mut [f32], cols: &[u32], w: f32) {
    if w.is_nan()
        || w <= 0.0
        || cols.len() < layout.column_words()
        || acc.len() < cols.len().min(layout.column_words())
    {
        return;
    }
    for c in layout.columns() {
        if c.default {
            continue;
        }
        let at = c.offset as usize;
        let n = c.width as usize;
        match c.ty {
            ColumnType::U32 => {
                if w > best[at] {
                    best[at] = w;
                    acc[at] = cols[at];
                }
            }
            ColumnType::F32 if is_quat(c.kind, c.width) => {
                let q = |s: &[u32]| {
                    AosQuat::new(
                        f32::from_bits(s[at]),
                        f32::from_bits(s[at + 1]),
                        f32::from_bits(s[at + 2]),
                        f32::from_bits(s[at + 3]),
                    )
                };
                let cur = q(acc);
                let mut add = q(cols);
                if cur.dot(add) < 0.0 {
                    add = -add;
                }
                let r = cur + add.scale(w);
                acc[at..at + 4].copy_from_slice(&[
                    r.x.to_bits(),
                    r.y.to_bits(),
                    r.z.to_bits(),
                    r.w.to_bits(),
                ]);
            }
            ColumnType::F32 => {
                for i in at..at + n {
                    acc[i] = (f32::from_bits(acc[i]) + f32::from_bits(cols[i]) * w).to_bits();
                }
            }
        }
    }
}

/// Writes the mix of the entries added so far (total weight `total`, > 0) into `out`
/// (`layout.column_words()` long): see the module docs. Default columns are left as they are.
pub fn mix_resolve(layout: &ClipBindings, acc: &[u32], total: f32, out: &mut [u32]) {
    if total.is_nan()
        || total <= 0.0
        || out.len() < layout.column_words()
        || acc.len() < layout.column_words()
    {
        return;
    }
    for c in layout.columns() {
        if c.default {
            continue;
        }
        let at = c.offset as usize;
        let n = c.width as usize;
        match c.ty {
            ColumnType::U32 => out[at] = acc[at],
            ColumnType::F32 if is_quat(c.kind, c.width) => {
                let r = AosQuat::new(
                    f32::from_bits(acc[at]),
                    f32::from_bits(acc[at + 1]),
                    f32::from_bits(acc[at + 2]),
                    f32::from_bits(acc[at + 3]),
                )
                .normalize_or_identity();
                out[at..at + 4].copy_from_slice(&[
                    r.x.to_bits(),
                    r.y.to_bits(),
                    r.z.to_bits(),
                    r.w.to_bits(),
                ]);
            }
            ColumnType::F32 => {
                for i in at..at + n {
                    out[i] = (f32::from_bits(acc[i]) / total).to_bits();
                }
            }
        }
    }
}
