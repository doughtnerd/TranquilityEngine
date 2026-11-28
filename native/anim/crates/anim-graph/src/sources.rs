//! Node family `sources`: clip players, blend spaces 1D and 2D (triangulated, `follow.glideMs`, root speed), pose snapshot, reference and bind pose.
//!
//! T13r filled the clip player; T31 adds the rest. Declare the family's kinds in [`kind`]
//! (append-only `u16`s, stored in `myco.animgraph@1`) and match on them in [`evaluate`].
//!
//! # `CLIP_PLAYER` (kind 0)
//!
//! Plays one clip: no inputs.
//!
//! Parameter words:
//!
//! | word | type | meaning |
//! |---|---|---|
//! | 0 | u32 | the clip: a string id of the graph (resolved through the graph's bindings), or `NONE` (set at runtime, as the implicit graph's players are) |
//! | 1 | f32 | speed (1 when absent or not finite) |
//! | 2 | u32 | flags: [`PLAYER_LOOP_SET`] (1) overrides the clip's own loop flag with [`PLAYER_LOOP`] (2) |
//! | 3 | f32 | start time, seconds |
//! | 4 | u32 | layer index reported in state events (`NONE` when absent) |
//!
//! State words ([`player`] has the offsets): clip handle, time, previous time, speed, flags, play
//! id, wraps in the last update, layer, the last update's travel, the play's notify-state bits
//! ([`player::OPEN_WORDS`] words: up to 256 notify states per clip), and a pending end (the
//! replaced clip, its time and its open bits, ended at the next Tracks phase).
//!
//! In the Tracks phase the player reports its window (from the previous playhead by the last
//! travel, looping as it plays, flagged as the play's first window after a start) at its
//! effective weight, after ending a replaced play's open notify states. Looping clips wrap; others clamp and report
//! [`StateEventKind::Finished`] once when they reach their end (only plays the host gave an id).
//! In the Weights phase it registers itself ([`EvalContext::collect_player`]); its timing is its
//! own playhead.
//!
//! The pose is the clip sampled at the playhead (over identity for additive clips), with the
//! root bone's ground-plane translation and yaw baked out when the instance asks
//! ([`EvalContext::bake_root`]). The root delta comes from the clip's root curve (translation
//! and yaw, ADR 0370's prediction curve) between the previous and current playhead, across a loop
//! seam when it wrapped; a clip without a root curve has no root motion.
//!
//! The player's state functions ([`start_play`], [`interrupt`], [`clear`]) work on any slice laid
//! out as [`player`], so slots embed players in their own state.
//!
//! # `BLEND_SPACE_1D` (kind 1) and `BLEND_SPACE_2D` (kind 2)
//!
//! Inputs: the samples (any sources, usually clip players), which the blend space gates: only
//! samples with weight advance, at the blend space's rate. Words:
//!
//! | word | type | meaning |
//! |---|---|---|
//! | 0 | u32 | the x parameter (float) |
//! | 1 | u32 | the y parameter (float; 2D), or `NONE` |
//! | 2 | u32 | the speed parameter (float, units per second), or `NONE` |
//! | 3 | f32 | `follow.glideMs`: a change of the inputs glides linearly to the new value over this many milliseconds (0: none) |
//! | 4 | u32 | flags: [`BS_SYNC`] (followers follow the heaviest sample's sync-marker phase), [`BS_SPEED`] (playback rate = speed parameter ÷ the samples' blended root speed) |
//! | 5, 6 | f32 | the rate's clamp, min and max (0: 0.25 and 4) |
//! | 7… | f32 | the samples' coordinates: one per input (1D), or x, y per input (2D) |
//!
//! 1D weights are piecewise linear between the two neighbouring coordinates (clamped at the
//! ends). 2D weights use [`triangulate`] (audio Blend's rule): the Delaunay triangulation is
//! built once at load (`NodeData::aux`), a point inside gets barycentric weights, a point outside
//! is projected onto the nearest hull edge. A sample's root speed is its timing clip's root-curve
//! ground distance over its duration. State: flags, the glide (from, to, elapsed), the smoothed
//! point, the rate, the leader, then one weight per input. Root motion is the weighted blend of
//! the samples' (already scaled by the rate, since they advance at it).
//!
//! # `POSE_SNAPSHOT` (kind 3)
//!
//! A frozen pose (ragdoll get-up, ADR 0372). Words: 0 `u32` mode: 0 captures the instance's last
//! output when the node is initialised (on entering its state), 1 only by the `graph` family's
//! `CAPTURE_POSE` command ([`capture`]). Before a capture it outputs nothing (alpha 0). State: a
//! valid flag, then the pose (`SOA_WORDS` per group).
//!
//! # `REFERENCE_POSE` (kind 4) and `BIND_POSE` (kind 5)
//!
//! The skeleton's rest (reference) pose (word 0 = 1: the identity pose, an additive's zero), and
//! its bind pose (the inverse bind matrices' pose; the rest pose when the host has none).

pub mod triangulate;

use anim_format::NONE;
use anim_math::trig::sin_cos;
use anim_math::{AosQuat, AosVec3, Lane, SoaTransform};
use anim_pose::root::{RootDelta, RootMotionAxes};
use anim_pose::sync::{SyncClip, SyncPhase};
use anim_pose::Axis;
use anim_sample::{Window, WINDOW_START};

use crate::dispatch::NodeStatus;
use crate::eval::{
    pose_from_words, pose_to_words, ClipRef, EvalContext, NodeData, Phase, StateEvent,
    StateEventKind, Timing, SOA_WORDS,
};
use crate::mixing::{self, MAX_BLEND_INPUTS};

/// The family's node kinds.
pub mod kind {
    /// Plays one clip (module docs).
    pub const CLIP_PLAYER: u16 = 0;
    /// A 1D blend space.
    pub const BLEND_SPACE_1D: u16 = 1;
    /// A 2D blend space (Delaunay).
    pub const BLEND_SPACE_2D: u16 = 2;
    /// A frozen pose.
    pub const POSE_SNAPSHOT: u16 = 3;
    /// The rest (reference) pose.
    pub const REFERENCE_POSE: u16 = 4;
    /// The bind pose.
    pub const BIND_POSE: u16 = 5;
}

/// [`kind::CLIP_PLAYER`] flag: the player's own loop setting overrides the clip's.
pub const PLAYER_LOOP_SET: u32 = 1;
/// [`kind::CLIP_PLAYER`] flag: loop (with [`PLAYER_LOOP_SET`]).
pub const PLAYER_LOOP: u32 = 2;
/// State flag: the play reached its end.
const PLAYER_FINISHED: u32 = 4;

/// Blend-space flag: followers follow the heaviest sample's phase.
pub const BS_SYNC: u32 = 1;
/// Blend-space flag: the rate follows the speed parameter over the blended root speed.
pub const BS_SPEED: u32 = 2;

/// A clip player's state words.
pub mod player {
    /// Words of state.
    pub const WORDS: u32 = 28;
    /// Words of notify-state bits per play.
    pub const OPEN_WORDS: usize = 8;
    /// The clip's asset handle (0: none).
    pub const CLIP: usize = 0;
    /// The playhead, seconds (f32 bits).
    pub const TIME: usize = 1;
    /// The playhead before the last update.
    pub const PREV_TIME: usize = 2;
    /// Speed (f32 bits).
    pub const SPEED: usize = 3;
    /// `PLAYER_LOOP_SET | PLAYER_LOOP` and the finished bit.
    pub const FLAGS: usize = 4;
    /// The host's id for the play (0: none; no events).
    pub const PLAY_ID: usize = 5;
    /// Loop wraps in the last update (i32: negative when playing backwards).
    pub const WRAPS: usize = 6;
    /// The layer reported in events.
    pub const LAYER: usize = 7;
    /// The last update's travel, `speed × dt` (f32 bits).
    pub const DELTA: usize = 8;
    /// The play's notify-state bits.
    pub const OPEN: usize = 9;
    /// A replaced play's clip whose notify states still need ending (0: none).
    pub const ENDED_CLIP: usize = 17;
    /// Its clip time (f32 bits).
    pub const ENDED_TIME: usize = 18;
    /// Its open bits.
    pub const ENDED_OPEN: usize = 19;
}

/// State flag: the next window is the play's first.
const PLAYER_STARTED: u32 = 8;

/// The parameter words of a clip player (for compilers and the implicit graph).
pub fn clip_player_params(clip: u32, speed: f32, flags: u32, start: f32, layer: u32) -> [u32; 5] {
    [clip, speed.to_bits(), flags, start.to_bits(), layer]
}

/// Starts a play on a clip player's state: `clip` from `start` seconds at `speed`, with `flags`
/// ([`PLAYER_LOOP_SET`], [`PLAYER_LOOP`]) and the host's `play_id`. Returns the id of the play it
/// replaced if that play hadn't finished (the host reports it interrupted), else 0.
pub fn start_play(
    state: &mut [u32],
    clip: u32,
    start: f32,
    speed: f32,
    flags: u32,
    play_id: u32,
) -> u32 {
    let replaced = interrupt(state);
    retire(state);
    state[player::CLIP] = clip;
    let start = if start.is_finite() { start } else { 0.0 };
    state[player::TIME] = start.to_bits();
    state[player::PREV_TIME] = start.to_bits();
    state[player::SPEED] = if speed.is_finite() { speed } else { 1.0 }.to_bits();
    state[player::FLAGS] = (flags & (PLAYER_LOOP_SET | PLAYER_LOOP)) | PLAYER_STARTED;
    state[player::PLAY_ID] = play_id;
    state[player::WRAPS] = 0;
    state[player::DELTA] = 0;
    replaced
}

/// Moves the current clip's open notify states to the pending end (ended at the next Tracks
/// phase) and clears them.
fn retire(state: &mut [u32]) {
    let open = player::OPEN..player::OPEN + player::OPEN_WORDS;
    if state[player::CLIP] != 0 && state[open.clone()].iter().any(|w| *w != 0) {
        state[player::ENDED_CLIP] = state[player::CLIP];
        state[player::ENDED_TIME] = state[player::TIME];
        state.copy_within(open.clone(), player::ENDED_OPEN);
    }
    state[open].fill(0);
}

/// Ends a clip player's play without events of its own: it keeps playing (fading out), but
/// reports nothing more. Returns its id if it hadn't finished, else 0.
pub fn interrupt(state: &mut [u32]) -> u32 {
    let id = state[player::PLAY_ID];
    state[player::PLAY_ID] = 0;
    if id != 0 && state[player::FLAGS] & PLAYER_FINISHED == 0 {
        id
    } else {
        0
    }
}

/// Clears a clip player: no clip (its pose is empty). Returns its unfinished play's id, else 0.
pub fn clear(state: &mut [u32]) -> u32 {
    let id = interrupt(state);
    retire(state);
    state[player::CLIP] = 0;
    id
}

/// The clip handle a player's state holds (0 for none).
pub fn clip_of(state: &[u32]) -> u32 {
    state[player::CLIP]
}

/// A player's playhead (seconds).
pub fn time_of(state: &[u32]) -> f32 {
    f32::from_bits(state[player::TIME])
}

/// Moves a player's playhead to `time` (a seek: no keys fire for the jump, the next window
/// starts there).
pub fn seek(state: &mut [u32], time: f32) {
    state[player::TIME] = time.to_bits();
    state[player::PREV_TIME] = time.to_bits();
    state[player::DELTA] = 0;
    state[player::WRAPS] = 0;
}

/// Sets a player's speed (playback rate).
pub fn set_speed(state: &mut [u32], speed: f32) {
    if speed.is_finite() {
        state[player::SPEED] = speed.to_bits();
    }
}

/// Builds a node's load-time data (2D blend spaces: the triangulation; 1D: the sorted order).
pub(crate) fn build_aux(kind: u16, words: &[u32], inputs: usize, aux: &mut Vec<u32>) {
    let coord = |i: usize| {
        words
            .get(7 + i)
            .map_or(0.0, |w| f32::from_bits(*w))
            .clamp(-1e30, 1e30)
    };
    match kind {
        kind::BLEND_SPACE_1D => {
            let mut order: Vec<u32> = (0..inputs as u32).collect();
            triangulate::sort_small(&mut order, |&a, &b| {
                coord(a as usize)
                    .total_cmp(&coord(b as usize))
                    .then(a.cmp(&b))
                    .is_lt()
            });
            aux.extend_from_slice(&order);
        }
        kind::BLEND_SPACE_2D => {
            let points: Vec<[f32; 2]> = (0..inputs)
                .map(|i| [coord(2 * i), coord(2 * i + 1)])
                .collect();
            let t = triangulate::triangulate(&points);
            aux.push(t.triangles.len() as u32);
            aux.push(t.hull.len() as u32);
            for tri in &t.triangles {
                aux.extend_from_slice(tri);
            }
            for e in &t.hull {
                aux.extend_from_slice(e);
            }
        }
        _ => {}
    }
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    match kind {
        kind::CLIP_PLAYER => clip_player(cx, node),
        kind::BLEND_SPACE_1D | kind::BLEND_SPACE_2D => blend_space(cx, kind, node),
        kind::POSE_SNAPSHOT => snapshot(cx, node),
        kind::REFERENCE_POSE | kind::BIND_POSE => fixed_pose(cx, kind, node),
        _ => return NodeStatus::UnknownKind,
    }
    NodeStatus::Done
}

fn clip_player(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    match cx.phase() {
        Phase::Layout => cx.set_state_words(player::WORDS, 0),
        Phase::Init => {
            let clip = cx.binding(node.word(0));
            let speed = node.f32_or(1, 1.0);
            let mut start = node.f32_or(3, 0.0);
            let layer = node.params.get(4).copied().unwrap_or(NONE);
            let flags = node.word(2);
            // T70: a `jump` with an offset starts the play that far in (a seek: nothing fires).
            let (norm, secs) = cx.init_offset();
            if norm > 0.0 || secs > 0.0 {
                if let Some(c) = cx.assets().clip(clip) {
                    start = offset_start(
                        start,
                        norm * c.duration + secs,
                        c.duration,
                        loops(&c, flags),
                    );
                }
            }
            let s = cx.state();
            start_play(s, clip, start, speed, flags, 0);
            s[player::LAYER] = layer;
        }
        Phase::Weights => cx.collect_player(),
        _ => player_phase(cx, 0, 1.0),
    }
}

/// Runs the current phase (Update, Alpha, Pose, Root, Tracks, Timing) of the player whose state
/// starts at word `at` of the current node's state, advancing at `rate` × dt (Update).
pub(crate) fn player_phase(cx: &mut EvalContext<'_>, at: usize, rate: f32) {
    match cx.phase() {
        Phase::Update => update(cx, at, rate),
        Phase::Alpha => {
            let handle = cx.state()[at + player::CLIP];
            let a = if handle != 0 && cx.assets().clip(handle).is_some() {
                1.0
            } else {
                0.0
            };
            cx.set_alpha(a);
        }
        Phase::Pose => pose(cx, at, 0, 0),
        Phase::Root => {
            let delta = root(cx, at);
            cx.set_root(delta);
        }
        Phase::Tracks => {
            let w = cx.weight();
            tracks(cx, at, w);
        }
        Phase::Timing => {
            let t = timing(cx, at);
            cx.set_timing(t);
        }
        _ => {}
    }
}

fn timing(cx: &mut EvalContext<'_>, at: usize) -> Timing {
    let assets = cx.assets();
    let s = &cx.state()[at..at + player::WORDS as usize];
    let handle = s[player::CLIP];
    let Some(clip) = (if handle != 0 {
        assets.clip(handle)
    } else {
        None
    }) else {
        return Timing::default();
    };
    Timing {
        clip: handle,
        time: f32::from_bits(s[player::TIME]),
        prev: f32::from_bits(s[player::PREV_TIME]),
        delta: f32::from_bits(s[player::DELTA]),
        duration: clip.duration,
        looping: loops(&clip, s[player::FLAGS]),
        exit: false,
    }
}

/// The Tracks phase of the player at word `at` of the current node's state, at `weight`.
pub(crate) fn player_tracks_at(cx: &mut EvalContext<'_>, at: usize, weight: f32) {
    tracks(cx, at, weight);
}

/// The root delta of the player at word `at` of the current node's state.
pub(crate) fn player_root_at(cx: &mut EvalContext<'_>, at: usize) -> RootDelta {
    root(cx, at)
}

/// The pose of the player at word `at` of the current node's state, into the current out slot.
/// `sub` numbers the node's players (0 or 1: a slot's two), for their frame-cache slots.
/// The pose of the player at `at` (frame-cache slot `sub` of the node), read only through bone
/// mask `mask` (a mask handle, 0 for none): bones it gives no weight may be left unsampled.
pub(crate) fn player_pose_at(cx: &mut EvalContext<'_>, at: usize, sub: usize, mask: u32) {
    pose(cx, at, sub, mask);
}

fn tracks(cx: &mut EvalContext<'_>, at: usize, weight: f32) {
    let assets = cx.assets();
    let mut state = [0u32; player::WORDS as usize];
    state.copy_from_slice(&cx.state()[at..at + player::WORDS as usize]);
    let Some(out) = cx.track_output() else {
        return;
    };
    let ended = state[player::ENDED_CLIP];
    if ended != 0 {
        let e = player::ENDED_OPEN;
        out.end(
            ended,
            f32::from_bits(state[player::ENDED_TIME]),
            &mut state[e..e + player::OPEN_WORDS],
        );
        state[player::ENDED_CLIP] = 0;
    }
    let handle = state[player::CLIP];
    let clip = if handle != 0 {
        assets.clip(handle)
    } else {
        None
    };
    if let Some(clip) = clip {
        let flags = state[player::FLAGS];
        let mut window = Window::new(
            f32::from_bits(state[player::PREV_TIME]),
            f32::from_bits(state[player::DELTA]),
            loops(&clip, flags),
        );
        if flags & PLAYER_STARTED != 0 {
            window = window.with(WINDOW_START);
            state[player::FLAGS] = flags & !PLAYER_STARTED;
        }
        let o = player::OPEN;
        out.window(
            handle,
            &window,
            weight,
            &mut state[o..o + player::OPEN_WORDS],
        );
    }
    cx.state()[at..at + player::WORDS as usize].copy_from_slice(&state);
}

/// A play's start `start` moved `by` seconds on: wrapped into `[0, duration)` for a looping clip,
/// clamped to `duration` for a one-shot (T70's `jump` offsets).
fn offset_start(start: f32, by: f32, duration: f32, looping: bool) -> f32 {
    let t = start + by;
    if !t.is_finite() || duration <= 0.0 {
        return start;
    }
    if looping {
        let w = t - (t / duration).floor() * duration;
        if w >= duration {
            0.0
        } else {
            w.max(0.0)
        }
    } else {
        t.clamp(0.0, duration)
    }
}

pub(crate) fn loops(clip: &ClipRef<'_>, flags: u32) -> bool {
    if flags & PLAYER_LOOP_SET != 0 {
        flags & PLAYER_LOOP != 0
    } else {
        clip.looping
    }
}

// `!(a < b)` is deliberate: true for NaN too.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn update(cx: &mut EvalContext<'_>, at: usize, rate: f32) {
    let dt = cx.dt() * rate;
    let assets = cx.assets();
    let s = &mut cx.state()[at..at + player::WORDS as usize];
    let handle = s[player::CLIP];
    let Some(clip) = (if handle != 0 {
        assets.clip(handle)
    } else {
        None
    }) else {
        s[player::WRAPS] = 0;
        return;
    };
    let time = f32::from_bits(s[player::TIME]);
    let speed = f32::from_bits(s[player::SPEED]);
    let flags = s[player::FLAGS];
    let dur = clip.duration;
    let mut t = time + dt * speed;
    let mut wraps = 0i32;
    let mut finished = false;
    if loops(&clip, flags) && dur > 0.0 {
        let k = Lane::floor(t / dur);
        if k != 0.0 {
            wraps = k as i32;
            t -= k * dur;
            // Rounding can land exactly on `dur` (or a hair below 0).
            if !(t < dur) {
                t = 0.0;
            }
            if t < 0.0 {
                t = 0.0;
            }
        }
    } else {
        if t >= dur {
            t = dur;
            finished = speed > 0.0 || dur <= 0.0;
        }
        if t <= 0.0 {
            t = 0.0;
            finished = finished || speed < 0.0;
        }
        if !t.is_finite() {
            t = 0.0;
        }
    }
    s[player::PREV_TIME] = time.to_bits();
    s[player::DELTA] = (dt * speed).to_bits();
    s[player::TIME] = t.to_bits();
    s[player::WRAPS] = wraps as u32;
    if finished && flags & PLAYER_FINISHED == 0 {
        s[player::FLAGS] = flags | PLAYER_FINISHED;
        let id = s[player::PLAY_ID];
        let layer = s[player::LAYER];
        if id != 0 {
            cx.emit(StateEvent {
                kind: StateEventKind::Finished,
                layer,
                play_id: id,
            });
        }
    }
}

fn pose(cx: &mut EvalContext<'_>, at: usize, sub: usize, mask: u32) {
    let slot = cx.out();
    let assets = cx.assets();
    let skel = cx.skeleton();
    let bake = cx.bake_root();
    let (handle, time) = {
        let s = &cx.state()[at..];
        (s[player::CLIP], f32::from_bits(s[player::TIME]))
    };
    let clip = if handle != 0 {
        assets.clip(handle)
    } else {
        None
    };
    let Some(clip) = clip else {
        cx.fill_rest(slot);
        return;
    };
    let rest = if clip.additive {
        skel.identity
    } else {
        skel.rest
    };
    let only = if mask != 0 { assets.mask(mask) } else { None };
    let (out, scratch, cache, tag) = cx.pose_sample_and_cache(slot, sub);
    let sampled = match cache {
        // T82r: the player's frame cache (the same bits as without it). Under a mask, only the
        // bones it keeps are decoded (the rest are never read).
        Some((header, frames)) => {
            let mut cache = anim_sample::FrameCache::new(header, frames, tag);
            match only {
                Some(m) => clip
                    .bound
                    .sample_pose_masked(time, rest, scratch, out, &mut cache, m),
                None => clip
                    .bound
                    .sample_pose_cached(time, rest, scratch, out, &mut cache),
            }
        }
        None => clip.bound.sample_pose(time, rest, scratch, out, None),
    };
    if sampled.is_err() {
        // A clip made for another skeleton (or scratch too small): nothing to show.
        cx.fill_rest(slot);
        return;
    }
    let root = clip.root_bone as usize;
    if bake && !clip.additive && clip.root_bone != NONE && root < skel.bones() {
        anim_pose::root::bake_out_root_motion(
            out,
            root,
            skel.rest[root],
            RootMotionAxes::planar_yaw(Axis::Y),
            Axis::Y,
        );
    }
}

/// The root curve (x, y, z, yaw) at `t` seconds: linear between the frames around it (the last
/// at the clip's duration).
fn curve_at(clip: &ClipRef<'_>, t: f32) -> Option<[f32; 4]> {
    let curve = clip.root_curve?;
    clip.frame_count.checked_sub(1)?;
    let p = clip.frame_clock().pos(t);
    let (f0, f1, a) = (p.f0, p.f1, p.alpha);
    let mut out = [0.0f32; 4];
    for (k, o) in out.iter_mut().enumerate() {
        let v0 = curve.get(4 * f0 as usize + k)?;
        let v1 = curve.get(4 * f1 as usize + k)?;
        *o = v0 + (v1 - v0) * a;
    }
    Some(out)
}

/// A clip's root speed: its root curve's ground distance from start to end over its duration
/// (0 without a curve). The blend spaces' speed scaling reads it.
pub fn root_speed(clip: &ClipRef<'_>) -> f32 {
    if clip.duration.is_nan() || clip.duration <= 0.0 {
        return 0.0;
    }
    match (curve_at(clip, 0.0), curve_at(clip, clip.duration)) {
        (Some(a), Some(b)) => {
            let (dx, dz) = (b[0] - a[0], b[2] - a[2]);
            (dx * dx + dz * dz).sqrt() / clip.duration
        }
        _ => 0.0,
    }
}

/// The movement from `a` to `b` seconds, in the character's frame at `a`.
fn curve_delta(clip: &ClipRef<'_>, a: f32, b: f32) -> RootDelta {
    let (Some(p), Some(q)) = (curve_at(clip, a), curve_at(clip, b)) else {
        return RootDelta::identity();
    };
    let (dx, dy, dz) = (q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    // Into the frame at `a`: rotate by −yaw(a) about +Y.
    let (s, c) = sin_cos(p[3]);
    let translation = AosVec3::new(c * dx - s * dz, dy, s * dx + c * dz);
    let (hs, hc) = sin_cos(0.5 * (q[3] - p[3]));
    RootDelta {
        translation,
        rotation: AosQuat::new(0.0, hs, 0.0, hc),
    }
}

fn root(cx: &mut EvalContext<'_>, at: usize) -> RootDelta {
    let assets = cx.assets();
    let s = &cx.state()[at..];
    let handle = s[player::CLIP];
    let Some(clip) = (if handle != 0 {
        assets.clip(handle)
    } else {
        None
    }) else {
        return RootDelta::identity();
    };
    if clip.additive || clip.root_curve.is_none() {
        return RootDelta::identity();
    }
    let from = f32::from_bits(s[player::PREV_TIME]);
    let to = f32::from_bits(s[player::TIME]);
    let wraps = s[player::WRAPS] as i32;
    let dur = clip.duration;
    if wraps == 0 {
        return curve_delta(&clip, from, to);
    }
    // Across the seam: to the end, whole cycles, then from the start (backwards mirrored).
    let (end, start) = if wraps > 0 { (dur, 0.0) } else { (0.0, dur) };
    let mut delta = curve_delta(&clip, from, end);
    let cycle = curve_delta(&clip, start, end);
    // Whole cycles beyond the first wrap (a large step); bounded so a huge dt can't spin.
    for _ in 1..wraps.unsigned_abs().min(8) {
        delta = delta.then_local(cycle);
    }
    delta.then_local(curve_delta(&clip, start, to))
}

/// Composition of deltas expressed in successive local frames.
trait ThenLocal {
    fn then_local(self, next: RootDelta) -> RootDelta;
}

impl ThenLocal for RootDelta {
    /// `self` then `next`, where `next` is in the frame `self` ends in: `next`'s translation is
    /// rotated by `self`'s rotation before it adds.
    fn then_local(self, next: RootDelta) -> RootDelta {
        let t = self.rotation.rotate(next.translation);
        RootDelta {
            translation: self.translation + t,
            rotation: (self.rotation * next.rotation).normalize_or_identity(),
        }
    }
}

/// The sync phase of a timing (its clip's markers at its playhead), if a clip plays.
pub(crate) fn phase_of(cx: &EvalContext<'_>, t: &Timing) -> Option<SyncPhase> {
    let clip = cx.assets().clip(t.clip)?;
    Some(
        SyncClip {
            markers: clip.sync,
            duration: clip.duration,
            looping: t.looping,
        }
        .phase_at(t.time),
    )
}

/// Moves clip player `node` (of the current program) to `phase` (sync groups). `advanced`: it
/// updated this frame, so its window runs from its previous playhead to the synced one (forward
/// for positive speed, across the loop seam when needed); otherwise it seeks there.
pub(crate) fn sync_player(cx: &mut EvalContext<'_>, node: u32, phase: SyncPhase, advanced: bool) {
    let assets = cx.assets();
    let s = cx.node_state(node);
    if s.len() < player::WORDS as usize {
        return;
    }
    let Some(clip) = assets.clip(s[player::CLIP]) else {
        return;
    };
    let looping = loops(&clip, s[player::FLAGS]);
    let target = SyncClip {
        markers: clip.sync,
        duration: clip.duration,
        looping,
    }
    .time_at(phase);
    if !advanced {
        seek(s, target);
        return;
    }
    let prev = f32::from_bits(s[player::PREV_TIME]);
    let speed = f32::from_bits(s[player::SPEED]);
    let mut d = target - prev;
    let mut wraps = 0i32;
    if looping && clip.duration > 0.0 {
        if speed >= 0.0 && d < 0.0 {
            d += clip.duration;
            wraps = 1;
        } else if speed < 0.0 && d > 0.0 {
            d -= clip.duration;
            wraps = -1;
        }
    }
    s[player::TIME] = target.to_bits();
    s[player::DELTA] = d.to_bits();
    s[player::WRAPS] = wraps as u32;
}

/// Syncs every clip player under `inputs` (other than the leader's) to the phase of the heaviest
/// one. `weights[i]` is input `i`'s weight (0: it didn't advance; it seeks).
pub(crate) fn sync_inputs(cx: &mut EvalContext<'_>, inputs: &[u32], weights: &[f32]) {
    let mut leader: Option<(usize, f32)> = None;
    for (i, &w) in weights.iter().enumerate() {
        if leader.is_none_or(|l| w > l.1) {
            leader = Some((i, w));
        }
    }
    let Some((li, _)) = leader else {
        return;
    };
    let t = cx.eval_timing(inputs[li]);
    let Some(phase) = phase_of(cx, &t) else {
        return;
    };
    for (i, &input) in inputs.iter().enumerate() {
        if i == li {
            continue;
        }
        let w = weights[i];
        let (players, n) = cx.collect(input, 1.0);
        for &(p, _) in &players[..n] {
            sync_player(cx, p, phase, w > 0.0);
        }
    }
}

mod bs {
    /// Fixed state words before the per-input weights.
    pub const FIXED: usize = 10;
    pub const FLAGS: usize = 0;
    pub const FROM: usize = 1;
    pub const TO: usize = 3;
    pub const ELAPSED: usize = 5;
    pub const CURRENT: usize = 6;
    pub const RATE: usize = 8;
    pub const LEADER: usize = 9;
}

fn read_point(cx: &EvalContext<'_>, node: &NodeData<'_>, two_d: bool) -> [f32; 2] {
    let x = cx.param_f32(node.word_or_none(0));
    let y = if two_d {
        cx.param_f32(node.word_or_none(1))
    } else {
        0.0
    };
    [x, y]
}

fn coord(node: &NodeData<'_>, i: usize) -> f32 {
    node.f32_or(7 + i, 0.0)
}

/// The weights of `p` over the samples, into `out` (one per input).
fn space_weights(node: &NodeData<'_>, two_d: bool, p: [f32; 2], out: &mut [f32]) {
    out.fill(0.0);
    let n = out.len();
    if n == 0 {
        return;
    }
    if !two_d {
        let order = node.aux;
        let x = p[0];
        let pos = |k: usize| coord(node, order.get(k).copied().unwrap_or(0) as usize);
        let idx = |k: usize| (order.get(k).copied().unwrap_or(0) as usize).min(n - 1);
        if order.len() < n {
            out[0] = 1.0;
            return;
        }
        if x.is_nan() || x <= pos(0) {
            out[idx(0)] = 1.0;
            return;
        }
        if x >= pos(n - 1) {
            out[idx(n - 1)] = 1.0;
            return;
        }
        for k in 0..n - 1 {
            let (a, b) = (pos(k), pos(k + 1));
            if x >= a && x < b {
                let t = if b > a { (x - a) / (b - a) } else { 0.0 };
                out[idx(k)] += 1.0 - t;
                out[idx(k + 1)] += t;
                return;
            }
        }
        out[idx(n - 1)] = 1.0;
        return;
    }
    let ntri = node.aux.first().copied().unwrap_or(0) as usize;
    let nedge = node.aux.get(1).copied().unwrap_or(0) as usize;
    let tri_words = node.aux.get(2..2 + 3 * ntri).unwrap_or(&[]);
    let edge_words = node
        .aux
        .get(2 + 3 * ntri..2 + 3 * ntri + 2 * nedge)
        .unwrap_or(&[]);
    let mut points = [[0.0f32; 2]; MAX_BLEND_INPUTS];
    for (i, q) in points.iter_mut().enumerate().take(n) {
        *q = [coord(node, 2 * i), coord(node, 2 * i + 1)];
    }
    let (tris, _) = tri_words.as_chunks::<3>();
    let (edges, _) = edge_words.as_chunks::<2>();
    let (idx, w) = triangulate::weights(&points[..n], tris, edges, p);
    for k in 0..3 {
        if let Some(o) = out.get_mut(idx[k] as usize) {
            *o += w[k];
        }
    }
}

#[allow(clippy::needless_range_loop)] // weights and inputs share the index
fn blend_space(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) {
    let two_d = kind == kind::BLEND_SPACE_2D;
    let n = node.inputs.len().min(MAX_BLEND_INPUTS);
    match cx.phase() {
        Phase::Layout => cx.set_state_words((bs::FIXED + n) as u32, 0),
        Phase::Init => {
            let p = read_point(cx, &node, two_d);
            let mut w = [0.0f32; MAX_BLEND_INPUTS];
            space_weights(&node, two_d, p, &mut w[..n]);
            let s = cx.state();
            s.fill(0);
            s[bs::FLAGS] = 1;
            for (k, v) in [p[0], p[1], p[0], p[1], 0.0, p[0], p[1], 1.0]
                .iter()
                .enumerate()
            {
                s[bs::FROM + k] = v.to_bits();
            }
            for (i, v) in w.iter().take(n).enumerate() {
                s[bs::FIXED + i] = v.to_bits();
            }
        }
        Phase::Update => {
            let dt = cx.dt();
            let target = read_point(cx, &node, two_d);
            let glide = node.f32_or(3, 0.0) * 0.001;
            let flags = node.word(4);
            let current = {
                let s = cx.state();
                let f = |k: usize| f32::from_bits(s[k]);
                let mut from = [f(bs::FROM), f(bs::FROM + 1)];
                let mut to = [f(bs::TO), f(bs::TO + 1)];
                let mut elapsed = f(bs::ELAPSED);
                if to != target {
                    from = [f(bs::CURRENT), f(bs::CURRENT + 1)];
                    to = target;
                    elapsed = 0.0;
                }
                elapsed += dt.abs();
                let t = if glide > 0.0 {
                    (elapsed / glide).min(1.0)
                } else {
                    1.0
                };
                let cur = [
                    from[0] + (to[0] - from[0]) * t,
                    from[1] + (to[1] - from[1]) * t,
                ];
                for (k, v) in [from[0], from[1], to[0], to[1], elapsed, cur[0], cur[1]]
                    .iter()
                    .enumerate()
                {
                    s[bs::FROM + k] = v.to_bits();
                }
                cur
            };
            let mut w = [0.0f32; MAX_BLEND_INPUTS];
            space_weights(&node, two_d, current, &mut w[..n]);
            // Rate from the speed parameter over the blended root speed.
            let mut rate = 1.0f32;
            let speed_param = node.word_or_none(2);
            if flags & BS_SPEED != 0 && speed_param != NONE {
                let desired = cx.param_f32(speed_param);
                let mut blended = 0.0f32;
                for k in 0..n {
                    if w[k] > 0.0 {
                        let t = cx.eval_timing(node.inputs[k]);
                        if let Some(clip) = cx.assets().clip(t.clip) {
                            blended += w[k] * root_speed(&clip);
                        }
                    }
                }
                if blended > 1e-4 {
                    let lo = node.f32_or(5, 0.0);
                    let hi = node.f32_or(6, 0.0);
                    let lo = if lo > 0.0 { lo } else { 0.25 };
                    let hi = if hi > 0.0 { hi } else { 4.0 };
                    rate = (desired / blended).clamp(lo, hi.max(lo));
                }
            }
            let mut leader = 0usize;
            for k in 0..n {
                if w[k] > w[leader] {
                    leader = k;
                }
            }
            {
                let s = cx.state();
                s[bs::RATE] = rate.to_bits();
                s[bs::LEADER] = leader as u32;
                for (i, v) in w.iter().take(n).enumerate() {
                    s[bs::FIXED + i] = v.to_bits();
                }
            }
            for k in 0..n {
                if w[k] > 0.0 {
                    let ctx = cx.input_context(&node, k);
                    cx.update_context(ctx, dt * rate);
                }
            }
            if flags & BS_SYNC != 0 && n > 1 {
                sync_inputs(cx, &node.inputs[..n], &w[..n]);
            }
        }
        _ => {
            let mut items = [(0u32, 0.0f32); MAX_BLEND_INPUTS];
            let weighted_phase = cx.phase().is_weighted() || cx.phase() == Phase::Timing;
            for (i, item) in items.iter_mut().take(n).enumerate() {
                let w = f32::from_bits(cx.state()[bs::FIXED + i]);
                let input = node.inputs[i];
                let e = if weighted_phase || w <= 0.0 {
                    w
                } else {
                    w * cx.eval_alpha(input)
                };
                *item = (input, e);
            }
            mixing::weighted(cx, &items[..n]);
        }
    }
}

/// Captures `pose` into a pose-snapshot node's state (the `graph` family's `CAPTURE_POSE`).
pub fn capture(state: &mut [u32], pose: &[SoaTransform]) -> bool {
    let g = pose.len() * SOA_WORDS;
    if state.len() < 1 + g {
        return false;
    }
    pose_to_words(pose, &mut state[1..1 + g]);
    state[0] = 1;
    true
}

fn snapshot(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    match cx.phase() {
        Phase::Layout => cx.set_state_words(1, SOA_WORDS as u32),
        Phase::Init => {
            let history = cx.history();
            let mode = node.word(0);
            let s = cx.state();
            s[0] = 0;
            if mode == 0 {
                if let Some(h) = history {
                    capture(s, h.last);
                }
            }
        }
        Phase::Alpha => {
            let a = if cx.state()[0] != 0 { 1.0 } else { 0.0 };
            cx.set_alpha(a);
        }
        Phase::Pose => {
            let out = cx.out();
            let g = cx.groups() * SOA_WORDS;
            let valid = cx.state()[0] != 0;
            if !valid {
                cx.fill_rest(out);
                return;
            }
            if let Some((state, [o])) = cx.state_and_slots([out]) {
                pose_from_words(&state[1..1 + g], o);
            }
        }
        Phase::Root => cx.set_root(RootDelta::identity()),
        _ => {}
    }
}

fn fixed_pose(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) {
    match cx.phase() {
        Phase::Alpha => cx.set_alpha(1.0),
        Phase::Root => cx.set_root(RootDelta::identity()),
        Phase::Pose => {
            let out = cx.out();
            let skel = cx.skeleton();
            if kind == kind::REFERENCE_POSE && node.word(0) == 1 {
                for t in cx.pose_mut(out) {
                    *t = SoaTransform::identity();
                }
            } else if kind == kind::BIND_POSE && skel.bind_soa.len() == cx.groups() {
                cx.pose_mut(out).copy_from_slice(skel.bind_soa);
            } else {
                cx.fill_rest(out);
            }
        }
        _ => {}
    }
}
