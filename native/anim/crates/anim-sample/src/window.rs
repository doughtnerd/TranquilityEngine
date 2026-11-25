//! Track kinds over a time window (ADR 0371, 0372): what one playing clip did between the last
//! evaluation and this one.
//!
//! # The window
//!
//! A [`Window`] is the playhead's move this frame: the clip time it started from, the signed
//! distance it travelled (`speed × dt`; negative plays in reverse), whether the playing clip loops
//! (the clip player's setting, which may differ from the clip's header), and flags:
//!
//! - [`WINDOW_START`]: the first window of a play. The start point is included, so keys at the
//!   start time fire, and nothing counts as already active.
//! - [`WINDOW_SEEK`]: a jump, not playback. No crossed key fires (notifies, markers, audio,
//!   control) and no notify state begins or ticks; notify states the new position leaves still
//!   end (scripts always see `end` after `begin`), and levels (`discrete`, `activation`, subclip
//!   states) follow the new position.
//!
//! **Resolving.** With `d` the clip's duration: a looping window starts at `from` wrapped into
//! `[0, d)` and ends at `a + delta` *unwrapped* (so it may run past `d` or below 0 and cross the
//! loop point, several times), with `|delta|` capped at [`MAX_WRAPS`]` · d`; a non-looping window
//! clamps both ends to `[0, d]`. A clip with no duration never loops. NaN or infinite inputs read
//! as 0.
//!
//! **Which keys a window crosses (the inclusivity rule).** Playing forward from `a` to `b`, a key
//! at time `t` (and, looping, at every `t + k·d`) is crossed when `a < t ≤ b`: the end is
//! inclusive, the start exclusive, so consecutive windows cross each key exactly once and a
//! key exactly at the frame's time fires on that frame. In reverse the rule mirrors (`b ≤ t < a`).
//! [`WINDOW_START`] makes the start inclusive. A zero-length window crosses nothing (with
//! `WINDOW_START`, the keys exactly at its time). A key at `d` and a key at 0 of a looping clip
//! are both crossed when the window passes the loop point.
//!
//! **Ranges** (`activation` ranges, subclip entries, notify states) cover `[time, end)`. In a
//! non-looping clip, an `activation` range or subclip entry that ends at `d` also covers `d`, so
//! a clip held at its end keeps them (notify states still end there).
//!
//! # What a window produces
//!
//! [`BoundClip::evaluate`](crate::BoundClip::evaluate) writes the clip's column block at the
//! window's end time (value tracks sampled from the resampled data, the decision-log's D1;
//! `discrete` the payload of the last key at or before it, or the first key before any;
//! `activation` 0/1) and pushes [`TrackRecord`]s into a [`TrackSink`], in this order:
//!
//! 1. crossed instant keys, in travel order (time, then track, then key; reversed in reverse
//!    playback): notifies ([`TrackRecord::Event`]), markers, audio and control keys;
//! 2. notify states, in key order: `begin`, `tick` and `end` ([`TrackRecord::NotifyState`]);
//! 3. activation edges, where the level at the window's end differs from its start;
//! 4. subclip states, per active entry ([`TrackRecord::Subclip`]).
//!
//! **Weight gating (ADR 0372).** The caller passes the clip's effective weight. A notify fires
//! when its key says `always`, or when the weight exceeds the key's threshold (`weight >
//! threshold`; the compiler's default threshold is 0.5). A notify state begins only while that
//! holds and ends as soon as it stops holding, or when the playhead leaves the state, whichever
//! comes first; while it holds and the playhead stays inside, each window ticks it once. A state
//! entered and left within one window gets `begin` then `end`. Audio and control keys carry no
//! threshold: they fire at any weight above 0 and carry the weight (a consumer may scale by it).
//! Markers are timing, not events: they're reported whatever the weight.
//!
//! **Notify-state memory.** Which states are open lives in caller memory, one bit per state
//! ([`ClipBindings::notify_words`](crate::ClipBindings::notify_words) words per playing clip),
//! zeroed when the play starts. When a play stops or is interrupted,
//! [`ClipBindings::end_notify_states`](crate::ClipBindings::end_notify_states) ends every open
//! state.
//!
//! Nothing here allocates.

use anim_format::clip::{ControlKind, KeyData, MarkerKind, TrackKind};
use anim_pose::sync::{SyncClip, SyncPhase};

use crate::bind::{BoundClip, ClipBindings};
use crate::TrackSample;

/// [`Window::flags`]: a jump; crossed keys don't fire (see the module docs).
pub const WINDOW_SEEK: u32 = 1;
/// [`Window::flags`]: the first window of a play; the start point is included.
pub const WINDOW_START: u32 = 2;

/// The most loop cycles one window spans: `|delta|` is capped at this many durations.
pub const MAX_WRAPS: f32 = 4.0;

/// [`TrackRecord::Subclip`] flag: the entry became active in this window.
pub const SUBCLIP_ENTERED: u32 = 1;
/// [`TrackRecord::Subclip`] flag: the entry stopped being active in this window (the record's
/// local time is where it left).
pub const SUBCLIP_EXITED: u32 = 2;

/// A playhead move (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Window {
    /// Clip time at the previous evaluation, seconds.
    pub from: f32,
    /// Signed travel this frame, seconds (`speed × dt`).
    pub delta: f32,
    /// Whether the playing clip loops.
    pub looping: bool,
    /// [`WINDOW_SEEK`], [`WINDOW_START`].
    pub flags: u32,
}

impl Window {
    /// A window of plain playback (no flags).
    pub fn new(from: f32, delta: f32, looping: bool) -> Self {
        Window {
            from,
            delta,
            looping,
            flags: 0,
        }
    }

    /// The same window with `flags` added.
    pub fn with(self, flags: u32) -> Self {
        Window {
            flags: self.flags | flags,
            ..self
        }
    }

    /// The clip time at the window's end, in a clip of `duration` seconds (wrapped into
    /// `[0, duration)` when looping, else clamped to `[0, duration]`): the next window's `from`.
    pub fn end_time(&self, duration: f32) -> f32 {
        Span::new(self, duration).now
    }
}

/// A notify state's phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifyPhase {
    /// The state started (the playhead entered it, or the weight rose above its threshold).
    Begin = 0,
    /// The state continues (once per window).
    Tick = 1,
    /// The state stopped (the playhead left it, the weight fell, or the play ended).
    End = 2,
}

/// One output record of a window. `track` is the track index, `key` the key's index in the
/// clip's `KEYS` section, times are clip times in seconds, and `weight` the clip weight the
/// caller passed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TrackRecord {
    /// A notify crossed.
    Event {
        track: u32,
        key: u32,
        /// Method name string id.
        method: u32,
        /// Args JSON string id, or `NONE`.
        args: u32,
        /// The key's time.
        time: f32,
        weight: f32,
    },
    /// A notify state's begin, tick or end.
    NotifyState {
        track: u32,
        key: u32,
        method: u32,
        args: u32,
        phase: NotifyPhase,
        /// Where it happened: the entry or exit point, or the window's end for a tick and for
        /// changes of weight.
        time: f32,
        /// The state's start time.
        start: f32,
        /// The state's duration (`end - start`).
        duration: f32,
        weight: f32,
    },
    /// An `activation` track's level changed.
    Activation {
        track: u32,
        active: bool,
        /// The window's end time.
        time: f32,
    },
    /// A control key crossed.
    Control {
        track: u32,
        key: u32,
        kind: ControlKind,
        /// Target string id, or `NONE`.
        target: u32,
        /// Payload JSON string id, or `NONE`.
        payload: u32,
        time: f32,
        /// `end - time`.
        duration: f32,
        weight: f32,
    },
    /// An audio key crossed.
    Audio {
        track: u32,
        key: u32,
        /// Audio asset string id.
        asset: u32,
        /// Params JSON string id, or `NONE`.
        params: u32,
        time: f32,
        /// `end - time`.
        duration: f32,
        weight: f32,
    },
    /// A marker crossed.
    Marker {
        track: u32,
        key: u32,
        kind: MarkerKind,
        /// Name string id, or `NONE`.
        name: u32,
        time: f32,
    },
    /// A subclip entry active during the window.
    Subclip {
        track: u32,
        key: u32,
        /// The nested clip's asset string id.
        clip: u32,
        /// [`SUBCLIP_ENTERED`], [`SUBCLIP_EXITED`].
        flags: u32,
        /// The nested clip's time at the window's end (or where the entry was left):
        /// `offset + (t - start) · speed`.
        local_time: f32,
        /// The nested clip's travel within the window (`local_time - local_delta` is where it
        /// started: the entry point when entered), the nested window's `delta`.
        local_delta: f32,
        /// The blend weight at `local_time`: blend in and blend out ramps, the smaller.
        weight: f32,
    },
}

/// Where window records go. Implemented for every `FnMut(TrackRecord)`.
pub trait TrackSink {
    /// Takes one record.
    fn push(&mut self, record: TrackRecord);
}

impl<F: FnMut(TrackRecord) + ?Sized> TrackSink for F {
    fn push(&mut self, record: TrackRecord) {
        self(record)
    }
}

/// A window resolved against a duration.
#[derive(Clone, Copy, Debug)]
struct Span {
    /// Start and end, unwrapped (looping) or clamped.
    a: f32,
    b: f32,
    d: f32,
    looping: bool,
    start: bool,
    seek: bool,
    /// The end time folded into the clip.
    now: f32,
}

fn finite(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

impl Span {
    fn new(w: &Window, duration: f32) -> Span {
        let d = if duration.is_finite() && duration > 0.0 {
            duration
        } else {
            0.0
        };
        let looping = w.looping && d > 0.0;
        let from = finite(w.from);
        let delta = finite(w.delta);
        let fold = SyncClip {
            markers: &[],
            duration: d,
            looping,
        };
        let (a, b, now) = if looping {
            let a = fold.wrap_time(from);
            let cap = MAX_WRAPS * d;
            let delta = delta.clamp(-cap, cap);
            let b = a + delta;
            (a, b, fold.wrap_time(b))
        } else {
            let a = from.clamp(0.0, d);
            let b = (from + delta).clamp(0.0, d);
            (a, b, b)
        };
        Span {
            a,
            b,
            d,
            looping,
            start: w.flags & WINDOW_START != 0,
            seek: w.flags & WINDOW_SEEK != 0,
            now,
        }
    }

    fn forward(&self) -> bool {
        self.b >= self.a
    }

    /// The loop cycles `k` whose shifted keys (`t + k·d`, `t` in `[0, d]`) can meet the window,
    /// in travel order.
    fn cycles(&self) -> Cycles {
        if !self.looping {
            return Cycles {
                next: 0,
                last: 0,
                step: 1,
                done: false,
            };
        }
        let lo = (self.a.min(self.b) / self.d).floor() as i32 - 1;
        let hi = (self.a.max(self.b) / self.d).floor() as i32;
        if self.forward() {
            Cycles {
                next: lo,
                last: hi,
                step: 1,
                done: false,
            }
        } else {
            Cycles {
                next: hi,
                last: lo,
                step: -1,
                done: false,
            }
        }
    }

    fn shift(&self, k: i32) -> f32 {
        k as f32 * self.d
    }

    /// Whether an instant at unwrapped time `t` is crossed.
    /// Whether key time `key` (in `[0, d]`), shifted into cycle position `key + shift`, is crossed.
    ///
    /// The start point of a [`WINDOW_START`] window is included, except for the loop seam's
    /// other side: a looping play starting at 0 doesn't fire the key at `d` as if a previous cycle
    /// had just ended (nor, playing backward from the end, the key at 0).
    fn crosses(&self, key: f32, shift: f32) -> bool {
        let (a, b) = (self.a, self.b);
        let t = key + shift;
        if self.forward() {
            let seam = self.looping && key == self.d && self.d > 0.0;
            (a < t || (self.start && a == t && !seam)) && t <= b
        } else {
            let seam = self.looping && key == 0.0 && self.d > 0.0;
            b <= t && (t < a || (self.start && t == a && !seam))
        }
    }

    /// Whether `[s, e)` (unwrapped) lies inside the swept window.
    fn contains(&self, s: f32, e: f32) -> bool {
        let (a, b) = (self.a, self.b);
        if self.forward() {
            (a < s || (self.start && a == s)) && e <= b
        } else {
            b <= s && e <= a
        }
    }

    /// Time `t` of cycle `k`, folded back into the clip.
    fn fold(&self, t: f32, k: i32) -> f32 {
        if self.looping {
            t - self.shift(k)
        } else {
            t
        }
    }
}

/// Loop cycles in travel order.
struct Cycles {
    next: i32,
    last: i32,
    step: i32,
    done: bool,
}

impl Iterator for Cycles {
    type Item = i32;
    fn next(&mut self) -> Option<i32> {
        if self.done {
            return None;
        }
        let k = self.next;
        if k == self.last {
            self.done = true;
        } else {
            self.next += self.step;
        }
        Some(k)
    }
}

/// Whether `p` lies in `[s, e)`, or at `e` when `hold` and `e` is the clip's end.
fn inside(p: f32, s: f32, e: f32, hold_end: Option<f32>) -> bool {
    (s <= p && p < e) || hold_end.is_some_and(|d| p == e && e == d)
}

fn bit(words: &[u32], i: usize) -> bool {
    words.get(i / 32).is_some_and(|w| w & (1 << (i % 32)) != 0)
}

fn set_bit(words: &mut [u32], i: usize, on: bool) {
    if let Some(w) = words.get_mut(i / 32) {
        if on {
            *w |= 1 << (i % 32);
        } else {
            *w &= !(1 << (i % 32));
        }
    }
}

impl ClipBindings {
    /// Pushes the window's crossed instant keys (notifies, markers, audio, control) in travel
    /// order, gated by `weight` (see the module docs). Nothing on a seek.
    pub fn crossings(&self, window: &Window, weight: f32, sink: &mut (impl TrackSink + ?Sized)) {
        let sp = Span::new(window, self.duration);
        self.cross(&sp, weight, sink);
    }

    fn cross(&self, sp: &Span, weight: f32, sink: &mut (impl TrackSink + ?Sized)) {
        if sp.seek || self.crossings.is_empty() {
            return;
        }
        let (lo, hi) = (sp.a.min(sp.b), sp.a.max(sp.b));
        for k in sp.cycles() {
            let shift = sp.shift(k);
            // `t + shift` is monotonic in `t`, so these bounds agree with `crosses` below.
            let first = self.crossings.partition_point(|c| c.time + shift < lo);
            let end = self.crossings.partition_point(|c| c.time + shift <= hi);
            let range = first..end.max(first);
            let mut emit = |i: usize| {
                let c = self.crossings[i];
                if sp.crosses(c.time, shift) {
                    self.emit_cross(c.track, c.key, weight, sink);
                }
            };
            if sp.forward() {
                range.for_each(&mut emit);
            } else {
                range.rev().for_each(&mut emit);
            }
        }
    }

    fn emit_cross(&self, track: u32, key: u32, weight: f32, sink: &mut (impl TrackSink + ?Sized)) {
        let Some(k) = self.keys.get(key as usize) else {
            return;
        };
        let (time, duration) = (k.time, k.end - k.time);
        match k.data {
            KeyData::Event {
                method,
                args,
                threshold,
                always,
            } if always || weight > threshold => sink.push(TrackRecord::Event {
                track,
                key,
                method,
                args,
                time,
                weight,
            }),
            KeyData::Marker { kind, name } => sink.push(TrackRecord::Marker {
                track,
                key,
                kind,
                name,
                time,
            }),
            KeyData::Audio { asset, params } if weight > 0.0 => sink.push(TrackRecord::Audio {
                track,
                key,
                asset,
                params,
                time,
                duration,
                weight,
            }),
            KeyData::Control {
                kind,
                target,
                payload,
            } if weight > 0.0 => sink.push(TrackRecord::Control {
                track,
                key,
                kind,
                target,
                payload,
                time,
                duration,
                weight,
            }),
            _ => {}
        }
    }

    /// Advances the notify states over the window: pushes their `begin`, `tick` and `end`
    /// records and updates `open` (at least [`notify_words`](Self::notify_words) words; one bit
    /// per state, zeroed when the play starts). See the module docs for the rules.
    pub fn notify_states(
        &self,
        window: &Window,
        weight: f32,
        open: &mut [u32],
        sink: &mut (impl TrackSink + ?Sized),
    ) {
        let sp = Span::new(window, self.duration);
        self.states_in(&sp, weight, open, sink);
    }

    fn states_in(
        &self,
        sp: &Span,
        weight: f32,
        open: &mut [u32],
        sink: &mut (impl TrackSink + ?Sized),
    ) {
        for (si, st) in self.states.iter().enumerate() {
            let Some(k) = self.keys.get(st.key as usize) else {
                continue;
            };
            let KeyData::Event {
                method,
                args,
                threshold,
                always,
            } = k.data
            else {
                continue;
            };
            let (ts, te) = (k.time, k.end);
            let gate = always || weight > threshold;
            let mut is_open = bit(open, si);
            let mut emit = |phase: NotifyPhase, time: f32| {
                sink.push(TrackRecord::NotifyState {
                    track: st.track,
                    key: st.key,
                    method,
                    args,
                    phase,
                    time,
                    start: ts,
                    duration: te - ts,
                    weight,
                })
            };
            if !gate || sp.seek {
                if is_open && (!gate || !inside(sp.now, ts, te, None)) {
                    emit(NotifyPhase::End, sp.now);
                    is_open = false;
                }
                set_bit(open, si, is_open);
                continue;
            }
            let mut visited = false;
            for c in sp.cycles() {
                let shift = sp.shift(c);
                let (s, e) = (ts + shift, te + shift);
                let was_in = inside(sp.a, s, e, None);
                let now_in = inside(sp.b, s, e, None);
                if !(was_in || now_in || sp.contains(s, e)) {
                    continue;
                }
                visited = true;
                let exit = sp.fold(if sp.forward() { e } else { s }, c);
                if is_open && was_in && !sp.start {
                    if now_in {
                        emit(NotifyPhase::Tick, sp.now);
                    } else {
                        emit(NotifyPhase::End, exit);
                        is_open = false;
                    }
                    continue;
                }
                if is_open {
                    // Opened at a position this window doesn't continue from.
                    emit(NotifyPhase::End, sp.a);
                }
                let entry = if was_in {
                    sp.fold(sp.a, c)
                } else {
                    sp.fold(if sp.forward() { s } else { e }, c)
                };
                emit(NotifyPhase::Begin, entry);
                if now_in {
                    is_open = true;
                } else {
                    emit(NotifyPhase::End, exit);
                    is_open = false;
                }
            }
            if !visited && is_open {
                if inside(sp.now, ts, te, None) {
                    emit(NotifyPhase::Tick, sp.now);
                } else {
                    emit(NotifyPhase::End, sp.now);
                    is_open = false;
                }
            }
            set_bit(open, si, is_open);
        }
    }

    /// Ends every open notify state (a play stopped or was interrupted): pushes their `end`
    /// records at clip time `time` and clears `open`.
    pub fn end_notify_states(
        &self,
        time: f32,
        weight: f32,
        open: &mut [u32],
        sink: &mut (impl TrackSink + ?Sized),
    ) {
        for (si, st) in self.states.iter().enumerate() {
            if !bit(open, si) {
                continue;
            }
            set_bit(open, si, false);
            let Some(k) = self.keys.get(st.key as usize) else {
                continue;
            };
            if let KeyData::Event { method, args, .. } = k.data {
                sink.push(TrackRecord::NotifyState {
                    track: st.track,
                    key: st.key,
                    method,
                    args,
                    phase: NotifyPhase::End,
                    time,
                    start: k.time,
                    duration: k.end - k.time,
                    weight,
                });
            }
        }
    }

    /// Whether `activation` track `track` is active at clip time `t` (`hold`: a non-looping play,
    /// whose ranges ending at the clip's end cover it).
    pub fn active_at(&self, track: usize, t: f32, hold: bool) -> bool {
        let Some(tb) = self.tracks.get(track) else {
            return false;
        };
        if tb.kind != TrackKind::Activation {
            return false;
        }
        let hold_end = hold.then_some(self.duration);
        let keys = self.track_keys(tb.first_key, tb.key_count);
        for k in keys {
            if k.time > t {
                break;
            }
            if inside(t, k.time, k.end, hold_end) {
                return true;
            }
        }
        false
    }

    /// `discrete` track `track`'s payload at clip time `t`: the last key at or before `t`, or the
    /// first key before any; `None` without keys.
    pub fn discrete_at(&self, track: usize, t: f32) -> Option<u32> {
        let tb = self.tracks.get(track)?;
        if tb.kind != TrackKind::Discrete {
            return None;
        }
        let keys = self.track_keys(tb.first_key, tb.key_count);
        let i = keys.partition_point(|k| k.time <= t).saturating_sub(1);
        match keys.get(i)?.data {
            KeyData::Discrete { value } => Some(value),
            _ => None,
        }
    }

    fn track_keys(&self, first: u32, count: u32) -> &[anim_format::clip::Key] {
        let (f, n) = (first as usize, count as usize);
        self.keys.get(f..f + n).unwrap_or(&[])
    }

    /// Pushes an [`Activation`](TrackRecord::Activation) record for every `activation` track
    /// whose level at the window's end differs from its start (with [`WINDOW_START`], from off).
    pub fn activation_edges(&self, window: &Window, sink: &mut (impl TrackSink + ?Sized)) {
        let sp = Span::new(window, self.duration);
        self.edges(&sp, sink);
    }

    fn edges(&self, sp: &Span, sink: &mut (impl TrackSink + ?Sized)) {
        let hold = !sp.looping;
        let from = sp.fold(sp.a, 0);
        for &ti in &self.activation_tracks {
            let ti = ti as usize;
            let was = !sp.start && self.active_at(ti, from, hold);
            let now = self.active_at(ti, sp.now, hold);
            if was != now {
                sink.push(TrackRecord::Activation {
                    track: ti as u32,
                    active: now,
                    time: sp.now,
                });
            }
        }
    }

    /// Pushes a [`Subclip`](TrackRecord::Subclip) record for every subclip entry active during
    /// the window (entered, continuing, or left), per track in travel order.
    pub fn subclips(&self, window: &Window, sink: &mut (impl TrackSink + ?Sized)) {
        let sp = Span::new(window, self.duration);
        self.subclips_in(&sp, sink);
    }

    fn subclips_in(&self, sp: &Span, sink: &mut (impl TrackSink + ?Sized)) {
        let hold_end = (!sp.looping).then_some(sp.d);
        for &ti in &self.subclip_tracks {
            let ti = ti as usize;
            let tb = &self.tracks[ti];
            for c in sp.cycles() {
                let shift = sp.shift(c);
                let n = tb.key_count as usize;
                for j in 0..n {
                    let j = if sp.forward() { j } else { n - 1 - j };
                    let ki = tb.first_key as usize + j;
                    let Some(k) = self.keys.get(ki) else { continue };
                    let KeyData::Subclip {
                        clip,
                        offset,
                        speed,
                        blend_in,
                        blend_out,
                    } = k.data
                    else {
                        continue;
                    };
                    if k.end <= k.time {
                        continue;
                    }
                    let (s, e) = (k.time + shift, k.end + shift);
                    let was_in = inside(sp.a, s, e, hold_end);
                    let now_in = inside(sp.b, s, e, hold_end);
                    if !(was_in || now_in || sp.contains(s, e)) {
                        continue;
                    }
                    let len = k.end - k.time;
                    let rel = |p: f32| (p - s).clamp(0.0, len);
                    let (ra, rb) = (rel(sp.a), rel(sp.b));
                    let mut flags = 0;
                    if !was_in || sp.start {
                        flags |= SUBCLIP_ENTERED;
                    }
                    if !now_in {
                        flags |= SUBCLIP_EXITED;
                    }
                    // Entered: start from the entry point (the window's start when the play
                    // starts inside the entry).
                    let ra = if was_in {
                        ra
                    } else if sp.forward() {
                        0.0
                    } else {
                        len
                    };
                    let local_from = offset + ra * speed;
                    let local_time = offset + rb * speed;
                    let ramp_in = if blend_in > 0.0 {
                        (rb / blend_in).min(1.0)
                    } else {
                        1.0
                    };
                    let ramp_out = if blend_out > 0.0 {
                        ((len - rb) / blend_out).min(1.0)
                    } else {
                        1.0
                    };
                    sink.push(TrackRecord::Subclip {
                        track: ti as u32,
                        key: ki as u32,
                        clip,
                        flags,
                        local_time,
                        local_delta: local_time - local_from,
                        weight: ramp_in.min(ramp_out).max(0.0),
                    });
                }
            }
        }
    }

    /// The clip's sync phase at clip time `t` over its sync markers (`anim_pose::sync`).
    pub fn sync_phase(&self, t: f32, looping: bool) -> SyncPhase {
        SyncClip {
            markers: self.sync_markers(),
            duration: self.duration,
            looping,
        }
        .phase_at(t)
    }
}

impl BoundClip<'_, '_> {
    /// Writes the column block (at least [`ClipBindings::column_words`] words) at clip time `t`:
    /// value tracks as f32 bits, `discrete` payloads, `activation` levels (`hold`: a non-looping
    /// play). Default channels and keyless `discrete` tracks are left as the caller filled them.
    /// Returns `false` (writing nothing) when `columns` is too short.
    pub fn sample_columns(&self, t: f32, hold: bool, columns: &mut [u32]) -> bool {
        let b = self.bindings;
        if columns.len() < b.column_words() {
            return false;
        }
        for &ti in &b.column_tracks {
            let ti = ti as usize;
            let tb = &b.tracks[ti];
            let at = tb.column as usize;
            match tb.kind {
                TrackKind::Discrete => {
                    if let Some(v) = b.discrete_at(ti, t) {
                        columns[at] = v;
                    }
                }
                TrackKind::Activation => columns[at] = b.active_at(ti, t, hold) as u32,
                _ => {
                    let mut v = [0.0f32; 4];
                    if self.sample_track(ti, t, &mut v) == TrackSample::Written {
                        let w = tb.width as usize;
                        for (o, x) in columns[at..at + w].iter_mut().zip(v) {
                            *o = x.to_bits();
                        }
                    }
                }
            }
        }
        true
    }

    /// Evaluates every track kind over `window` at clip weight `weight`: writes the column block
    /// at the window's end ([`sample_columns`](Self::sample_columns); skipped when `columns` is
    /// too short) and pushes the window's records in the documented order, updating `open`
    /// (the notify-state bits). Returns the window's end time (the next window's `from`).
    pub fn evaluate(
        &self,
        window: &Window,
        weight: f32,
        open: &mut [u32],
        columns: &mut [u32],
        sink: &mut (impl TrackSink + ?Sized),
    ) -> f32 {
        let b = self.bindings;
        let sp = Span::new(window, b.duration);
        self.sample_columns(sp.now, !sp.looping, columns);
        b.cross(&sp, weight, sink);
        b.states_in(&sp, weight, open, sink);
        b.edges(&sp, sink);
        b.subclips_in(&sp, sink);
        sp.now
    }
}
