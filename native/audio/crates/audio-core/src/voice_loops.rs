//! Sample loop programs in the core voice (ADR 0328; LOOPS, ABI 4.3).
//!
//! A clip voice may carry a **program** of up to [`MAX_LOOPS`] loops (`VOICE_LOOPS_MAX` on the wire,
//! declared once there), sorted by start, held in its automation entry ([`crate::automation::VoiceAuto`],
//! the `Automation` region: the 192-byte voice slot of architecture §5.1 doesn't grow). Each loop is a
//! region of clip frames with:
//!
//! - **direction**: forward (the region repeats), ping-pong (forward to its end, back to its start,
//!   forward again) or backward (forward to its end, then the region plays reversed, again and again);
//! - a **repeat count** (0 endless; else the region is played that many times in all, the first pass
//!   included, then the voice plays on past it);
//! - a **crossfade** at the seam (`xfade` clip frames, in the loop's seam shape, ABI 4.9: one of the
//!   playlist fade shapes, `audio_dsp::fade_shapes`; equal power by default; an exit crossfade takes
//!   its exit shape): where the playhead wraps, the
//!   audio it leaves goes on reading past the seam as a tail fading out while the loop's other end
//!   fades in (a ping-pong turn is continuous, so it needs none);
//! - a **hold point** when `start == end`: the playhead parks there (silent, its last audio fading out
//!   over `xfade`) and goes on, fading in over `xfade`, when the loop is let go;
//! - an **activation**: always, held (until the voice's key-off, SET_LOOP with `looping` clear) or a
//!   parameter (a binding-style `param` slot compared with `threshold`, `>` or `<`, once a quantum);
//! - an **exit** when its activation ends while the playhead is in it: finish (the current pass
//!   plays out and the voice goes on past the loop), jump (to the loop's end at once, through a
//!   `xfade` crossfade) or crossfade (to its end through an `exit_fade` crossfade);
//! - a **re-entry**: ignore (a loop that was left or passed stays so) or re-enter (when its
//!   activation comes back while the playhead is past it, the playhead jumps back to its start through
//!   a `xfade` crossfade).
//!
//! The program's per-frame state machine is [`step`]; the mixed voice reads its frames through
//! [`render`] (a 4-point Lagrange read of each of the main reader and the tail, region-wrapped
//! neighbours at a forward loop's seam as `resample::lagrange_region`), a virtual one keeps time
//! through [`advance`]. Activations are worked out once a quantum (`automation::begin_quantum` sets
//! [`Program::want`]); a change is applied at the quantum's start ([`settle`]), a key-off at its own
//! sample (`voices::set_loop`). Stream voices keep the single-region loop of the decoder worker, and
//! ambisonic voices play a program straight through (neither reads frame by frame here).

use audio_dsp::resample::{weights, Samples, Source};
use audio_wire::generated as wire;

/// Loops a voice's program keeps (the wire's `VOICE_LOOPS_MAX`; extra ones are ignored).
pub const MAX_LOOPS: usize = wire::VOICE_LOOPS_MAX as usize;

/// LOOPS item `flags` fields.
pub mod flags {
    pub const DIRECTION_MASK: u16 = 0x3;
    pub const ACTIVE_SHIFT: u16 = 2;
    pub const EXIT_SHIFT: u16 = 4;
    pub const REENTER: u16 = 1 << 6;
    pub const BELOW: u16 = 1 << 7;
}

/// Directions (`flags` bits 0-1).
pub mod direction {
    pub const FORWARD: u8 = 0;
    pub const PING_PONG: u8 = 1;
    pub const BACKWARD: u8 = 2;
}

/// Activations (`flags` bits 2-3).
pub mod active {
    pub const ALWAYS: u8 = 0;
    pub const HELD: u8 = 1;
    pub const PARAMETER: u8 = 2;
}

/// Exits (`flags` bits 4-5).
pub mod exit {
    pub const FINISH: u8 = 0;
    pub const JUMP: u8 = 1;
    pub const CROSSFADE: u8 = 2;
}

/// One loop, as LOOPS carries it. All-zero is a hold point at frame 0 (never used: `Program::n` counts).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LoopDef {
    pub start: u32,
    pub end: u32,
    /// The seam's crossfade, clip frames.
    pub xfade: u32,
    /// The exit crossfade (exit `CROSSFADE`), clip frames.
    pub exit_fade: u32,
    /// 0 endless; else passes in all.
    pub count: u16,
    pub flags: u16,
    /// A binding's `param` (global or local slot) for activation `PARAMETER`.
    pub param: u16,
    /// ABI 4.9: the seam's (bits 0-3) and exit's (bits 4-7) crossfade shapes (`FADE_SHAPE_*`).
    pub shapes: u16,
    pub threshold: f32,
}

impl LoopDef {
    /// The seam crossfade's shape (also a hold point's fades, a jump exit and a re-entry).
    #[inline]
    pub fn seam_shape(&self) -> u8 {
        ((self.shapes >> wire::LOOP_SEAM_SHAPE_SHIFT) & 0xF) as u8
    }
    /// The exit crossfade's shape.
    #[inline]
    pub fn exit_shape(&self) -> u8 {
        ((self.shapes >> wire::LOOP_EXIT_SHAPE_SHIFT) & 0xF) as u8
    }
    #[inline]
    pub fn direction(&self) -> u8 {
        (self.flags & flags::DIRECTION_MASK) as u8
    }
    #[inline]
    pub fn activation(&self) -> u8 {
        ((self.flags >> flags::ACTIVE_SHIFT) & 0x3) as u8
    }
    #[inline]
    pub fn exit(&self) -> u8 {
        ((self.flags >> flags::EXIT_SHIFT) & 0x3) as u8
    }
    #[inline]
    pub fn hold(&self) -> bool {
        self.start == self.end
    }
    /// A parameter activation's test of `value`.
    #[inline]
    pub fn passes_threshold(&self, value: f32) -> bool {
        if self.flags & flags::BELOW != 0 {
            value < self.threshold
        } else {
            value > self.threshold
        }
    }
}

/// A voice's loop program and where it is. All-zero is no program.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Program {
    /// Loops in use (0 none).
    pub n: u8,
    /// The loop the playhead is in or heading for; `n` when none is left ahead.
    pub cur: u8,
    /// Non-zero after the voice's key-off (held loops let go).
    pub released: u8,
    /// Non-zero while parked at the hold point `cur`.
    pub parked: u8,
    /// Bit `i`: loop `i`'s activation holds (applied); `want` is this quantum's, applied by [`settle`].
    pub engaged: u8,
    pub want: u8,
    /// Bit `i`: loop `i` was left or passed.
    pub done: u8,
    /// +1 forward, -1 backward (a ping-pong's return, a backward loop).
    pub dir: i8,
    /// Passes of `cur` completed.
    pub passes: u16,
    /// Non-zero while a tail reads.
    pub tail_on: u8,
    pub tail_dir: i8,
    /// The crossfade in progress: frames left of `fade_len` (the main reader fades in, the tail out).
    pub fade_left: u32,
    pub fade_len: u32,
    /// The crossfade in progress's shape (`FADE_SHAPE_*`, ABI 4.9).
    pub fade_shape: u8,
    pub _pad: [u8; 3],
    pub tail_pos: f64,
    pub defs: [LoopDef; MAX_LOOPS],
}

impl Program {
    #[inline]
    fn armed(&self, i: usize) -> bool {
        self.engaged & (1 << i) != 0 && self.done & (1 << i) == 0
    }

    /// The activation bits this program's loops would have with nothing but always and held
    /// loops (parameter loops keep their bit in `want`).
    pub fn held_bits(&self) -> u8 {
        let mut m = 0u8;
        for i in 0..self.n as usize {
            if self.defs[i].activation() == active::HELD {
                m |= 1 << i;
            }
        }
        m
    }
}

/// Loads `defs` (sorted by start here) as the program and places it at `pos` (see [`place`]). At
/// most [`MAX_LOOPS`] are kept; `want` gives every loop's activation now.
pub fn load(p: &mut Program, defs: &[LoopDef], want: u8, pos: f64) {
    let n = defs.len().min(MAX_LOOPS);
    *p = Program::default();
    p.defs[..n].copy_from_slice(&defs[..n]);
    // Insertion sort by start (a hold point before a loop that starts on it).
    for i in 1..n {
        let mut j = i;
        while j > 0 && (p.defs[j - 1].start, p.defs[j - 1].end) > (p.defs[j].start, p.defs[j].end) {
            p.defs.swap(j - 1, j);
            j -= 1;
        }
    }
    p.n = n as u8;
    p.engaged = want;
    p.want = want;
    place(p, pos);
}

/// After a jump of the playhead (a load, a SEEK landing): forward, no fade or tail, unparked, and the
/// loops behind `pos` passed (`done`), `cur` the first ahead.
pub fn place(p: &mut Program, pos: f64) {
    p.dir = 1;
    p.parked = 0;
    p.tail_on = 0;
    p.fade_left = 0;
    p.passes = 0;
    p.done = 0;
    for i in 0..p.n as usize {
        let d = p.defs[i];
        let behind = if d.hold() { (d.start as f64) < pos } else { d.end as f64 <= pos };
        if behind {
            p.done |= 1 << i;
        }
    }
    p.cur = next_from(p, 0);
}

fn next_from(p: &Program, from: usize) -> u8 {
    let mut i = from;
    while i < p.n as usize && p.done & (1 << i) != 0 {
        i += 1;
    }
    i as u8
}

/// Loop `c` is left: done, its passes forgotten, the next loop ahead becomes `cur`.
fn leave(p: &mut Program, c: usize) {
    p.done |= 1 << c;
    p.passes = 0;
    p.cur = next_from(p, c + 1);
}

/// Starts a crossfade of `len` frames: the tail (when `tail`) reads on from `(pos, dir)` fading out
/// while the main reader fades in, both in `shape` (`FADE_SHAPE_*`). `len` 0 is a cut.
fn begin_fade(p: &mut Program, len: u32, shape: u8, tail: Option<(f64, i8)>) {
    if len == 0 {
        p.tail_on = 0;
        p.fade_left = 0;
        return;
    }
    p.fade_len = len;
    p.fade_left = len;
    p.fade_shape = shape;
    match tail {
        Some((pos, dir)) => {
            p.tail_on = 1;
            p.tail_pos = pos;
            p.tail_dir = dir;
        }
        None => p.tail_on = 0,
    }
}

/// Moves the program one frame on: the main reader at `*pos` by `step` clip frames (in its
/// direction), and the tail and crossfade with it. `frames` is the clip's length.
pub fn step(p: &mut Program, pos: &mut f64, step: f32) {
    let s = step as f64;
    if p.fade_left > 0 {
        p.fade_left -= 1;
        if p.tail_on != 0 {
            p.tail_pos += p.tail_dir as f64 * s;
        }
        if p.fade_left == 0 {
            p.tail_on = 0;
        }
    }
    if p.parked != 0 {
        return;
    }
    let c = p.cur as usize;
    if c >= p.n as usize {
        *pos += s;
        return;
    }
    let l = p.defs[c];
    let (start, end) = (l.start as f64, l.end as f64);
    let armed = p.armed(c);
    if p.dir >= 0 {
        let mut new = *pos + s;
        if l.hold() {
            if *pos <= start && new > start {
                if armed {
                    // Park on the hold point; what was playing reads on as a fading tail.
                    begin_fade(p, l.xfade, l.seam_shape(), Some((new, 1)));
                    p.parked = 1;
                    p.fade_left = p.fade_left.max(0);
                    *pos = start;
                    return;
                }
                leave(p, c);
            }
            *pos = new;
            return;
        }
        if new >= end && *pos < end {
            p.passes = p.passes.saturating_add(1);
            let more = armed && (l.count == 0 || p.passes < l.count);
            if more {
                let len = end - start;
                match l.direction() {
                    direction::FORWARD => {
                        begin_fade(p, l.xfade, l.seam_shape(), Some((new, 1)));
                        while new >= end {
                            new -= len;
                        }
                    }
                    _ => {
                        // Ping-pong and backward turn round at the end (continuous: no crossfade).
                        new = (end - (new - end)).max(start);
                        p.dir = -1;
                    }
                }
            } else {
                leave(p, c);
            }
        }
        *pos = new;
    } else {
        let mut new = *pos - s;
        if new < start {
            let len = end - start;
            if l.direction() == direction::BACKWARD {
                p.passes = p.passes.saturating_add(1);
                let more = armed && (l.count == 0 || p.passes < l.count);
                begin_fade(p, l.xfade, l.seam_shape(), Some((new, -1)));
                if more {
                    while new < start {
                        new += len;
                    }
                } else {
                    // Out of the loop forward from its end.
                    new = (end + (start - new)).max(end);
                    p.dir = 1;
                    leave(p, c);
                }
            } else {
                // A ping-pong's return turns forward again (its decisions are at the end).
                new = (start + (start - new)).min(end);
                p.dir = 1;
            }
        }
        *pos = new.max(0.0);
    }
}

/// Applies this quantum's activations (`want`) to the program at `*pos`: a loop the playhead is in
/// whose activation ended exits by its exit setting (a parked hold point always goes on), and the
/// last loop behind the playhead whose activation came back with re-entry `reenter` takes the
/// playhead back to its start. Cheap when nothing changed.
pub fn settle(p: &mut Program, pos: &mut f64) {
    if p.want == p.engaged {
        return;
    }
    let rose = p.want & !p.engaged;
    p.engaged = p.want;
    let c = p.cur as usize;
    if c < p.n as usize && p.engaged & (1 << c) == 0 {
        let l = p.defs[c];
        if l.hold() {
            if p.parked != 0 {
                p.parked = 0;
                begin_fade(p, l.xfade, l.seam_shape(), None);
                leave(p, c);
            }
        } else {
            let inside = p.dir < 0 || (*pos >= l.start as f64 && *pos < l.end as f64);
            if inside {
                match l.exit() {
                    exit::JUMP => exit_to_end(p, pos, c, l.xfade, l.seam_shape()),
                    exit::CROSSFADE => exit_to_end(p, pos, c, l.exit_fade, l.exit_shape()),
                    _ => {} // finish: the pass plays out, then the loop is left at its end
                }
            }
        }
    }
    if rose == 0 {
        return;
    }
    // Re-entry: the nearest loop behind the playhead (its end at or before it) whose activation came back.
    let mut back = None;
    for i in 0..p.n as usize {
        let d = p.defs[i];
        let behind = if d.hold() { (d.start as f64) < *pos } else { d.end as f64 <= *pos };
        if rose & (1 << i) != 0 && d.flags & flags::REENTER != 0 && p.done & (1 << i) != 0 && behind && p.parked == 0 {
            back = Some(i);
        }
    }
    if let Some(i) = back {
        let d = p.defs[i];
        begin_fade(p, d.xfade, d.seam_shape(), Some((*pos, p.dir)));
        *pos = d.start as f64;
        p.dir = 1;
        p.passes = 0;
        // Loops from it on lie ahead again, except those that stay left (re-entry ignore).
        for j in i..p.n as usize {
            if j == i || p.defs[j].flags & flags::REENTER != 0 {
                p.done &= !(1 << j);
            }
        }
        p.cur = next_from(p, i);
    }
}

fn exit_to_end(p: &mut Program, pos: &mut f64, c: usize, fade: u32, shape: u8) {
    let end = p.defs[c].end as f64;
    begin_fade(p, fade, shape, Some((*pos, p.dir)));
    *pos = end;
    p.dir = 1;
    leave(p, c);
}

/// The key-off (SET_LOOP with `looping` clear) at the playhead `*pos`: held loops let go now.
pub fn release(p: &mut Program, pos: &mut f64) {
    p.released = 1;
    p.want &= !p.held_bits();
    settle(p, pos);
}

/// The region a forward read wraps its neighbours round (the loop `cur` while it will repeat).
fn wrap_of(p: &Program, pos: f64) -> Option<(usize, usize)> {
    let c = p.cur as usize;
    if c >= p.n as usize || p.dir < 0 || p.parked != 0 {
        return None;
    }
    let l = p.defs[c];
    let last_pass = l.count != 0 && p.passes.saturating_add(1) >= l.count;
    (l.direction() == direction::FORWARD && !l.hold() && p.armed(c) && !last_pass && l.xfade == 0 && pos >= l.start as f64).then_some((l.start as usize, l.end as usize))
}

#[inline]
fn sample(samples: &Samples<'_>, index: usize) -> f32 {
    match *samples {
        Samples::F32(s) => s.get(index).copied().unwrap_or(0.0),
        Samples::I16(s) => s.get(index).map_or(0.0, |&v| v as f32 / 32768.0),
    }
}

/// A 4-point Lagrange read of `src` at `pos` (channel 0 and 1; a mono or wide clip's channel 0 to
/// both), neighbours held at the clip's edges or wrapped round `wrap`; silence outside the clip.
fn read(src: &Source<'_>, pos: f64, wrap: Option<(usize, usize)>) -> (f32, f32) {
    let ch = src.channels.max(1) as usize;
    let len = match src.samples {
        Samples::F32(s) => s.len(),
        Samples::I16(s) => s.len(),
    };
    let frames = (src.frames as usize).min(len / ch);
    if frames == 0 || !(pos >= 0.0) || pos >= frames as f64 {
        return (0.0, 0.0);
    }
    let last = frames - 1;
    let idx = (pos as usize).min(last);
    let t = (pos - idx as f64) as f32;
    let at = |d: isize| -> usize {
        let j = idx as isize + d;
        if let Some((s, e)) = wrap {
            if idx < e && j >= e as isize && e > s {
                return s + (j as usize - e) % (e - s);
            }
        }
        j.clamp(0, last as isize) as usize
    };
    let j = [at(-1), idx, at(1), at(2)];
    let w = weights(t);
    let l = w[0] * sample(&src.samples, j[0] * ch) + w[1] * sample(&src.samples, j[1] * ch) + w[2] * sample(&src.samples, j[2] * ch) + w[3] * sample(&src.samples, j[3] * ch);
    if ch == 2 {
        let r = w[0] * sample(&src.samples, j[0] * 2 + 1) + w[1] * sample(&src.samples, j[1] * 2 + 1) + w[2] * sample(&src.samples, j[2] * 2 + 1) + w[3] * sample(&src.samples, j[3] * 2 + 1);
        (l, r)
    } else {
        (l, l)
    }
}

/// Renders `steps.len()` frames of a mixed voice playing program `p` from `*pos` into `out_l`,
/// `out_r`: the main reader (silent while parked) and the fading tail, equal power.
pub fn render(p: &mut Program, src: &Source<'_>, pos: &mut f64, steps: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
    let mut i = 0usize;
    while i < steps.len() {
        // A run of frames that reach no boundary (no fade, not parked, forward) goes through the block kernel, whose
        // position arithmetic is `step`'s there; the frames near a seam (its neighbours) and past it go one by one.
        if p.fade_left == 0 && p.parked == 0 && p.dir > 0 {
            let c = p.cur as usize;
            let bound = if c < p.n as usize {
                let d = p.defs[c];
                if d.hold() { d.start as f64 } else { d.end as f64 }
            } else {
                src.frames as f64
            };
            let (mut k, mut q) = (0usize, *pos);
            while i + k < steps.len() && q < bound - 3.0 && q + (steps[i + k] as f64) < bound {
                q += steps[i + k] as f64;
                k += 1;
            }
            if k > 0 {
                audio_dsp::resample::lagrange(src, pos, &steps[i..i + k], false, &mut out_l[i..i + k], &mut out_r[i..i + k]);
                i += k;
                continue;
            }
        }
        render_frame(p, src, pos, steps[i], &mut out_l[i], &mut out_r[i]);
        i += 1;
    }
}

/// One frame of [`render`], read and stepped through the program.
#[inline]
fn render_frame(p: &mut Program, src: &Source<'_>, pos: &mut f64, st: f32, out_l: &mut f32, out_r: &mut f32) {
    {
        let (mut l, mut r) = if p.parked != 0 { (0.0, 0.0) } else { read(src, *pos, wrap_of(p, *pos)) };
        if p.fade_left > 0 && p.fade_len > 0 {
            let u = 1.0 - p.fade_left as f32 / p.fade_len as f32;
            let (gm, gt) = audio_dsp::fade_shapes::crossfade(p.fade_shape, u);
            l *= gm;
            r *= gm;
            if p.tail_on != 0 {
                let (tl, tr) = read(src, p.tail_pos, None);
                l += tl * gt;
                r += tr * gt;
            }
        }
        *out_l = l;
        *out_r = r;
        step(p, pos, st);
    }
}

/// A virtual voice's time through program `p` (no reads).
pub fn advance(p: &mut Program, pos: &mut f64, steps: &[f32]) {
    for &st in steps {
        step(p, pos, st);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use audio_dsp::equal_power::{cos_quarter, sin_quarter};

    fn def(start: u32, end: u32, dir: u8, act: u8, exit_: u8, count: u16) -> LoopDef {
        LoopDef { start, end, count, flags: dir as u16 | (act as u16) << flags::ACTIVE_SHIFT | (exit_ as u16) << flags::EXIT_SHIFT, ..LoopDef::default() }
    }

    fn run(p: &mut Program, pos: &mut f64, frames: usize) -> Vec<f64> {
        (0..frames)
            .map(|_| {
                let at = *pos;
                step(p, pos, 1.0);
                at
            })
            .collect()
    }

    #[test]
    fn a_forward_loop_repeats_its_count_then_plays_on() {
        let mut p = Program::default();
        load(&mut p, &[def(10, 20, direction::FORWARD, active::ALWAYS, exit::FINISH, 3)], 1, 0.0);
        let mut pos = 0.0;
        let seen = run(&mut p, &mut pos, 45);
        // 0..20, then 10..20 twice more (3 passes in all), then on from 20.
        let want: Vec<f64> = (0..20).chain(10..20).chain(10..20).chain(20..25).map(|f| f as f64).collect();
        assert_eq!(seen, want);
        assert_eq!(p.cur, 1);
    }

    #[test]
    fn a_ping_pong_loop_turns_at_both_ends() {
        let mut p = Program::default();
        load(&mut p, &[def(4, 8, direction::PING_PONG, active::ALWAYS, exit::FINISH, 0)], 1, 0.0);
        let mut pos = 0.0;
        let seen = run(&mut p, &mut pos, 20);
        let want = [0., 1., 2., 3., 4., 5., 6., 7., 8., 7., 6., 5., 4., 5., 6., 7., 8., 7., 6., 5.];
        // Step 1 from 7 lands on 8 (its end): turned back, reflected to 8 - 0 = 8.
        assert_eq!(seen, want);
    }

    #[test]
    fn a_backward_loop_plays_its_region_reversed_then_leaves_forward_from_its_end() {
        let mut p = Program::default();
        load(&mut p, &[def(4, 8, direction::BACKWARD, active::ALWAYS, exit::FINISH, 3)], 1, 0.0);
        let mut pos = 0.0;
        let seen = run(&mut p, &mut pos, 22);
        // Forward to 8 (pass 1), back 8..4 wrapping to 8 (pass 2), back again (pass 3), then on from 8 forward.
        let want = [0., 1., 2., 3., 4., 5., 6., 7., 8., 7., 6., 5., 4., 7., 6., 5., 4., 8., 9., 10., 11., 12.];
        assert_eq!(&seen[..9], &want[..9]);
        assert_eq!(p.cur, 1, "left after its passes");
        assert!(seen.iter().skip(17).all(|&f| f >= 8.0));
    }

    #[test]
    fn a_held_loop_finishes_its_pass_on_release_and_a_jump_leaves_at_once() {
        let mut p = Program::default();
        load(&mut p, &[def(10, 20, direction::FORWARD, active::HELD, exit::FINISH, 0)], 1, 0.0);
        let mut pos = 0.0;
        run(&mut p, &mut pos, 25); // in its second pass, at 15
        assert_eq!(pos, 15.0);
        release(&mut p, &mut pos);
        assert_eq!(pos, 15.0, "finish: no jump");
        let seen = run(&mut p, &mut pos, 10);
        assert_eq!(seen, (15..25).map(|f| f as f64).collect::<Vec<_>>());

        let mut p = Program::default();
        load(&mut p, &[LoopDef { xfade: 4, ..def(10, 20, direction::FORWARD, active::HELD, exit::JUMP, 0) }], 1, 0.0);
        let mut pos = 0.0;
        run(&mut p, &mut pos, 25);
        release(&mut p, &mut pos);
        assert_eq!(pos, 20.0, "jump: to the loop's end");
        assert_eq!((p.tail_on, p.fade_left, p.tail_pos), (1, 4, 15.0), "the old pass fades out as a tail");
    }

    #[test]
    fn a_hold_point_parks_until_let_go() {
        let mut p = Program::default();
        load(&mut p, &[LoopDef { xfade: 2, ..def(5, 5, direction::FORWARD, active::HELD, exit::FINISH, 0) }], 1, 0.0);
        let mut pos = 0.0;
        run(&mut p, &mut pos, 12);
        assert_eq!((pos, p.parked), (5.0, 1));
        release(&mut p, &mut pos);
        assert_eq!(p.parked, 0);
        assert_eq!((p.fade_left, p.tail_on), (2, 0), "fades in from the hold point");
        let seen = run(&mut p, &mut pos, 3);
        assert_eq!(seen, [5.0, 6.0, 7.0]);
    }

    #[test]
    fn a_parameter_loop_exits_by_crossfade_and_re_enters() {
        let reenter = flags::REENTER;
        let mut p = Program::default();
        let mut d = def(10, 20, direction::FORWARD, active::PARAMETER, exit::CROSSFADE, 0);
        d.flags |= reenter;
        d.exit_fade = 8;
        d.xfade = 3;
        load(&mut p, &[d], 1, 0.0);
        let mut pos = 0.0;
        run(&mut p, &mut pos, 25);
        p.want = 0;
        settle(&mut p, &mut pos);
        assert_eq!((pos, p.fade_len, p.cur), (20.0, 8, 1));
        run(&mut p, &mut pos, 10);
        assert_eq!(pos, 30.0);
        p.want = 1;
        settle(&mut p, &mut pos);
        assert_eq!((pos, p.cur, p.fade_len), (10.0, 0, 3), "back to its start");
        // Without re-entry it stays left.
        let mut p = Program::default();
        load(&mut p, &[def(10, 20, direction::FORWARD, active::PARAMETER, exit::JUMP, 0)], 0, 0.0);
        let mut pos = 0.0;
        run(&mut p, &mut pos, 25);
        p.want = 1;
        settle(&mut p, &mut pos);
        assert_eq!(pos, 25.0);
    }

    #[test]
    fn several_loops_play_in_order_and_seeking_places_the_program() {
        let mut p = Program::default();
        load(&mut p, &[def(20, 30, direction::FORWARD, active::ALWAYS, exit::FINISH, 2), def(0, 10, direction::FORWARD, active::ALWAYS, exit::FINISH, 2)], 3, 0.0);
        assert_eq!((p.defs[0].start, p.defs[1].start), (0, 20), "sorted by start");
        let mut pos = 0.0;
        let seen = run(&mut p, &mut pos, 50);
        let want: Vec<f64> = (0..10).chain(0..10).chain(10..30).chain(20..30).map(|f| f as f64).collect();
        assert_eq!(&seen[..50], &want[..50]);
        place(&mut p, 25.0);
        assert_eq!((p.cur, p.done), (1, 1), "a seek into the second loop passes the first");
    }

    #[test]
    fn a_crossfade_reads_the_tail_against_the_loop_in_equal_power() {
        let clip: Vec<f32> = (0..64).map(|i| i as f32).collect();
        let src = Source { samples: Samples::F32(&clip), channels: 1, frames: 64 };
        let mut p = Program::default();
        load(&mut p, &[LoopDef { xfade: 4, ..def(8, 16, direction::FORWARD, active::ALWAYS, exit::FINISH, 0) }], 1, 0.0);
        let mut pos = 0.0;
        let (mut l, mut r) = (vec![0.0; 24], vec![0.0; 24]);
        render(&mut p, &src, &mut pos, &[1.0; 24], &mut l, &mut r);
        assert_eq!(l[15], 15.0);
        // Frame 16: the seam. Main at 8 fading in (u = 0), tail at 16 fading out.
        assert!((l[16] - 16.0).abs() < 1e-4, "{}", l[16]);
        let u = 0.5f32;
        assert!((l[18] - (10.0 * sin_quarter(u) + 18.0 * cos_quarter(u))).abs() < 1e-3, "{}", l[18]);
        assert_eq!(l[20], 12.0, "after the fade, the loop alone");
        assert_eq!(l, r);
    }

    /// ABI 4.9: the seam takes the loop's seam shape, the exit crossfade its exit shape.
    #[test]
    fn a_shaped_seam_and_exit_read_their_shapes_at_mid_crossfade() {
        let clip: Vec<f32> = (0..64).map(|i| i as f32).collect();
        let src = Source { samples: Samples::F32(&clip), channels: 1, frames: 64 };
        let linear = wire::FADE_SHAPE_LINEAR as u16;
        let s_curve = wire::FADE_SHAPE_S_CURVE as u16;
        let shapes = linear << wire::LOOP_SEAM_SHAPE_SHIFT | s_curve << wire::LOOP_EXIT_SHAPE_SHIFT;
        let mut p = Program::default();
        load(&mut p, &[LoopDef { xfade: 4, exit_fade: 4, shapes, ..def(8, 16, direction::FORWARD, active::HELD, exit::CROSSFADE, 0) }], 1, 0.0);
        let mut pos = 0.0;
        let (mut l, mut r) = (vec![0.0; 24], vec![0.0; 24]);
        render(&mut p, &src, &mut pos, &[1.0; 24], &mut l, &mut r);
        // Frame 18 is mid-seam (u = 0.5): linear, 0.5 of the loop's start (10) and 0.5 of the tail (18),
        // where equal power would read 0.707 of each.
        assert!((l[18] - (10.0 * 0.5 + 18.0 * 0.5)).abs() < 1e-3, "{}", l[18]);
        // The loop is let go: it exits to its end through an s-curve crossfade, the audio it left
        // reading on as the tail.
        let before = pos;
        p.want = 0;
        settle(&mut p, &mut pos);
        assert_eq!(pos, 16.0);
        let (mut l, mut r) = (vec![0.0; 4], vec![0.0; 4]);
        render(&mut p, &src, &mut pos, &[1.0; 4], &mut l, &mut r);
        let s = |u: f32| u * u * (3.0 - 2.0 * u);
        for (k, u) in [(1usize, 0.25f32), (2, 0.5)] {
            let want = (16.0 + k as f64) as f32 * s(u) + (before + k as f64) as f32 * (1.0 - s(u));
            assert!((l[k] - want).abs() < 1e-3, "frame {k}: {} vs {want}", l[k]);
        }
        assert!((s(0.25) - 0.15625).abs() < 1e-6, "not equal power's sin(π/8) = 0.383");
        assert_eq!(l, r);
    }
}
