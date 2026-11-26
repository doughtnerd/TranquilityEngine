//! Feature `tracks`: property and event track outputs (wire family `tracks`; layout in
//! `anim_wire::tracks`'s docs).
//!
//! Pure functions the evaluate loop (T13r) calls per playing clip, with the clip's
//! [`ClipBindings`] built when the clip loaded:
//!
//! - when a clip is bound to an instance, [`write_columns`] writes its `COLUMN` records
//!   ([`column_records_len`] bytes) and the instance reserves [`ClipBindings::column_words`]
//!   column words and [`ClipBindings::notify_words`] notify-state words (zeroed per play);
//! - each frame, [`evaluate_clip`] samples the clip's tracks over the playhead's window into
//!   its column words and appends records through a [`RecordWriter`] over the instance's record
//!   region; [`end_clip`] ends the clip's open notify states when its play stops or is
//!   interrupted;
//! - [`RecordWriter::header`] gives the region's `OUTPUT_HEADER`.
//!
//! Nothing here allocates. Internal to the core (Rust API between features, not engine API).

use anim_format::NONE;
use anim_sample::{
    BoundClip, ClipBindings, ColumnType, NotifyPhase, TrackRecord, TrackSink, Window,
};
use anim_wire::core::Init;
use anim_wire::tracks::{
    ActivationEdge, Audio, Column, Control, Event, Marker, NotifyState, OutputHeader, SubclipState,
    COLUMN_DEFAULT, COLUMN_F32, COLUMN_U32, PHASE_BEGIN, PHASE_END, PHASE_TICK,
};
use anim_wire::WireRecord;

/// The record region each instance gets per frame, in bytes (about 60 of the largest record;
/// `anim-wire` core's `TRACK_RECORD_BYTES`, placed in the track region by T13r's evaluate loop).
/// Records past it are counted as dropped.
pub const RECORD_BYTES_PER_INSTANCE: u64 = anim_wire::core::TRACK_RECORD_BYTES as u64;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// per instance its track region (`anim-wire` core's `TRACK_STRIDE`: output header, column clip,
/// column block, records). Notify-state words live in the clip players' graph state.
pub(crate) fn bytes_needed(init: &Init) -> u64 {
    let per_instance = anim_wire::core::TRACK_STRIDE as u64;
    debug_assert!(per_instance >= OutputHeader::STRIDE as u64 + RECORD_BYTES_PER_INSTANCE);
    (init.max_instances as u64).saturating_mul(per_instance)
}

/// Bytes of a clip's `COLUMN` records.
pub fn column_records_len(bindings: &ClipBindings) -> usize {
    bindings.columns().count() * Column::STRIDE as usize
}

/// Writes a clip's `COLUMN` records into `out` (at least [`column_records_len`] bytes); returns
/// the bytes written, or `None` (writing nothing) when `out` is too short.
pub fn write_columns(bindings: &ClipBindings, out: &mut [u8]) -> Option<usize> {
    let len = column_records_len(bindings);
    if out.len() < len {
        return None;
    }
    let stride = Column::STRIDE as usize;
    for (i, c) in bindings.columns().enumerate() {
        let record = Column {
            track: c.track,
            track_kind: c.kind.id() as u32,
            column_type: match c.ty {
                ColumnType::F32 => COLUMN_F32,
                ColumnType::U32 => COLUMN_U32,
            },
            flags: if c.default { COLUMN_DEFAULT } else { 0 },
            offset: c.offset,
            width: c.width,
        };
        record.encode_into(&mut out[i * stride..]).ok()?;
    }
    Some(len)
}

/// Appends `tracks` records to an instance's record region. A record that doesn't fit is
/// counted in `dropped` and skipped; later, smaller records may still fit.
pub struct RecordWriter<'b> {
    buf: &'b mut [u8],
    used: usize,
    count: u32,
    dropped: u32,
    instance: u32,
    clip: u32,
}

impl<'b> RecordWriter<'b> {
    /// An empty writer over `buf`, for `instance`.
    pub fn new(buf: &'b mut [u8], instance: u32) -> Self {
        RecordWriter {
            buf,
            used: 0,
            count: 0,
            dropped: 0,
            instance,
            clip: NONE,
        }
    }

    /// Sets the clip handle the following records name.
    pub fn set_clip(&mut self, clip: u32) {
        self.clip = clip;
    }

    /// The records written so far.
    pub fn bytes(&self) -> &[u8] {
        &self.buf[..self.used]
    }

    /// The region's header (`column_words`: the instance's column words, which the caller
    /// knows).
    pub fn header(&self, column_words: u32) -> OutputHeader {
        OutputHeader {
            column_words,
            record_bytes: self.used as u32,
            record_count: self.count,
            dropped: self.dropped,
        }
    }

    fn put<R: WireRecord>(&mut self, r: &R) {
        let stride = R::DESC.stride as usize;
        let ok = match self.buf.get_mut(self.used..) {
            Some(rest) if rest.len() >= stride => r.encode_into(rest).is_ok(),
            _ => false,
        };
        if ok {
            self.used += stride;
            self.count += 1;
        } else {
            self.dropped += 1;
        }
    }
}

impl TrackSink for RecordWriter<'_> {
    fn push(&mut self, record: TrackRecord) {
        let (instance, clip) = (self.instance, self.clip);
        match record {
            TrackRecord::Event {
                track,
                key,
                method,
                args,
                time,
                weight,
            } => self.put(&Event {
                instance,
                clip,
                track,
                key,
                method,
                args,
                time,
                weight,
            }),
            TrackRecord::NotifyState {
                track,
                key,
                method,
                args,
                phase,
                time,
                start,
                duration,
                weight,
            } => self.put(&NotifyState {
                instance,
                clip,
                track,
                key,
                method,
                args,
                phase: match phase {
                    NotifyPhase::Begin => PHASE_BEGIN,
                    NotifyPhase::Tick => PHASE_TICK,
                    NotifyPhase::End => PHASE_END,
                },
                time,
                start,
                duration,
                weight,
            }),
            TrackRecord::Activation {
                track,
                active,
                time,
            } => self.put(&ActivationEdge {
                instance,
                clip,
                track,
                active: active as u32,
                time,
            }),
            TrackRecord::Control {
                track,
                key,
                kind,
                target,
                payload,
                time,
                duration,
                weight,
            } => self.put(&Control {
                instance,
                clip,
                track,
                key,
                control: kind.id() as u32,
                target,
                payload,
                time,
                duration,
                weight,
            }),
            TrackRecord::Audio {
                track,
                key,
                asset,
                params,
                time,
                duration,
                weight,
            } => self.put(&Audio {
                instance,
                clip,
                track,
                key,
                asset,
                params,
                time,
                duration,
                weight,
            }),
            TrackRecord::Marker {
                track,
                key,
                kind,
                name,
                time,
            } => self.put(&Marker {
                instance,
                clip,
                track,
                key,
                marker: kind.id() as u32,
                name,
                time,
            }),
            TrackRecord::Subclip {
                track,
                key,
                clip: asset,
                flags,
                local_time,
                local_delta,
                weight,
            } => self.put(&SubclipState {
                instance,
                clip,
                track,
                key,
                asset,
                flags,
                local_time,
                local_delta,
                weight,
            }),
        }
    }
}

/// Evaluates one playing clip's tracks over `window` at clip weight `weight`: its column words
/// (`columns`, [`ClipBindings::column_words`] long) at the window's end, and its records into
/// `writer` under clip handle `clip`. `open` is the play's notify-state words. Returns the
/// window's end time (the next window's `from`).
pub fn evaluate_clip(
    bound: &BoundClip<'_, '_>,
    clip: u32,
    window: &Window,
    weight: f32,
    open: &mut [u32],
    columns: &mut [u32],
    writer: &mut RecordWriter<'_>,
) -> f32 {
    writer.set_clip(clip);
    bound.evaluate(window, weight, open, columns, writer)
}

/// Ends a stopped or interrupted play's open notify states at clip time `time`.
pub fn end_clip(
    bindings: &ClipBindings,
    clip: u32,
    time: f32,
    weight: f32,
    open: &mut [u32],
    writer: &mut RecordWriter<'_>,
) {
    writer.set_clip(clip);
    bindings.end_notify_states(time, weight, open, writer);
}

#[cfg(test)]
mod tests {
    use super::*;
    use anim_format::clip::{
        Binding, Clip, ClipView, ControlKind, Key, KeyData, MarkerKind, Track, TrackKind,
    };
    use anim_sample::{ClipSampler, Form, WINDOW_START};
    use anim_wire::tracks::{SUBCLIP_ENTERED, VERSION};

    fn keyed(kind: TrackKind, keys: Vec<(f32, f32, KeyData)>) -> Track {
        Track {
            kind,
            flags: 0,
            subtype: 0,
            binding: Binding::none(),
            raw: Vec::new(),
            keys: keys
                .into_iter()
                .map(|(time, end, data)| Key { time, end, data })
                .collect(),
        }
    }

    fn clip() -> Vec<u8> {
        let frames = 31;
        let float = Track {
            kind: TrackKind::Float,
            flags: 0,
            subtype: 0,
            binding: Binding::property(0, 0, 0),
            raw: (0..frames).map(|f| f as f32 * 0.5).collect(),
            keys: Vec::new(),
        };
        let event = |method, end| {
            (
                0.4,
                end,
                KeyData::Event {
                    method,
                    args: NONE,
                    threshold: 0.5,
                    always: false,
                },
            )
        };
        let mut discrete = keyed(
            TrackKind::Discrete,
            vec![(0.0, 0.0, KeyData::Discrete { value: 3 })],
        );
        discrete.subtype = 2; // asset ids
        let c = Clip {
            flags: 0,
            name: NONE,
            duration: 1.0,
            sample_rate: 30.0,
            frame_count: frames,
            bone_count: 0,
            root_bone: NONE,
            strings: vec!["a".into(), "b".into(), "c".into(), "d".into()],
            tracks: vec![
                float,
                keyed(TrackKind::Event, vec![event(1, 0.4), event(2, 0.8)]),
                keyed(
                    TrackKind::Marker,
                    vec![(
                        0.1,
                        0.1,
                        KeyData::Marker {
                            kind: MarkerKind::Hit,
                            name: 0,
                        },
                    )],
                ),
                keyed(
                    TrackKind::Audio,
                    vec![(
                        0.2,
                        0.5,
                        KeyData::Audio {
                            asset: 1,
                            params: 2,
                        },
                    )],
                ),
                keyed(
                    TrackKind::Control,
                    vec![(
                        0.3,
                        0.3,
                        KeyData::Control {
                            kind: ControlKind::SlotPlay,
                            target: 3,
                            payload: NONE,
                        },
                    )],
                ),
                keyed(TrackKind::Activation, vec![(0.0, 0.6, KeyData::Activation)]),
                discrete,
                keyed(
                    TrackKind::Subclip,
                    vec![(
                        0.2,
                        0.9,
                        KeyData::Subclip {
                            clip: 2,
                            offset: 0.0,
                            speed: 1.0,
                            blend_in: 0.0,
                            blend_out: 0.0,
                        },
                    )],
                ),
            ],
            has_raw: true,
            root_curve: None,
            compressed: None,
        };
        c.write().unwrap()
    }

    /// Splits a record region into (opcode, bytes) by each record's opcode and stride.
    fn split(bytes: &[u8]) -> Vec<(u16, &[u8])> {
        let strides = anim_wire::tracks::FAMILY.records;
        let mut out = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            let op = u16::from_le_bytes([bytes[at], bytes[at + 1]]);
            assert_eq!(u16::from_le_bytes([bytes[at + 2], bytes[at + 3]]), VERSION);
            let d = strides
                .iter()
                .find(|d| d.opcode == op)
                .expect("known opcode");
            out.push((op, &bytes[at..at + d.stride as usize]));
            at += d.stride as usize;
        }
        out
    }

    #[test]
    fn a_window_becomes_wire_records() {
        let bytes = clip();
        let view = ClipView::parse(&bytes).unwrap();
        let sampler = ClipSampler::new(view, Form::Raw).unwrap();
        let bindings = ClipBindings::new(&sampler);
        let bound = bindings.bind(&sampler).unwrap();
        let mut open = vec![0u32; bindings.notify_words()];
        let mut columns = vec![0u32; bindings.column_words()];
        let mut region = [0u8; 1024];
        let mut w = RecordWriter::new(&mut region, 77);
        let end = evaluate_clip(
            &bound,
            5,
            &Window::new(0.0, 0.5, false).with(WINDOW_START),
            1.0,
            &mut open,
            &mut columns,
            &mut w,
        );
        assert_eq!(end, 0.5);
        let header = w.header(columns.len() as u32);
        let recs = split(w.bytes());
        assert_eq!(header.record_count as usize, recs.len());
        assert_eq!(header.record_bytes as usize, w.bytes().len());
        assert_eq!(header.dropped, 0);
        let ops: Vec<u16> = recs.iter().map(|r| r.0).collect();
        assert_eq!(
            ops,
            vec![
                Marker::OPCODE,
                Audio::OPCODE,
                Control::OPCODE,
                Event::OPCODE,
                NotifyState::OPCODE,
                ActivationEdge::OPCODE,
                SubclipState::OPCODE,
            ]
        );
        let ev = Event::decode(recs[3].1).unwrap();
        assert_eq!(
            ev,
            Event {
                instance: 77,
                clip: 5,
                track: 1,
                key: 0,
                method: 1,
                args: NONE,
                time: 0.4,
                weight: 1.0
            }
        );
        let st = NotifyState::decode(recs[4].1).unwrap();
        assert_eq!((st.phase, st.method, st.start), (PHASE_BEGIN, 2, 0.4));
        assert!((st.duration - 0.4).abs() < 1e-6);
        let au = Audio::decode(recs[1].1).unwrap();
        assert_eq!((au.asset, au.params, au.time), (1, 2, 0.2));
        let co = Control::decode(recs[2].1).unwrap();
        assert_eq!(co.control, ControlKind::SlotPlay.id() as u32);
        let mk = Marker::decode(recs[0].1).unwrap();
        assert_eq!(mk.marker, MarkerKind::Hit.id() as u32);
        let ac = ActivationEdge::decode(recs[5].1).unwrap();
        assert_eq!((ac.active, ac.track), (1, 5));
        let sc = SubclipState::decode(recs[6].1).unwrap();
        assert_eq!((sc.asset, sc.flags), (2, SUBCLIP_ENTERED));
        assert!((sc.local_time - 0.3).abs() < 1e-6);
        // Columns: the float at 0.5 s (frame 15 = 7.5), activation on, discrete 3.
        assert_eq!(f32::from_bits(columns[0]), 7.5);
        assert_eq!(&columns[1..], &[1, 3]);

        // The play stops: its open state ends.
        let mut region = [0u8; 256];
        let mut w = RecordWriter::new(&mut region, 77);
        end_clip(&bindings, 5, 0.5, 1.0, &mut open, &mut w);
        let recs = split(w.bytes());
        assert_eq!(recs.len(), 1);
        assert_eq!(NotifyState::decode(recs[0].1).unwrap().phase, PHASE_END);
    }

    #[test]
    fn records_that_dont_fit_are_counted() {
        let bytes = clip();
        let view = ClipView::parse(&bytes).unwrap();
        let sampler = ClipSampler::new(view, Form::Raw).unwrap();
        let bindings = ClipBindings::new(&sampler);
        let bound = bindings.bind(&sampler).unwrap();
        let mut open = vec![0u32; bindings.notify_words()];
        let mut columns = vec![0u32; bindings.column_words()];
        // Room for the marker (32 B) and nothing bigger than 12 more bytes.
        let mut region = [0u8; Marker::STRIDE as usize + 12];
        let mut w = RecordWriter::new(&mut region, 1);
        evaluate_clip(
            &bound,
            0,
            &Window::new(0.0, 0.5, false).with(WINDOW_START),
            1.0,
            &mut open,
            &mut columns,
            &mut w,
        );
        let h = w.header(0);
        assert_eq!(h.record_count, 1);
        assert_eq!(h.dropped, 6);
        assert_eq!(h.record_bytes, Marker::STRIDE);
    }

    #[test]
    fn column_records_describe_the_block() {
        let bytes = clip();
        let view = ClipView::parse(&bytes).unwrap();
        let sampler = ClipSampler::new(view, Form::Raw).unwrap();
        let bindings = ClipBindings::new(&sampler);
        let mut out = vec![0u8; column_records_len(&bindings)];
        assert_eq!(write_columns(&bindings, &mut out), Some(out.len()));
        let cols: Vec<Column> = out
            .chunks(Column::STRIDE as usize)
            .map(|c| Column::decode(c).unwrap())
            .collect();
        assert_eq!(
            cols,
            vec![
                Column {
                    track: 0,
                    track_kind: TrackKind::Float.id() as u32,
                    column_type: COLUMN_F32,
                    flags: 0,
                    offset: 0,
                    width: 1
                },
                Column {
                    track: 5,
                    track_kind: TrackKind::Activation.id() as u32,
                    column_type: COLUMN_U32,
                    flags: 0,
                    offset: 1,
                    width: 1
                },
                Column {
                    track: 6,
                    track_kind: TrackKind::Discrete.id() as u32,
                    column_type: COLUMN_U32,
                    flags: 0,
                    offset: 2,
                    width: 1
                },
            ]
        );
        assert_eq!(write_columns(&bindings, &mut out[..10]), None);
    }

    #[test]
    fn wire_enums_match_the_sampler() {
        assert_eq!(
            anim_sample::SUBCLIP_ENTERED,
            anim_wire::tracks::SUBCLIP_ENTERED
        );
        assert_eq!(
            anim_sample::SUBCLIP_EXITED,
            anim_wire::tracks::SUBCLIP_EXITED
        );
        assert_eq!(NotifyPhase::Begin as u32, PHASE_BEGIN);
        assert_eq!(NotifyPhase::Tick as u32, PHASE_TICK);
        assert_eq!(NotifyPhase::End as u32, PHASE_END);
    }
}
