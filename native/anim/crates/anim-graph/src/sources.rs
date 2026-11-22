//! Node family `sources`: clip players, blend spaces 1D and 2D (triangulated, `follow.glideMs`, root speed), pose snapshot, reference and bind pose.
//!
//! T13r fills the clip player; T31 adds the rest. Declare the family's kinds in [`kind`]
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
//! id, wraps in the last update, layer. Looping clips wrap; others clamp and report
//! [`StateEventKind::Finished`] once when they reach their end (only plays the host gave an id).
//!
//! The pose is the clip sampled at the playhead (over identity for additive clips), with the
//! root bone's ground-plane translation and yaw baked out when the instance asks
//! ([`EvalContext::bake_root`]). The root delta comes from the clip's root curve (translation
//! and yaw, ADR 0340's prediction curve) between the previous and current playhead, across a loop
//! seam when it wrapped; a clip without a root curve has no root motion.

use anim_format::NONE;
use anim_math::trig::sin_cos;
use anim_math::{AosQuat, AosVec3, Lane};
use anim_pose::root::{RootDelta, RootMotionAxes};
use anim_pose::Axis;

use crate::dispatch::NodeStatus;
use crate::eval::{ClipRef, EvalContext, NodeData, Phase, StateEvent, StateEventKind};

/// The family's node kinds.
pub mod kind {
    /// Plays one clip (module docs).
    pub const CLIP_PLAYER: u16 = 0;
}

/// [`kind::CLIP_PLAYER`] flag: the player's own loop setting overrides the clip's.
pub const PLAYER_LOOP_SET: u32 = 1;
/// [`kind::CLIP_PLAYER`] flag: loop (with [`PLAYER_LOOP_SET`]).
pub const PLAYER_LOOP: u32 = 2;
/// State flag: the play reached its end.
const PLAYER_FINISHED: u32 = 4;

/// A clip player's state words.
pub mod player {
    /// Words of state.
    pub const WORDS: u32 = 8;
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
}

/// The parameter words of a clip player (for compilers and the implicit graph).
pub fn clip_player_params(clip: u32, speed: f32, flags: u32, start: f32, layer: u32) -> [u32; 5] {
    [clip, speed.to_bits(), flags, start.to_bits(), layer]
}

/// Starts a play on a clip player's state: `clip` from `start` seconds at `speed`, with `flags`
/// ([`PLAYER_LOOP_SET`], [`PLAYER_LOOP`]) and the host's `play_id`. Returns the id of the play it
/// replaced if that play hadn't finished (the host reports it interrupted), else 0.
pub fn start_play(state: &mut [u32], clip: u32, start: f32, speed: f32, flags: u32, play_id: u32) -> u32 {
    let replaced = interrupt(state);
    state[player::CLIP] = clip;
    let start = if start.is_finite() { start } else { 0.0 };
    state[player::TIME] = start.to_bits();
    state[player::PREV_TIME] = start.to_bits();
    state[player::SPEED] = if speed.is_finite() { speed } else { 1.0 }.to_bits();
    state[player::FLAGS] = flags & (PLAYER_LOOP_SET | PLAYER_LOOP);
    state[player::PLAY_ID] = play_id;
    state[player::WRAPS] = 0;
    replaced
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
    state[player::CLIP] = 0;
    id
}

/// The clip handle a player's state holds (0 for none).
pub fn clip_of(state: &[u32]) -> u32 {
    state[player::CLIP]
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    match kind {
        kind::CLIP_PLAYER => {
            clip_player(cx, node);
            NodeStatus::Done
        }
        _ => NodeStatus::UnknownKind,
    }
}

fn clip_player(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    match cx.phase() {
        Phase::Layout => cx.set_state_words(player::WORDS, 0),
        Phase::Init => {
            let clip = cx.binding(node.word(0));
            let speed = node.f32_or(1, 1.0);
            let start = node.f32_or(3, 0.0);
            let layer = node.params.get(4).copied().unwrap_or(NONE);
            let s = cx.state();
            start_play(s, clip, start, speed, node.word(2), 0);
            s[player::LAYER] = layer;
        }
        Phase::Update => update(cx),
        Phase::Alpha => {
            let handle = cx.state()[player::CLIP];
            let a = if handle != 0 && cx.assets().clip(handle).is_some() {
                1.0
            } else {
                0.0
            };
            cx.set_alpha(a);
        }
        Phase::Pose => pose(cx),
        Phase::Root => {
            let delta = root(cx);
            cx.set_root(delta);
        }
    }
}

fn loops(clip: &ClipRef<'_>, flags: u32) -> bool {
    if flags & PLAYER_LOOP_SET != 0 {
        flags & PLAYER_LOOP != 0
    } else {
        clip.looping
    }
}

fn update(cx: &mut EvalContext<'_>) {
    let dt = cx.dt();
    let assets = cx.assets();
    let s = cx.state();
    let handle = s[player::CLIP];
    let Some(clip) = (if handle != 0 { assets.clip(handle) } else { None }) else {
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

fn pose(cx: &mut EvalContext<'_>) {
    let slot = cx.out();
    let assets = cx.assets();
    let skel = cx.skeleton();
    let bake = cx.bake_root();
    let (handle, time) = {
        let s = cx.state();
        (s[player::CLIP], f32::from_bits(s[player::TIME]))
    };
    let clip = if handle != 0 { assets.clip(handle) } else { None };
    let Some(clip) = clip else {
        cx.fill_rest(slot);
        return;
    };
    let rest = if clip.additive { skel.identity } else { skel.rest };
    let (out, scratch) = cx.pose_and_sample_scratch(slot);
    if clip
        .sampler
        .sample_pose(time, rest, scratch, out, None)
        .is_err()
    {
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

/// The root curve (x, y, z, yaw) at `t` seconds: linear between the frames around it.
fn curve_at(clip: &ClipRef<'_>, t: f32) -> Option<[f32; 4]> {
    let curve = clip.root_curve?;
    let last = clip.frame_count.checked_sub(1)?;
    let x = t * clip.sample_rate;
    let x = if x >= 0.0 { Lane::min(x, last as f32) } else { 0.0 };
    let f0 = (Lane::floor(x) as u32).min(last);
    let f1 = (f0 + 1).min(last);
    let a = x - f0 as f32;
    let mut out = [0.0f32; 4];
    for (k, o) in out.iter_mut().enumerate() {
        let v0 = curve.get(4 * f0 as usize + k)?;
        let v1 = curve.get(4 * f1 as usize + k)?;
        *o = v0 + (v1 - v0) * a;
    }
    Some(out)
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

fn root(cx: &mut EvalContext<'_>) -> RootDelta {
    let assets = cx.assets();
    let s = cx.state();
    let handle = s[player::CLIP];
    let Some(clip) = (if handle != 0 { assets.clip(handle) } else { None }) else {
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
