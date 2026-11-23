mod common;

use anim_format::clip::*;
use anim_format::{FormatError, NONE};
use common::*;

fn key_data(rng: &mut Rng, kind: TrackKind, subtype: u8, n: usize) -> KeyData {
    let id = rng.below(n as u32);
    match kind {
        TrackKind::Discrete => KeyData::Discrete {
            value: match DiscreteType::from_u8(subtype).unwrap() {
                DiscreteType::Bool => rng.below(2),
                DiscreteType::Enum => rng.below(10),
                DiscreteType::Asset => id,
            },
        },
        TrackKind::Event => KeyData::Event {
            method: id,
            args: rng.opt_id(n),
            threshold: rng.f32(0.0, 1.0),
            always: rng.bool(),
        },
        TrackKind::Marker => KeyData::Marker {
            kind: rng.pick(MarkerKind::ALL),
            name: rng.opt_id(n),
        },
        TrackKind::Audio => KeyData::Audio {
            asset: id,
            params: rng.opt_id(n),
        },
        TrackKind::Activation => KeyData::Activation,
        TrackKind::Control => KeyData::Control {
            kind: rng.pick(ControlKind::ALL),
            target: rng.opt_id(n),
            payload: rng.opt_id(n),
        },
        TrackKind::Subclip => KeyData::Subclip {
            clip: id,
            offset: rng.f32(-1.0, 1.0),
            speed: rng.f32(0.5, 2.0),
            blend_in: rng.f32(0.0, 0.3),
            blend_out: rng.f32(0.0, 0.3),
        },
        _ => unreachable!(),
    }
}

/// An arbitrary small valid clip. `form`: 0 raw only, 1 compressed only, 2 both, else random.
pub fn gen_clip(rng: &mut Rng, form: u32) -> Clip {
    let strings = strings(rng, 2);
    let n = strings.len();
    let frame_count = rng.range(1, 40);
    let sample_rate = 30.0;
    let duration = (frame_count - 1) as f32 / sample_rate;
    let bone_count = rng.range(0, 4);
    let form = if form > 2 { rng.below(3) } else { form };
    let has_raw = form != 1;
    let mut tracks = Vec::new();
    for _ in 0..rng.range(0, 8) {
        let kind = rng.pick(TrackKind::ALL);
        if kind == TrackKind::Bone && bone_count == 0 {
            continue;
        }
        let subtype = match kind {
            TrackKind::Discrete => rng.pick(DiscreteType::ALL).id(),
            TrackKind::Quat => rng.pick(QuatInterp::ALL).id(),
            _ => 0,
        };
        let binding = if kind == TrackKind::Bone {
            Binding::bone(rng.below(bone_count))
        } else if rng.bool() {
            Binding::property(rng.opt_id(n), rng.opt_id(n), rng.opt_id(n))
        } else {
            Binding::none()
        };
        let raw = if kind.is_sampled() && has_raw {
            (0..frame_count * kind.width() as u32)
                .map(|_| rng.f32(-10.0, 10.0))
                .collect()
        } else {
            Vec::new()
        };
        let mut keys = Vec::new();
        if kind.is_keyed() {
            let mut t = 0.0f32;
            for _ in 0..rng.range(0, 5) {
                t = (t + rng.f32(0.0, duration / 3.0 + 0.01)).min(duration);
                let instant = matches!(kind, TrackKind::Discrete | TrackKind::Marker);
                let end = if instant {
                    t
                } else {
                    rng.f32(t, duration.max(t)).min(duration)
                };
                keys.push(Key {
                    time: t,
                    end,
                    data: key_data(rng, kind, subtype, n),
                });
            }
        }
        let flags = rng.below(4) as u8;
        tracks.push(Track {
            kind,
            flags,
            subtype,
            binding,
            raw,
            keys,
        });
    }
    let root_curve = rng.bool().then(|| {
        (0..frame_count)
            .map(|_| {
                [
                    rng.f32(-1.0, 1.0),
                    0.0,
                    rng.f32(-1.0, 1.0),
                    rng.f32(-3.0, 3.0),
                ]
            })
            .collect()
    });
    let compressed = (form != 0).then(|| gen_compressed(rng, &tracks, frame_count));
    Clip {
        flags: rng.below(8),
        name: rng.opt_id(n),
        duration,
        sample_rate,
        frame_count,
        bone_count,
        root_bone: if bone_count > 0 {
            rng.opt_id(bone_count as usize)
        } else {
            NONE
        },
        strings,
        tracks,
        has_raw,
        root_curve,
        compressed,
    }
}

fn gen_compressed(rng: &mut Rng, tracks: &[Track], frames: u32) -> Compressed {
    let rotation_format = rng.pick(RotationFormat::ALL);
    let segment_frames = if rng.bool() {
        SEGMENT_FRAMES
    } else {
        rng.range(1, 8)
    };
    let mut channels = Vec::new();
    let (mut constants, mut clip_ranges) = (Vec::new(), Vec::new());
    let mut widths = Vec::new();
    for (i, t) in tracks.iter().enumerate() {
        let parts: Vec<(ChannelKind, u8)> = match t.kind {
            TrackKind::Bone => vec![
                (
                    ChannelKind::Rotation,
                    if rotation_format == RotationFormat::QuatDropW {
                        3
                    } else {
                        4
                    },
                ),
                (ChannelKind::Translation, 3),
                (ChannelKind::Scale, 3),
            ],
            k if k.is_sampled() => vec![(ChannelKind::Value, k.width())],
            _ => vec![],
        };
        for (kind, width) in parts {
            let mode = rng.pick(ChannelMode::ALL);
            let (data_offset, animated_index) = match mode {
                ChannelMode::Default => (NONE, NONE),
                ChannelMode::Constant => {
                    let o = constants.len() as u32;
                    constants.extend((0..width).map(|_| rng.f32(-1.0, 1.0)));
                    (o, NONE)
                }
                ChannelMode::Animated => {
                    let o = clip_ranges.len() as u32;
                    clip_ranges.extend((0..width).map(|_| rng.f32(-1.0, 1.0)));
                    clip_ranges.extend((0..width).map(|_| rng.f32(0.0, 2.0)));
                    widths.push(width);
                    (o, widths.len() as u32 - 1)
                }
            };
            channels.push(Channel {
                track: i as u32,
                kind,
                mode,
                width,
                data_offset,
                animated_index,
            });
        }
    }
    let seg_count = frames.div_ceil(segment_frames);
    let rates: Vec<u8> = (0..16u8)
        .chain([19, 23, 32])
        .filter(|&b| is_valid_bit_rate(b))
        .collect();
    let mut bit_rates = Vec::new();
    let mut segments = Vec::new();
    let mut end = 0u32;
    for s in 0..seg_count {
        let seg_rates: Vec<u8> = widths.iter().map(|_| rng.pick(&rates)).collect();
        let start = s * segment_frames;
        let count = (frames - start).min(segment_frames);
        let size =
            (segment_bits(count, &seg_rates, &widths).div_ceil(8) + rng.below(3) as u64) as u32;
        let offset = (end + 3) & !3;
        segments.push(Segment {
            start_frame: start,
            frame_count: count,
            data_offset: offset,
            data_size: size,
        });
        end = offset + size;
        bit_rates.extend(seg_rates);
    }
    let range_bytes = seg_count as usize * widths.iter().map(|&w| w as usize).sum::<usize>() * 2;
    Compressed {
        segment_frames,
        rotation_format,
        max_error: rng.f32(0.0, 0.001),
        channels,
        constants,
        clip_ranges,
        segments,
        bit_rates,
        segment_ranges: (0..range_bytes).map(|_| rng.below(256) as u8).collect(),
        data: (0..end).map(|_| rng.below(256) as u8).collect(),
    }
}

#[test]
fn round_trips_arbitrary_clips() {
    for seed in 0..400 {
        let mut rng = Rng::new(seed);
        let clip = gen_clip(&mut rng, 99);
        let bytes = clip.write().unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        check_layout(&bytes);
        let view = ClipView::parse(&bytes).unwrap();
        assert_eq!(view.to_clip(), clip, "seed {seed}");
        // Writing the decoded model gives the same bytes.
        assert_eq!(view.to_clip().write().unwrap(), bytes);
    }
}

#[test]
fn every_payload_form_round_trips() {
    for form in 0..3 {
        for seed in 0..50 {
            let mut rng = Rng::new(1000 + seed);
            let clip = gen_clip(&mut rng, form);
            let bytes = clip.write().unwrap();
            let view = ClipView::parse(&bytes).unwrap();
            assert_eq!(view.raw().is_some(), form != 1);
            assert_eq!(view.compressed().is_some(), form != 0);
            assert_eq!(view.to_clip(), clip);
        }
    }
}

fn sample_clip() -> Clip {
    let strings: Vec<String> = [
        "Run",
        "Body/Sword",
        "engine.MeshRenderer",
        "material.emissive",
        "OnStep",
        "{\"foot\":\"L\"}",
        "L",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let frames = 20;
    let bone_raw: Vec<f32> = (0..frames * 10).map(|i| i as f32 * 0.5).collect();
    let color_raw: Vec<f32> = (0..frames * 4).map(|i| i as f32 * 0.25).collect();
    let mut rng = Rng::new(7);
    let tracks = vec![
        Track {
            kind: TrackKind::Bone,
            flags: 0,
            subtype: 0,
            binding: Binding::bone(1),
            raw: bone_raw,
            keys: vec![],
        },
        Track {
            kind: TrackKind::Color,
            flags: 0,
            subtype: 0,
            binding: Binding::property(1, 2, 3),
            raw: color_raw,
            keys: vec![],
        },
        Track {
            kind: TrackKind::Event,
            flags: 0,
            subtype: 0,
            binding: Binding::none(),
            raw: vec![],
            keys: vec![
                Key {
                    time: 0.1,
                    end: 0.1,
                    data: KeyData::Event {
                        method: 4,
                        args: 5,
                        threshold: 0.5,
                        always: false,
                    },
                },
                Key {
                    time: 0.2,
                    end: 0.4,
                    data: KeyData::Event {
                        method: 4,
                        args: NONE,
                        threshold: 0.5,
                        always: true,
                    },
                },
            ],
        },
        Track {
            kind: TrackKind::Marker,
            flags: 0,
            subtype: 0,
            binding: Binding::none(),
            raw: vec![],
            keys: vec![Key {
                time: 0.3,
                end: 0.3,
                data: KeyData::Marker {
                    kind: MarkerKind::Sync,
                    name: 6,
                },
            }],
        },
    ];
    let mut clip = Clip {
        flags: CLIP_LOOP,
        name: 0,
        duration: (frames - 1) as f32 / 30.0,
        sample_rate: 30.0,
        frame_count: frames,
        bone_count: 2,
        root_bone: 0,
        strings,
        tracks,
        has_raw: true,
        root_curve: Some(
            (0..frames)
                .map(|i| [i as f32, 0.0, 0.0, 0.1 * i as f32])
                .collect(),
        ),
        compressed: None,
    };
    clip.compressed = Some(gen_compressed(&mut rng, &clip.tracks, frames));
    clip
}

#[test]
fn views_read_tracks_keys_raw_and_root_curve() {
    let clip = sample_clip();
    let bytes = clip.write().unwrap();
    let v = ClipView::parse(&bytes).unwrap();
    assert_eq!(v.flags(), CLIP_LOOP);
    assert_eq!(v.strings().get(v.name()), Some("Run"));
    assert_eq!(v.track_count(), 4);
    let t = v.track(1).unwrap();
    assert_eq!(t.kind, TrackKind::Color);
    assert_eq!(t.width, 4);
    assert_eq!(v.strings().get(t.binding.node_path), Some("Body/Sword"));
    assert_eq!(v.strings().get(t.binding.field), Some("material.emissive"));
    // Raw blocks start on 16-byte boundaries of a 16-aligned section.
    let raw = v.section(section::RAW).unwrap();
    assert_eq!(raw.offset % 16, 0);
    assert_eq!(t.raw_offset % 4, 0);
    let r = v.track_raw(1).unwrap();
    assert_eq!(r.len(), 80);
    assert_eq!(r.get(3), Some(0.75));
    let mut out = vec![0.0; 80];
    assert!(r.copy_to(&mut out));
    assert_eq!(out[79], 79.0 * 0.25);
    assert_eq!(v.track_raw(2), None);
    let keys: Vec<Key> = v.track_keys(2).collect();
    assert_eq!(keys.len(), 2);
    assert_eq!(v.strings().get(5), Some("{\"foot\":\"L\"}"));
    assert!(matches!(keys[1].data, KeyData::Event { always: true, .. }));
    assert_eq!(keys[1].end, 0.4);
    assert_eq!(v.root_frame(3), Some([3.0, 0.0, 0.0, 0.3]));
    assert_eq!(v.section(section::ROOT_CURVE).unwrap().offset % 16, 0);
    let c = v.compressed().unwrap();
    assert_eq!(
        c.segment_count(),
        20usize.div_ceil(c.segment_frames() as usize)
    );
    assert_eq!(c.channel_count(), 4); // bone: rotation, translation, scale; colour: value
    assert_eq!(c.channel(0).unwrap().kind, ChannelKind::Rotation);
    assert_eq!(v.section(section::COMP_DATA).unwrap().offset % 16, 0);
    for s in 0..c.segment_count() {
        let seg = c.segment(s).unwrap();
        assert_eq!(c.segment_data(s).unwrap().len(), seg.data_size as usize);
        assert_eq!(c.bit_rates(s).unwrap().len(), c.animated_count());
    }
}

#[test]
fn header_layout_is_the_documented_one() {
    let bytes = sample_clip().write().unwrap();
    assert_eq!(&bytes[0..8], b"MYCOANIM");
    assert_eq!(u32_at(&bytes, 8), FORMAT_VERSION);
    assert_eq!(u32_at(&bytes, 12), CLIP_LOOP);
    assert_eq!(u32_at(&bytes, 16) as usize, bytes.len());
    let es = entries(&bytes);
    let kinds: Vec<u32> = es.iter().map(|e| e.1).collect();
    assert_eq!(
        kinds,
        vec![1, 2, 3, 4, 5, 6, 16, 17, 18, 19, 20, 21, 22, 23]
    );
    // INFO: duration, rate, frames, tracks.
    let info = es[1].2 as usize;
    assert_eq!(
        f32::from_le_bytes(bytes[info + 4..info + 8].try_into().unwrap()),
        30.0
    );
    assert_eq!(u32_at(&bytes, info + 8), 20);
    assert_eq!(u32_at(&bytes, info + 12), 4);
    // TRACKS record 1: kind colour (5), width 4.
    let tr = es[2].2 as usize + 32;
    assert_eq!(bytes[tr], 5);
    assert_eq!(bytes[tr + 3], 4);
}

#[test]
fn corrupt_and_truncated_buffers_are_refused() {
    let mut rng = Rng::new(99);
    check_refusals(
        &sample_clip().write().unwrap(),
        |b| ClipView::parse(b).map(|_| ()),
        &mut rng,
    );
    for seed in 0..10 {
        let mut g = Rng::new(5000 + seed);
        let bytes = gen_clip(&mut g, 99).write().unwrap();
        check_refusals(&bytes, |b| ClipView::parse(b).map(|_| ()), &mut rng);
    }
}

fn refused(clip: &Clip) -> FormatError {
    clip.write().expect_err("an invalid clip was written")
}

#[test]
fn invalid_models_are_refused() {
    let base = sample_clip();
    assert!(base.write().is_ok());

    let mut c = base.clone();
    c.tracks[0].binding.bone = 2; // bone_count is 2
    assert!(matches!(
        refused(&c),
        FormatError::IndexOutOfRange { what: "bone", .. }
    ));

    let mut c = base.clone();
    c.tracks[2].keys.reverse();
    assert!(matches!(
        refused(&c),
        FormatError::Inconsistent {
            what: "keys not sorted by time"
        }
    ));

    let mut c = base.clone();
    c.tracks[2].keys[0].time = 10.0;
    c.tracks[2].keys[0].end = 10.0;
    assert!(matches!(
        refused(&c),
        FormatError::BadFloat { what: "key time" }
    ));

    let mut c = base.clone();
    c.tracks[3].keys[0].end = 0.35; // markers are instant
    assert!(matches!(refused(&c), FormatError::Inconsistent { .. }));

    let mut c = base.clone();
    c.tracks[2].keys[0].data = KeyData::Event {
        method: 4,
        args: 99,
        threshold: 0.5,
        always: false,
    };
    assert!(matches!(
        refused(&c),
        FormatError::IndexOutOfRange {
            what: "event args",
            ..
        }
    ));

    let mut c = base.clone();
    c.tracks[2].keys[0].data = KeyData::Event {
        method: 4,
        args: NONE,
        threshold: 1.5,
        always: false,
    };
    assert!(matches!(
        refused(&c),
        FormatError::BadFloat {
            what: "event threshold"
        }
    ));

    let mut c = base.clone();
    c.tracks[1].raw[5] = f32::NAN;
    assert!(matches!(
        refused(&c),
        FormatError::BadFloat { what: "raw sample" }
    ));

    let mut c = base.clone();
    c.tracks[1].raw.pop();
    refused(&c); // a short raw block breaks the canonical layout

    let mut c = base.clone();
    c.root_curve.as_mut().unwrap().pop();
    assert!(matches!(
        refused(&c),
        FormatError::BadCount {
            what: "ROOT_CURVE frames",
            ..
        }
    ));

    let mut c = base.clone();
    c.has_raw = false;
    c.compressed = None;
    for t in &mut c.tracks {
        t.raw.clear();
    }
    assert!(matches!(
        refused(&c),
        FormatError::MissingSection {
            section: "RAW or compressed"
        }
    ));

    let mut c = base.clone();
    c.tracks[0].subtype = 1;
    assert!(matches!(
        refused(&c),
        FormatError::InvalidValue {
            what: "track subtype",
            ..
        }
    ));

    let mut c = base.clone();
    c.tracks[1].flags = 4;
    assert!(matches!(
        refused(&c),
        FormatError::InvalidValue {
            what: "track flags",
            ..
        }
    ));

    let mut c = base.clone();
    c.duration = f32::INFINITY;
    assert!(matches!(
        refused(&c),
        FormatError::BadFloat { what: "duration" }
    ));
}

#[test]
fn invalid_compressed_forms_are_refused() {
    let base = sample_clip();
    let comp = |f: &dyn Fn(&mut Compressed)| {
        let mut c = base.clone();
        f(c.compressed.as_mut().unwrap());
        refused(&c)
    };
    assert!(matches!(
        comp(&|c| if let Some(b) = c.bit_rates.first_mut() {
            *b = 17
        } else {
            c.max_error = -1.0
        }),
        FormatError::InvalidValue {
            what: "bit rate",
            ..
        } | FormatError::BadFloat { .. }
    ));
    assert!(matches!(
        comp(&|c| c.channels.swap(0, 1)),
        FormatError::Inconsistent { .. }
    ));
    assert!(matches!(
        comp(&|c| {
            c.channels.pop();
        }),
        FormatError::BadCount { .. }
    ));
    assert!(matches!(
        comp(&|c| c.segment_frames = 0),
        FormatError::InvalidValue {
            what: "segment frames",
            ..
        }
    ));
    assert!(matches!(
        comp(&|c| c.segments[0].start_frame = 1),
        FormatError::Inconsistent {
            what: "segment frames"
        }
    ));
    assert!(matches!(
        comp(&|c| c.data.push(0)),
        FormatError::BadCount { .. }
    ));
    assert!(matches!(
        comp(&|c| c.segment_ranges.push(0)),
        FormatError::BadCount {
            what: "segment ranges",
            ..
        }
    ));
    assert!(comp(&|c| c.max_error = f32::NAN) == FormatError::BadFloat { what: "max error" });
    // A segment whose bitstream is too short for its bit rates.
    let mut c = base.clone();
    let cc = c.compressed.as_mut().unwrap();
    cc.channels = cc
        .channels
        .iter()
        .map(|ch| Channel {
            mode: ChannelMode::Default,
            data_offset: NONE,
            animated_index: NONE,
            ..*ch
        })
        .collect();
    cc.channels[1] = Channel {
        mode: ChannelMode::Animated,
        data_offset: 0,
        animated_index: 0,
        ..cc.channels[1]
    };
    cc.clip_ranges = vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0];
    let segs = cc.segments.len();
    cc.bit_rates = vec![16; segs];
    cc.segment_ranges = vec![0; segs * 3 * 2];
    let mut end = 0;
    for s in &mut cc.segments {
        s.data_offset = (end + 3) & !3;
        s.data_size = s.frame_count * 16 * 3 / 8;
        end = s.data_offset + s.data_size;
    }
    cc.data = vec![0; end as usize];
    assert!(c.write().is_ok());
    let cc = c.compressed.as_mut().unwrap();
    let last = cc.segments.len() - 1;
    cc.segments[last].data_size -= 1;
    cc.data.pop();
    assert!(matches!(
        refused(&c),
        FormatError::BadCount {
            what: "segment data bits",
            ..
        }
    ));
}

#[test]
fn bit_rates_follow_acl() {
    let allowed: Vec<u8> = (0..=255).filter(|&b| is_valid_bit_rate(b)).collect();
    let mut expected = vec![0];
    expected.extend(3..=16);
    expected.extend([19, 23, 32]);
    assert_eq!(allowed, expected);
    assert_eq!(segment_bits(16, &[8, 32], &[3, 1]), 16 * (24 + 32));
}
