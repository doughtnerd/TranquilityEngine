//! The offline bake: a raw source clip baked onto another skeleton equals the runtime retarget of
//! each frame, keeps its keyed tracks, and compresses within the compressor's bound.

mod common;

use anim_format::clip::{Binding, Clip, ClipView, Key, KeyData, Track, TrackKind, CLIP_LOOP};
use anim_format::skeleton::{Bone, Skeleton as SkelFile, SkeletonView};
use anim_format::NONE;
use anim_math::layout::soa_len;
use anim_math::{AosMat3x4, AosTransform, SoaTransform};
use anim_retarget::bake::{bake, compress_baked, BakeError, SkeletonData};
use anim_retarget::{MapSettings, Profile, RetargetMap, RetargetOptions};
use anim_sample::{rest_pose, ClipSampler, Form};
use common::*;

const RATE: f32 = 30.0;
const FRAMES: usize = 16;

/// The rig as a `myco.skel@1` model.
fn skel_file(rig: &Rig) -> SkelFile {
    let model = rig.rest_model();
    let mut inv = vec![AosMat3x4::identity(); rig.n()];
    anim_pose::model::inverse_bind_matrices(&model, &mut inv);
    SkelFile {
        name: NONE,
        profile: NONE,
        mirror_axis: 0,
        strings: rig.names.clone(),
        bones: (0..rig.n())
            .map(|i| {
                let t = rig.rest[i];
                Bone {
                    name: i as u32,
                    parent: rig.parents[i],
                    translation: [t.translation.x, t.translation.y, t.translation.z],
                    rotation: [t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w],
                    scale: [t.scale.x, t.scale.y, t.scale.z],
                    inverse_bind: inv[i].to_rows(),
                }
            })
            .collect(),
        roles: Some(rig.map.to_roles(rig.n())),
        joint_ranges: None,
        mirror: None,
    }
}

/// Frame `f` of the source animation: every bone swinging, the hips travelling.
fn frame(rig: &Rig, f: usize) -> Vec<AosTransform> {
    let mut p = rig.rest.clone();
    let s = f as f32 / FRAMES as f32;
    for (i, t) in p.iter_mut().enumerate() {
        let a = 0.5 * (6.28 * s + 0.4 * i as f32).sin();
        t.rotation = (t.rotation * q(v(1.0, 0.3 * i as f32 % 1.0, 0.2), a)).normalize_or_identity();
    }
    p[0].translation = p[0].translation + v(0.05 * s, -0.03 * (6.28 * s).sin().abs(), 1.2 * s);
    p
}

fn source_clip(rig: &Rig) -> Vec<u8> {
    let frames: Vec<Vec<AosTransform>> = (0..FRAMES).map(|f| frame(rig, f)).collect();
    let mut tracks: Vec<Track> = (0..rig.n())
        .map(|b| Track {
            kind: TrackKind::Bone,
            flags: 0,
            subtype: 0,
            binding: Binding::bone(b as u32),
            raw: frames
                .iter()
                .flat_map(|p| {
                    let t = p[b];
                    [
                        t.translation.x, t.translation.y, t.translation.z, t.rotation.x, t.rotation.y,
                        t.rotation.z, t.rotation.w, t.scale.x, t.scale.y, t.scale.z,
                    ]
                })
                .collect(),
            keys: Vec::new(),
        })
        .collect();
    tracks.push(Track {
        kind: TrackKind::Event,
        flags: 0,
        subtype: 0,
        binding: Binding::none(),
        raw: Vec::new(),
        keys: vec![Key {
            time: 0.2,
            end: 0.2,
            data: KeyData::Event {
                method: 0,
                args: NONE,
                threshold: 0.0,
                always: false,
            },
        }],
    });
    Clip {
        flags: CLIP_LOOP,
        name: 1,
        duration: (FRAMES - 1) as f32 / RATE,
        sample_rate: RATE,
        frame_count: FRAMES as u32,
        bone_count: rig.n() as u32,
        root_bone: 0,
        strings: vec!["onStep".to_string(), "Walk".to_string()],
        tracks,
        has_raw: true,
        root_curve: None,
        compressed: None,
    }
    .write()
    .unwrap()
}

#[test]
fn bake_matches_runtime_and_compresses() {
    let src = humanoid(Build::default());
    let tgt = humanoid(Build {
        leg: 1.2,
        axes: Axes::XAlong,
        arm_drop: 0.5,
        spine: 4,
        ..Build::default()
    });
    // Read the skeletons back from files, as the editor's bake does.
    let src_bytes = skel_file(&src).write().unwrap();
    let tgt_file = skel_file(&tgt);
    let tgt_bytes = tgt_file.write().unwrap();
    let sd = SkeletonData::from_view(&SkeletonView::parse(&src_bytes).unwrap());
    let td = SkeletonData::from_view(&SkeletonView::parse(&tgt_bytes).unwrap());
    assert_eq!(sd.names, src.names);
    assert_eq!(sd.parents, src.parents);
    let p = Profile::humanoid();
    let smap = anim_retarget::BoneMap::from_roles(sd.roles.as_ref().unwrap(), p.roles.len());
    let tmap = anim_retarget::guess_bone_map(&td.name_refs(), &td.parents, &p);
    let map = RetargetMap::new(
        anim_retarget::Side { skeleton: sd.skeleton(), profile: &p, map: &smap },
        anim_retarget::Side { skeleton: td.skeleton(), profile: &p, map: &tmap },
        &MapSettings::default(),
    )
    .unwrap();

    let clip_bytes = source_clip(&src);
    let view = ClipView::parse(&clip_bytes).unwrap();
    let weights = [0.0, 0.0, 1.0, 1.0];
    let opts = RetargetOptions { ik_weights: &weights, ..RetargetOptions::default() };
    let baked = bake(&map, &view, &sd.rest, &opts).unwrap();
    assert_eq!(baked.dropped_tracks, 0);
    let bytes = baked.clip.write().unwrap();
    let out = ClipView::parse(&bytes).unwrap();
    assert_eq!(out.frame_count(), FRAMES as u32);
    assert_eq!(out.sample_rate(), RATE);
    assert_eq!(out.duration(), view.duration());
    assert_eq!(out.flags(), CLIP_LOOP);
    assert_eq!(out.bone_count() as usize, tgt.n());
    assert_eq!(out.root_bone(), 0, "the target hips carries root motion");
    assert_eq!(out.strings().get(out.name()), Some("Walk"));
    let ev = (0..out.track_count()).find(|&i| out.track(i).unwrap().kind == TrackKind::Event).unwrap();
    let keys: Vec<Key> = out.track_keys(ev).collect();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].time, 0.2);

    // Each baked frame equals the runtime retarget of the source frame (the bake samples at
    // f / rate, which can land a hair before frame f: tolerance 1e-5).
    let s_sampler = ClipSampler::new(view, Form::Raw).unwrap();
    let t_sampler = ClipSampler::new(out, Form::Raw).unwrap();
    let mut t_rest = vec![AosTransform::identity(); tgt.n()];
    assert!(rest_pose(&SkeletonView::parse(&tgt_bytes).unwrap(), &mut t_rest));
    let mut scratch = map.scratch();
    let mut sscr = vec![AosTransform::identity(); s_sampler.scratch_len()];
    let mut tscr = vec![AosTransform::identity(); t_sampler.scratch_len()];
    let mut sp = vec![SoaTransform::identity(); soa_len(src.n())];
    let mut want = vec![SoaTransform::identity(); soa_len(tgt.n())];
    let mut got = want.clone();
    for f in 0..FRAMES {
        let t = f as f32 / RATE;
        s_sampler.sample_pose(t, &sd.rest, &mut sscr, &mut sp, None).unwrap();
        map.retarget(&sp, &opts, &mut scratch, &mut want).unwrap();
        t_sampler.sample_pose(t, &t_rest, &mut tscr, &mut got, None).unwrap();
        let (w, g) = (aos(&want, tgt.n()), aos(&got, tgt.n()));
        for b in 0..tgt.n() {
            assert!(quat_close(w[b].rotation, g[b].rotation, 1e-5), "frame {f} bone {b}");
            assert!((w[b].translation - g[b].translation).length() < 1e-5, "frame {f} bone {b}");
        }
    }

    // Compressed: model-space joints within 1 mm of the raw bake (the compressor's bound is
    // 0.1 mm at the shell distance).
    let comp = compress_baked(&baked, &tgt_file, &anim_compress::Settings::default()).unwrap();
    assert!(comp.report.within_bounds);
    let cview = ClipView::parse(&comp.bytes).unwrap();
    let c_sampler = ClipSampler::new(cview, Form::Compressed).unwrap();
    let mut cscr = vec![AosTransform::identity(); c_sampler.scratch_len()];
    let mut cp = want.clone();
    for f in 0..FRAMES {
        let t = f as f32 / RATE;
        t_sampler.sample_pose(t, &t_rest, &mut tscr, &mut got, None).unwrap();
        c_sampler.sample_pose(t, &t_rest, &mut cscr, &mut cp, None).unwrap();
        let gm = model(&tgt.parents, &aos(&got, tgt.n()));
        let cm = model(&tgt.parents, &aos(&cp, tgt.n()));
        for b in 0..tgt.n() {
            assert!((gm[b].translation - cm[b].translation).length() < 1e-3, "frame {f} bone {b}");
        }
    }

    // A compressed source bakes too (sampled through its compressed form).
    let src_comp = anim_compress::compress(&view.to_clip(), Some(&skel_file(&src)), &anim_compress::Settings::default()).unwrap();
    let sview = ClipView::parse(&src_comp.bytes).unwrap();
    let baked2 = bake(&map, &sview, &sd.rest, &opts).unwrap();
    assert_eq!(baked2.clip.frame_count, FRAMES as u32);
}

#[test]
fn bake_refuses_a_clip_for_another_skeleton() {
    let src = humanoid(Build::default());
    let other = humanoid(Build { spine: 1, ..Build::default() });
    let p = Profile::humanoid();
    let map = RetargetMap::new(src.side(&p), src.side(&p), &MapSettings::default()).unwrap();
    let bytes = source_clip(&other);
    let view = ClipView::parse(&bytes).unwrap();
    assert_eq!(bake(&map, &view, &other.rest, &RetargetOptions::default()), Err(BakeError::BoneCount));
    let bytes = source_clip(&src);
    let view = ClipView::parse(&bytes).unwrap();
    assert_eq!(bake(&map, &view, &other.rest, &RetargetOptions::default()), Err(BakeError::RestLength));
}
