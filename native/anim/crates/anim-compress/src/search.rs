//! The bit-rate search and the writer: [`compress`].

use crate::bits::BitWriter;
use crate::channels::{self, apply_bone_value, local_error, quantize, Chan, Quantized};
use crate::root;
use crate::settings::{CompressError, Output, Report, Settings, TrackError, DEFAULT_SHELL_DISTANCE};
use crate::BIT_RATES;
use anim_format::clip::{
    self, Channel, ChannelMode, Clip, ClipView, Compressed, RotationFormat, Segment, TrackKind,
    TRACK_CONSTANT, TRACK_DEFAULT,
};
use anim_format::skeleton::Skeleton;
use anim_format::NONE;
use anim_offline::math::{local_to_model, Quat, Transform, NO_PARENT};
use anim_offline::sample::{transform_from, vertex_error};

/// Below this `w` (after the `w ≥ 0` fix, about 168°) drop-w loses enough precision that the
/// automatic choice also tries full rotations and keeps the smaller result.
const DROP_W_MIN_W: f64 = 0.1;

/// Everything the search needs that doesn't depend on the rotation format.
struct Ctx<'a> {
    clip: &'a Clip,
    settings: &'a Settings,
    raws: Vec<Vec<f32>>,
    frames: u32,
    rest: Vec<Transform>,
    parents: Vec<u16>,
    shells: Vec<f64>,
    /// Raw local pose per frame (empty without bone tracks).
    raw_local: Vec<Vec<Transform>>,
    /// Raw model-space pose per frame (empty without bone tracks).
    raw_model: Vec<Vec<Transform>>,
    ladder: Vec<u8>,
    bound: f64,
}

/// The search's result for one rotation format.
struct Solved {
    chans: Vec<Chan>,
    /// Animated channel indices into `chans`, in animated order.
    anim: Vec<usize>,
    /// Per segment, per animated channel: the chosen quantisation and its rate.
    segs: Vec<Vec<(u8, Quantized)>>,
    bone_error: (f64, Option<(u32, u32)>),
    tracks: Vec<TrackError>,
    /// A bone whose error the search couldn't bring under the bound even with every animated
    /// channel on its chain at the top rate, while a default or constant channel sits there.
    stuck: Option<u32>,
}

impl Solved {
    fn within(&self, ctx: &Ctx<'_>) -> bool {
        self.bone_error.0 <= ctx.bound && self.tracks.iter().all(|t| t.error <= t.bound)
    }

    fn size(&self) -> usize {
        let mut n = 16 * self.chans.len();
        for c in &self.chans {
            n += 4 * (c.constant.len() + c.clip_min.len() * 2);
        }
        for seg in &self.segs {
            let mut bits = 0u64;
            for (rate, q) in seg {
                n += 1 + 2 * q.ranges.len();
                bits += *rate as u64 * q.codes.len() as u64;
            }
            n += bits.div_ceil(8) as usize;
        }
        n
    }
}

/// Compresses `clip`'s raw form with `skeleton` (required when the clip has bone tracks) and
/// `settings`, returning the clip with its compressed form, its bytes and the report.
pub fn compress(
    clip: &Clip,
    skeleton: Option<&Skeleton>,
    settings: &Settings,
) -> Result<Output, CompressError> {
    check_settings(settings)?;
    let sampled = clip.tracks.iter().any(|t| t.kind.is_sampled());
    if sampled && !clip.has_raw {
        return Err(CompressError::NoRawForm);
    }
    let has_bones = clip.tracks.iter().any(|t| t.kind == TrackKind::Bone);
    let (rest, parents) = match skeleton {
        Some(s) => {
            if s.bones.len() != clip.bone_count as usize {
                return Err(CompressError::SkeletonMismatch);
            }
            let rest: Vec<Transform> = s
                .bones
                .iter()
                .map(|b| {
                    transform_from(&[
                        b.translation[0],
                        b.translation[1],
                        b.translation[2],
                        b.rotation[0],
                        b.rotation[1],
                        b.rotation[2],
                        b.rotation[3],
                        b.scale[0],
                        b.scale[1],
                        b.scale[2],
                    ])
                })
                .collect();
            (rest, s.bones.iter().map(|b| b.parent).collect::<Vec<u16>>())
        }
        None if has_bones => return Err(CompressError::SkeletonMismatch),
        None => (Vec::new(), Vec::new()),
    };
    if let Some(m) = settings.root_motion {
        if !has_bones || m.bone as usize >= rest.len() {
            return Err(CompressError::BadSetting("root motion bone"));
        }
    }
    let shells = shell_distances(&rest, &parents, settings.shell_distance);
    let rate = settings.sample_rate.unwrap_or(clip.sample_rate);
    let (frames, raws) = channels::resample(clip, rate);

    let raw_local: Vec<Vec<Transform>> = if has_bones {
        (0..frames as usize)
            .map(|f| {
                let mut local = rest.clone();
                for (ti, t) in clip.tracks.iter().enumerate() {
                    if t.kind == TrackKind::Bone {
                        local[t.binding.bone as usize] =
                            transform_from(&raws[ti][f * 10..f * 10 + 10]);
                    }
                }
                local
            })
            .collect()
    } else {
        Vec::new()
    };
    let raw_model = raw_local
        .iter()
        .map(|l| local_to_model(&parents, l))
        .collect();

    let ladder: Vec<u8> = BIT_RATES
        .iter()
        .copied()
        .filter(|&r| r <= settings.max_bit_rate)
        .collect();
    let ctx = Ctx {
        clip,
        settings,
        raws,
        frames,
        rest,
        parents,
        shells,
        raw_local,
        raw_model,
        ladder,
        bound: settings.error as f64,
    };

    let formats: Vec<RotationFormat> = match settings.rotation_format {
        Some(f) => vec![f],
        None if min_rotation_w(&ctx) < DROP_W_MIN_W => {
            vec![RotationFormat::QuatDropW, RotationFormat::QuatFull]
        }
        None => vec![RotationFormat::QuatDropW],
    };
    let mut best: Option<(RotationFormat, Solved)> = None;
    for f in formats {
        let s = solve(&ctx, f);
        // Prefer meeting the bound, then the smaller result.
        let better = match &best {
            None => true,
            Some((_, b)) => (!s.within(&ctx), s.size()) < (!b.within(&ctx), b.size()),
        };
        if better {
            best = Some((f, s));
        }
    }
    let (format, solved) = best.expect("at least one format");
    write(&ctx, rate, format, solved)
}

fn check_settings(s: &Settings) -> Result<(), CompressError> {
    if !(s.error.is_finite() && s.error > 0.0) {
        return Err(CompressError::BadSetting("error"));
    }
    if !(s.property_error.is_finite() && s.property_error > 0.0) {
        return Err(CompressError::BadSetting("property error"));
    }
    if s.track_errors.iter().any(|&(_, e)| !(e.is_finite() && e > 0.0)) {
        return Err(CompressError::BadSetting("track error"));
    }
    if s.shell_distance.is_some_and(|d| !(d.is_finite() && d > 0.0)) {
        return Err(CompressError::BadSetting("shell distance"));
    }
    if !clip::is_valid_bit_rate(s.max_bit_rate) {
        return Err(CompressError::BadSetting("max bit rate"));
    }
    if s.sample_rate.is_some_and(|r| !(r.is_finite() && r > 0.0)) {
        return Err(CompressError::BadSetting("sample rate"));
    }
    if s.segment_frames == 0 {
        return Err(CompressError::BadSetting("segment frames"));
    }
    Ok(())
}

/// `max(3 cm, longest child offset)` per bone, or the override.
fn shell_distances(rest: &[Transform], parents: &[u16], fixed: Option<f32>) -> Vec<f64> {
    if let Some(d) = fixed {
        return vec![d as f64; rest.len()];
    }
    let mut shells = vec![DEFAULT_SHELL_DISTANCE as f64; rest.len()];
    for (i, &p) in parents.iter().enumerate() {
        if p != NO_PARENT {
            let len = rest[i].translation.length();
            let s = &mut shells[p as usize];
            *s = s.max(len);
        }
    }
    shells
}

fn min_rotation_w(ctx: &Ctx<'_>) -> f64 {
    let mut min = 1.0f64;
    for (ti, t) in ctx.clip.tracks.iter().enumerate() {
        if t.kind != TrackKind::Bone {
            continue;
        }
        for f in ctx.raws[ti].chunks(10) {
            let q = Quat::new(f[3] as f64, f[4] as f64, f[5] as f64, f[6] as f64)
                .normalize_or_identity();
            min = min.min(q.w.abs());
        }
    }
    min
}

fn solve(ctx: &Ctx<'_>, format: RotationFormat) -> Solved {
    let property_bound = |track: u32| {
        ctx.settings
            .track_errors
            .iter()
            .rev()
            .find(|(t, _)| *t == track)
            .map_or(ctx.settings.property_error, |&(_, e)| e) as f64
    };
    let property_default = |track: u32| {
        ctx.settings
            .property_defaults
            .iter()
            .rev()
            .find(|(t, _)| *t == track)
            .map(|(_, v)| v.clone())
    };
    let mut chans = channels::build(
        ctx.clip,
        &ctx.raws,
        ctx.frames,
        &ctx.rest,
        &ctx.shells,
        format,
        ctx.bound,
        property_bound,
        property_default,
    );
    screen(ctx, format, &mut chans);
    loop {
        let solved = search(ctx, format, chans);
        // A default or constant channel can break the bound (its error adds up along a chain, or
        // the search can't raise it): make the worst one animated and search again.
        let mut demote: Option<usize> = None;
        let mut worst_dev = -1.0;
        let stuck = solved.stuck.or_else(|| {
            (solved.bone_error.0 > ctx.bound)
                .then_some(solved.bone_error.1.map(|(b, _)| b))
                .flatten()
        });
        {
            if let Some(bone) = stuck {
                let chain = ancestors(&ctx.parents, bone as usize);
                for (i, c) in solved.chans.iter().enumerate() {
                    if c.mode != ChannelMode::Animated
                        && c.bone.is_some_and(|b| chain.contains(&b))
                        && c.deviation > worst_dev
                    {
                        worst_dev = c.deviation;
                        demote = Some(i);
                    }
                }
            }
        }
        if demote.is_none() {
            for t in &solved.tracks {
                if t.error > t.bound {
                    demote = solved.chans.iter().position(|c| {
                        c.track == t.track && c.bone.is_none() && c.mode != ChannelMode::Animated
                    });
                    if demote.is_some() {
                        break;
                    }
                }
            }
        }
        match demote {
            Some(i) => {
                chans = solved.chans;
                chans[i].make_animated();
            }
            None => return solved,
        }
    }
}

/// The share of the bound one default or constant bone channel may cost on its own, in model
/// space over every descendant; above it the channel is animated instead. Local thresholds alone
/// miss the lever arm of a long chain.
const SCREEN_SHARE: f64 = 0.2;

/// Makes animated every default or constant bone channel whose own model-space error (all else
/// raw) exceeds `SCREEN_SHARE` of the bound; records that error as its deviation.
fn screen(ctx: &Ctx<'_>, format: RotationFormat, chans: &mut [Chan]) {
    let n = ctx.rest.len();
    if ctx.raw_local.is_empty() {
        return;
    }
    let mut model = vec![Transform::IDENTITY; n];
    for c in chans.iter_mut() {
        let Some(cb) = c.bone else { continue };
        if c.mode == ChannelMode::Animated {
            continue;
        }
        let stored: Vec<f64> = match c.mode {
            ChannelMode::Constant => c.constant.iter().map(|&x| x as f64).collect(),
            _ => {
                let r = ctx.rest[cb];
                match c.kind {
                    clip::ChannelKind::Rotation => {
                        let q = if r.rotation.w < 0.0 { -r.rotation } else { r.rotation };
                        let mut v = vec![q.x, q.y, q.z];
                        if format == RotationFormat::QuatFull {
                            v.push(q.w);
                        }
                        v
                    }
                    clip::ChannelKind::Translation => {
                        vec![r.translation.x, r.translation.y, r.translation.z]
                    }
                    _ => vec![r.scale.x, r.scale.y, r.scale.z],
                }
            }
        };
        let mut worst = 0.0f64;
        for f in 0..ctx.frames as usize {
            let local = &ctx.raw_local[f];
            let raw = &ctx.raw_model[f];
            let mut l = local[cb];
            apply_bone_value(&mut l, c.kind, &stored, format);
            let p = ctx.parents[cb];
            model[cb] = if p == NO_PARENT { l } else { raw[p as usize].compose(l) };
            worst = worst.max(vertex_error(raw[cb], model[cb], ctx.shells[cb]));
            // Descendants come after `cb`; a bone is one when its parent is `cb` or one.
            let mut changed = vec![false; n];
            changed[cb] = true;
            for i in cb + 1..n {
                let p = ctx.parents[i];
                if p != NO_PARENT && changed[p as usize] {
                    changed[i] = true;
                    model[i] = model[p as usize].compose(local[i]);
                    worst = worst.max(vertex_error(raw[i], model[i], ctx.shells[i]));
                }
            }
        }
        c.deviation = worst;
        if worst > ctx.bound * SCREEN_SHARE {
            c.make_animated();
        }
    }
}

/// `bone` and its ancestors, root first.
fn ancestors(parents: &[u16], bone: usize) -> Vec<usize> {
    let mut chain = vec![bone];
    let mut b = bone;
    while parents[b] != NO_PARENT {
        b = parents[b] as usize;
        chain.push(b);
    }
    chain.reverse();
    chain
}

/// Quantisations of one animated channel over one segment, made on demand per ladder step.
struct Memo<'c> {
    chan: &'c Chan,
    start: usize,
    count: usize,
    by_step: Vec<Option<Quantized>>,
}

impl<'c> Memo<'c> {
    fn get(&mut self, ladder: &[u8], step: usize) -> &Quantized {
        let (chan, start, count) = (self.chan, self.start, self.count);
        self.by_step[step].get_or_insert_with(|| quantize(chan, start, count, ladder[step]))
    }
}

fn search(ctx: &Ctx<'_>, format: RotationFormat, chans: Vec<Chan>) -> Solved {
    let anim: Vec<usize> = (0..chans.len())
        .filter(|&i| chans[i].mode == ChannelMode::Animated)
        .collect();
    let frames = ctx.frames as usize;
    let sf = ctx.settings.segment_frames as usize;
    let n_bones = ctx.rest.len();
    let mut bone_error = (0.0f64, None);
    let mut track_err: Vec<(f64, u32)> = vec![(0.0, 0); chans.len()];
    let mut segs = Vec::new();
    let mut stuck: Option<u32> = None;

    // Local pose with defaults and constants applied (animated channels go on top per frame).
    let mut base = ctx.rest.clone();
    for c in &chans {
        if let (Some(b), ChannelMode::Constant) = (c.bone, c.mode) {
            let v: Vec<f64> = c.constant.iter().map(|&x| x as f64).collect();
            apply_bone_value(&mut base[b], c.kind, &v, format);
        }
    }

    // Default and constant property channels: their error is their deviation, frame by frame.
    for (i, c) in chans.iter().enumerate() {
        if c.bone.is_some() || c.mode == ChannelMode::Animated {
            continue;
        }
        let stored: Vec<f64> = if c.mode == ChannelMode::Constant {
            c.constant.iter().map(|&x| x as f64).collect()
        } else {
            let d = ctx
                .settings
                .property_defaults
                .iter()
                .rev()
                .find(|(t, _)| *t == c.track)
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            d.iter().map(|&x| x as f64).collect()
        };
        for f in 0..frames {
            let e = c
                .value(f)
                .iter()
                .zip(&stored)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f64::max);
            if e > track_err[i].0 {
                track_err[i] = (e, f as u32);
            }
        }
    }

    let mut start = 0usize;
    while start < frames {
        let count = sf.min(frames - start);
        let mut memos: Vec<Memo<'_>> = anim
            .iter()
            .map(|&i| Memo {
                chan: &chans[i],
                start,
                count,
                by_step: vec![None; ctx.ladder.len()],
            })
            .collect();
        let top = ctx.ladder.len() - 1;
        let mut steps = vec![top; anim.len()];

        // Each channel's lowest rate meeting the bound on its own.
        for (a, memo) in memos.iter_mut().enumerate() {
            let c = memo.chan;
            for step in 0..ctx.ladder.len() {
                let q = memo.get(&ctx.ladder, step);
                let w = c.width;
                let err = (0..count)
                    .map(|f| {
                        let r = c.value(start + f);
                        let l = &q.decoded[f * w..(f + 1) * w];
                        match c.bone {
                            Some(b) => local_error(c.kind, r, l, format, ctx.shells[b]),
                            None => r.iter().zip(l).map(|(x, y)| (x - y).abs()).fold(0.0, f64::max),
                        }
                    })
                    .fold(0.0, f64::max);
                let bound = if c.bone.is_some() { ctx.bound } else { c.bound };
                if err <= bound {
                    steps[a] = step;
                    break;
                }
            }
        }

        if !ctx.raw_model.is_empty() {
            let mut seg = BoneSeg::new(ctx, format, &chans, &anim, start, count, &base);
            for (a, memo) in memos.iter_mut().enumerate() {
                if chans[anim[a]].bone.is_some() {
                    let q = memo.get(&ctx.ladder, steps[a]).decoded.clone();
                    seg.set_local(a, &q);
                }
            }
            seg.refresh(0);
            if let Some(b) = seg.raise(&mut memos, &mut steps) {
                stuck.get_or_insert(b as u32);
            }
            for b in 0..n_bones {
                let (e, f) = seg.err[b];
                if e > bone_error.0 || bone_error.1.is_none() {
                    bone_error = (e, Some((b as u32, (start + f) as u32)));
                }
            }
        }

        // Property channels' errors at their chosen rates.
        for (a, memo) in memos.iter_mut().enumerate() {
            let i = anim[a];
            let c = &chans[i];
            if c.bone.is_some() {
                continue;
            }
            let q = memo.get(&ctx.ladder, steps[a]);
            for f in 0..count {
                let e = c
                    .value(start + f)
                    .iter()
                    .zip(&q.decoded[f * c.width..(f + 1) * c.width])
                    .map(|(x, y)| (x - y).abs())
                    .fold(0.0, f64::max);
                if e > track_err[i].0 {
                    track_err[i] = (e, (start + f) as u32);
                }
            }
        }

        let chosen = memos
            .iter_mut()
            .zip(&steps)
            .map(|(m, &s)| (ctx.ladder[s], m.get(&ctx.ladder, s).clone()))
            .collect();
        segs.push(chosen);
        start += count;
    }

    let tracks = chans
        .iter()
        .enumerate()
        .filter(|(_, c)| c.bone.is_none())
        .map(|(i, c)| TrackError {
            track: c.track,
            error: track_err[i].0 as f32,
            bound: c.bound as f32,
            frame: track_err[i].1,
        })
        .collect();
    Solved {
        chans,
        anim,
        segs,
        bone_error,
        tracks,
        stuck,
    }
}

/// One segment's bone state: lossy local and model poses per frame and each bone's error.
struct BoneSeg<'a> {
    ctx: &'a Ctx<'a>,
    format: RotationFormat,
    chans: &'a [Chan],
    anim: &'a [usize],
    start: usize,
    count: usize,
    local: Vec<Vec<Transform>>,
    model: Vec<Vec<Transform>>,
    /// Per bone: the largest error over the segment and the frame (within the segment).
    err: Vec<(f64, usize)>,
    /// Per bone: `Σ max(0, e_f − bound)` over the segment's frames.
    excess: Vec<f64>,
    /// Per bone: its animated channels (indices into `anim`).
    bone_anim: Vec<Vec<usize>>,
}

impl<'a> BoneSeg<'a> {
    fn new(
        ctx: &'a Ctx<'a>,
        format: RotationFormat,
        chans: &'a [Chan],
        anim: &'a [usize],
        start: usize,
        count: usize,
        base: &[Transform],
    ) -> Self {
        let n = ctx.rest.len();
        let mut bone_anim = vec![Vec::new(); n];
        for (a, &i) in anim.iter().enumerate() {
            if let Some(b) = chans[i].bone {
                bone_anim[b].push(a);
            }
        }
        BoneSeg {
            ctx,
            format,
            chans,
            anim,
            start,
            count,
            local: vec![base.to_vec(); count],
            model: vec![vec![Transform::IDENTITY; n]; count],
            err: vec![(0.0, 0); n],
            excess: vec![0.0; n],
            bone_anim,
        }
    }

    fn set_local(&mut self, a: usize, decoded: &[f64]) {
        let c = &self.chans[self.anim[a]];
        let b = c.bone.expect("bone channel");
        for f in 0..self.count {
            let v = &decoded[f * c.width..(f + 1) * c.width];
            apply_bone_value(&mut self.local[f][b], c.kind, v, self.format);
        }
    }

    /// Recomputes model poses and errors of bones `from..`.
    fn refresh(&mut self, from: usize) {
        let parents = &self.ctx.parents;
        for f in 0..self.count {
            for i in from..parents.len() {
                let p = parents[i];
                self.model[f][i] = if p == NO_PARENT {
                    self.local[f][i]
                } else {
                    self.model[f][p as usize].compose(self.local[f][i])
                };
            }
        }
        for i in from..parents.len() {
            self.err[i] = (0.0, 0);
            self.excess[i] = 0.0;
            for f in 0..self.count {
                let raw = self.ctx.raw_model[self.start + f][i];
                let e = vertex_error(raw, self.model[f][i], self.ctx.shells[i]);
                if e > self.err[i].0 {
                    self.err[i] = (e, f);
                }
                self.excess[i] += (e - self.ctx.bound).max(0.0);
            }
        }
    }

    /// Bone `b`'s error if animated channel `a` (on `b`'s chain `chain`) took `decoded`.
    /// Returns the largest error and the excess `Σ max(0, e_f − bound)` over the frames.
    fn eval(&self, b: usize, chain: &[usize], a: usize, decoded: &[f64]) -> (f64, f64) {
        let c = &self.chans[self.anim[a]];
        let cb = c.bone.expect("bone channel");
        let k = chain.iter().position(|&x| x == cb).expect("on the chain");
        let p = self.ctx.parents[cb];
        let mut worst = 0.0f64;
        let mut excess = 0.0f64;
        for f in 0..self.count {
            let mut l = self.local[f][cb];
            apply_bone_value(&mut l, c.kind, &decoded[f * c.width..(f + 1) * c.width], self.format);
            let mut m = if p == NO_PARENT {
                l
            } else {
                self.model[f][p as usize].compose(l)
            };
            for &j in &chain[k + 1..] {
                m = m.compose(self.local[f][j]);
            }
            let raw = self.ctx.raw_model[self.start + f][b];
            let e = vertex_error(raw, m, self.ctx.shells[b]);
            worst = worst.max(e);
            excess += (e - self.ctx.bound).max(0.0);
        }
        (worst, excess)
    }

    /// Bone `b`'s error with every animated channel on its chain at the top rate.
    fn floor(&self, b: usize, chain: &[usize], memos: &mut [Memo<'_>]) -> f64 {
        let ladder = &self.ctx.ladder;
        let top = ladder.len() - 1;
        let mut worst = 0.0f64;
        for f in 0..self.count {
            let mut m = Transform::IDENTITY;
            for &cb in chain {
                let mut l = self.local[f][cb];
                for &a in &self.bone_anim[cb] {
                    let c = &self.chans[self.anim[a]];
                    let q = memos[a].get(ladder, top);
                    apply_bone_value(&mut l, c.kind, &q.decoded[f * c.width..(f + 1) * c.width], self.format);
                }
                m = if self.ctx.parents[cb] == NO_PARENT { l } else { m.compose(l) };
            }
            let raw = self.ctx.raw_model[self.start + f][b];
            worst = worst.max(vertex_error(raw, m, self.ctx.shells[b]));
        }
        worst
    }

    /// The greedy pass: while a bone's error exceeds the bound, raise the channel on its chain
    /// whose next rate lowers that error most (ties: fewer added bits, then the earlier channel).
    /// Returns a bone that can't meet the bound because of a default or constant channel on its
    /// chain (raising the others would only waste bits), if any.
    fn raise(&mut self, memos: &mut [Memo<'_>], steps: &mut [usize]) -> Option<usize> {
        let ladder = &self.ctx.ladder;
        let bound = self.ctx.bound;
        let n = self.ctx.rest.len();
        // Repeats until nothing changes; it ends because every change raises a rate.
        loop {
            let mut changed = false;
            for b in 0..n {
                let chain = ancestors(&self.ctx.parents, b);
                if self.err[b].0 > bound {
                    let fixed = self.chans.iter().any(|c| {
                        c.mode != ChannelMode::Animated && c.bone.is_some_and(|x| chain.contains(&x))
                    });
                    if fixed && self.floor(b, &chain, memos) > bound {
                        return Some(b);
                    }
                }
                while self.err[b].0 > bound {
                    // The best drop of the excess (`Σ max(0, e_f − bound)`, which sees every
                    // frame, not only the worst) per added bit; if no step lowers it, the lowest
                    // (excess, error), so the search always moves. Ties: the earlier channel.
                    let before = self.excess[b];
                    let mut best: Option<(f64, usize)> = None;
                    let mut lowest: Option<((f64, f64), usize)> = None;
                    for &cb in &chain {
                        for &a in &self.bone_anim[cb] {
                            let s = steps[a] + 1;
                            if s >= ladder.len() {
                                continue;
                            }
                            let w = self.chans[self.anim[a]].width as f64;
                            let added = (ladder[s] - ladder[s - 1]) as f64 * w;
                            let (e, x) = self.eval(b, &chain, a, &memos[a].get(ladder, s).decoded);
                            let gain = (before - x) / added;
                            if gain > 0.0 && best.is_none_or(|(g, _)| gain > g) {
                                best = Some((gain, a));
                            }
                            if lowest.is_none_or(|(l, _)| (x, e) < l) {
                                lowest = Some(((x, e), a));
                            }
                        }
                    }
                    let Some(a) = best.map(|b| b.1).or(lowest.map(|l| l.1)) else { break };
                    steps[a] += 1;
                    let q = memos[a].get(ladder, steps[a]).decoded.clone();
                    self.set_local(a, &q);
                    let cb = self.chans[self.anim[a]].bone.expect("bone channel");
                    self.refresh(cb);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        None
    }
}

fn write(
    ctx: &Ctx<'_>,
    rate: f32,
    format: RotationFormat,
    solved: Solved,
) -> Result<Output, CompressError> {
    let Solved {
        chans,
        anim,
        segs,
        bone_error,
        tracks: track_errors,
        ..
    } = solved;
    let mut channels = Vec::with_capacity(chans.len());
    let mut constants = Vec::new();
    let mut clip_ranges = Vec::new();
    let mut counts = [0u32; 3];
    let mut next_animated = 0u32;
    for c in &chans {
        let (data_offset, animated_index) = match c.mode {
            ChannelMode::Default => (NONE, NONE),
            ChannelMode::Constant => {
                let o = constants.len() as u32;
                constants.extend_from_slice(&c.constant);
                (o, NONE)
            }
            ChannelMode::Animated => {
                let o = clip_ranges.len() as u32;
                clip_ranges.extend_from_slice(&c.clip_min);
                clip_ranges.extend_from_slice(&c.clip_ext);
                let a = next_animated;
                next_animated += 1;
                (o, a)
            }
        };
        counts[c.mode.id() as usize] += 1;
        channels.push(Channel {
            track: c.track,
            kind: c.kind,
            mode: c.mode,
            width: c.width as u8,
            data_offset,
            animated_index,
        });
    }

    let sf = ctx.settings.segment_frames;
    let mut segments = Vec::with_capacity(segs.len());
    let mut bit_rates = Vec::new();
    let mut segment_ranges = Vec::new();
    let mut data: Vec<u8> = Vec::new();
    for (s, seg) in segs.iter().enumerate() {
        let start = s as u32 * sf;
        let count = sf.min(ctx.frames - start);
        let mut w = BitWriter::default();
        for f in 0..count as usize {
            for ((rate, q), &i) in seg.iter().zip(&anim) {
                let width = chans[i].width;
                for k in 0..width {
                    w.push(q.codes[f * width + k], *rate as u32);
                }
            }
        }
        for (rate, q) in seg {
            bit_rates.push(*rate);
            for r in &q.ranges {
                segment_ranges.extend_from_slice(r);
            }
        }
        let bits = w.bit_len();
        let mut bytes = w.into_bytes();
        if bits > 0 {
            bytes.resize(bytes.len() + 7, 0);
        }
        let offset = anim_format::align4(data.len());
        data.resize(offset, 0);
        segments.push(Segment {
            start_frame: start,
            frame_count: count,
            data_offset: offset as u32,
            data_size: bytes.len() as u32,
        });
        data.extend_from_slice(&bytes);
    }

    let max_track = track_errors.iter().map(|t| t.error).fold(0.0f32, f32::max);
    let has_bones = chans.iter().any(|c| c.bone.is_some());
    let stored_error = if has_bones {
        bone_error.0 as f32
    } else {
        max_track
    };
    let compressed = Compressed {
        segment_frames: sf,
        rotation_format: format,
        max_error: stored_error,
        channels,
        constants,
        clip_ranges,
        segments,
        bit_rates,
        segment_ranges,
        data,
    };

    let mut out = ctx.clip.clone();
    out.sample_rate = rate;
    out.frame_count = ctx.frames;
    out.has_raw = ctx.settings.keep_raw;
    for (ti, t) in out.tracks.iter_mut().enumerate() {
        if !t.kind.is_sampled() {
            continue;
        }
        t.raw = if ctx.settings.keep_raw {
            ctx.raws[ti].clone()
        } else {
            Vec::new()
        };
        let modes: Vec<ChannelMode> = chans
            .iter()
            .filter(|c| c.track == ti as u32)
            .map(|c| c.mode)
            .collect();
        t.flags = 0;
        if modes.iter().all(|&m| m != ChannelMode::Animated) {
            t.flags |= TRACK_CONSTANT;
        }
        if modes.iter().all(|&m| m == ChannelMode::Default) {
            t.flags |= TRACK_DEFAULT;
        }
    }
    if let Some(m) = ctx.settings.root_motion {
        let model: Vec<Transform> = ctx.raw_model.iter().map(|p| p[m.bone as usize]).collect();
        out.root_bone = m.bone;
        out.root_curve = Some(root::extract(&model, m));
    }
    out.compressed = Some(compressed);
    let bytes = out.write()?;

    let view = ClipView::parse(&bytes)?;
    let compressed_size = [
        clip::section::COMP_INFO,
        clip::section::COMP_CHANNELS,
        clip::section::COMP_CONSTANTS,
        clip::section::COMP_CLIP_RANGES,
        clip::section::COMP_SEGMENTS,
        clip::section::COMP_BIT_RATES,
        clip::section::COMP_SEGMENT_RANGES,
        clip::section::COMP_DATA,
    ]
    .iter()
    .filter_map(|&k| view.section(k))
    .map(|e| e.length as usize)
    .sum();
    let raw_size = ctx
        .clip
        .tracks
        .iter()
        .filter(|t| t.kind.is_sampled())
        .map(|t| anim_format::align4(ctx.frames as usize * t.kind.width() as usize) * 4)
        .sum();
    let within_bounds =
        bone_error.0 <= ctx.bound && track_errors.iter().all(|t| t.error <= t.bound);
    let report = Report {
        raw_size,
        compressed_size,
        file_size: bytes.len(),
        max_error: bone_error.0 as f32,
        worst_bone: bone_error.1,
        tracks: track_errors,
        rotation_format: format,
        channels: counts,
        within_bounds,
    };
    Ok(Output {
        clip: out,
        bytes,
        report,
    })
}
