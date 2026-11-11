//! ADR 0162 (spatial audio, M3; contract K1): the new command records, the STATUS sections and the
//! blob headers, transcribed from `docs/design/0162-audio-spatial/api-and-models.md` §4.2–§4.5 and
//! the architect's contracts C1–C7. `batch.rs` lists the opcodes, `status.rs` the header fields and
//! sections, `schema.rs` the constants and enums; this file holds their tables.
//!
//! Byte offsets in the comments count from the record's first byte, head included (12 B).

use crate::model::*;

/// SET_VOICE_FX `mask` (C3): which parts the record sets.
const VOICE_FX_MASK: &[Bits] = &[
    Bits::bit("hpHz", 0, "hpHz"),
    Bits::bit("sends", 1, "send[0..3]"),
    Bits::bit("yaw", 2, "yaw (ambisonic voices)"),
    Bits::bit("aux", 3, "auxLevel and auxBus"),
];

/// 0x0A SET_VOICE_FX, 52 B (C3, §4.2): a mixed voice's high-pass, zone sends, ambisonic yaw and aux
/// send. Stamped like SET_PARAMS. The state lives in the core's mixed-voice pool; virtual voices hold
/// none, so main re-sends it with SET_MIXED on promotion.
pub const SET_VOICE_FX: Opcode = Opcode {
    id: 0x0A,
    name: "SET_VOICE_FX",
    payload: Body::fixed(&[
        Field::new("mask", Ty::U32).flags(VOICE_FX_MASK), // 12
        Field::new("rampFrames", Ty::U32),                // 16
        Field::new("hpHz", Ty::F32).doc("high-pass cutoff in Hz; HP_BOTTOM (20) or less is off"), // 20
        Field::new("send", Ty::F32)
            .array(4)
            .doc("linear level into zone slot k (0..3), taken pre-distance; main folds volume, curve, weight and wet factor"), // 24
        Field::new("yaw", Ty::F32).doc("radians, ambisonic voices only"), // 40
        Field::new("auxLevel", Ty::F32).doc("linear level of the one aux send"), // 44
        Field::new("auxBus", Ty::U16).doc("aux send's bus; 0xFFFF (AUX_BUS_NONE) is none"), // 48
        Field::new("reserved", Ty::U16), // 50
    ]),
    total_bytes: Some(52),
    sent: true,
    doc: "a mixed voice's high-pass, zone sends, ambisonic yaw and aux send (ADR 0162 C3); stamped like SET_PARAMS",
};

/// BED_CONFIG's two arrays (C2, §4.2): `u8 bedSlot[busCount]` from offset 20, padded to 4 B, then
/// `u16 hostBus[slotCount]`, padded to 4 B.
const BED_CONFIG_ARRAYS: &[PaddedArray] = &[
    PaddedArray {
        name: "bedSlot",
        count_field: "busCount",
        ty: Ty::U8,
        max: 0,
        doc: "per bus, the bed slot its voices encode into; 0xFF (BED_SLOT_NONE) is none",
    },
    PaddedArray {
        name: "hostBus",
        count_field: "slotCount",
        ty: Ty::U16,
        max: 4,
        doc: "per slot, the bus it decodes into before that bus's effects; 0xFFFF (BED_HOST_NONE) is unused",
    },
];

/// 0x16 BED_CONFIG (R1, C2, §4.2), applies on arrival. Total `20 + pad4(busCount) + pad4(2 x
/// slotCount)`. Sent after BUS_CONFIG and on every bed-setting change; in REPLAY right after
/// BUS_CONFIG.
pub const BED_CONFIG: Opcode = Opcode {
    id: 0x16,
    name: "BED_CONFIG",
    payload: Body::with_tail(
        &[
            Field::new("busCount", Ty::U32),                            // 12
            Field::new("slotCount", Ty::U32).doc("at most MAX_BEDS (4)"), // 16
        ],
        Tail::Arrays(BED_CONFIG_ARRAYS),
    ),
    total_bytes: None,
    sent: true,
    doc: "the bed slots and their host buses (ADR 0162 C2); applies on arrival",
};

/// One ZONE_CONFIG slot, 16 B (C5).
const ZONE_CONFIG_SLOTS: Repeat = Repeat {
    name: "slots",
    count_field: "slotCount",
    item: &[
        Field::new("kernelId", Ty::U32).doc("a zone kernel clip id (ZONE_KERNEL_ID_FIRST..=LAST); 0 is off"),
        Field::new("returnBus", Ty::U16).doc("the zone's output bus (R17)"),
        Field::new("state", Ty::U8).doc("ZoneSlotState: 1 active, 2 release, 3 evict"),
        Field::new("reserved", Ty::U8),
        Field::new("wet", Ty::F32).doc("0..2, ramped over rampFrames"),
        Field::new("irFrames", Ty::U32).doc("the kernel's length in frames"),
    ],
    then: None,
    max: 4,
};

/// 0x17 ZONE_CONFIG (R4, C5, §4.2), idempotent, applies on arrival. Total `24 + 16n`.
pub const ZONE_CONFIG: Opcode = Opcode {
    id: 0x17,
    name: "ZONE_CONFIG",
    payload: Body::with_tail(
        &[
            Field::new("slotCount", Ty::U32).doc("at most MAX_ZONE_SLOTS (4)"), // 12
            Field::new("sharedReturnGain", Ty::F32).doc("the shared reverb's return, 0..1 (1 minus the listener's zone weight), ramped"), // 16
            Field::new("rampFrames", Ty::U32), // 20
        ],
        Tail::Repeat(&ZONE_CONFIG_SLOTS),
    ),
    total_bytes: None,
    sent: true,
    doc: "the zone slots: kernels, return buses, states and wet levels (ADR 0162 C5); idempotent, applies on arrival",
};

/// LISTENER `flags` (C4).
const LISTENER_FLAGS: &[Bits] = &[Bits::bit("snap", 0, "a camera cut: jump to the rotation, no ramp")];

/// 0x20 LISTENER, 36 B (R3, C4, §4.2), asap: the world-to-listener rotation the core applies to
/// ambisonic voices. Axis map: `(X, Y, Z)_ambix = (-z, -x, +y)_engine`.
pub const LISTENER: Opcode = Opcode {
    id: 0x20,
    name: "LISTENER",
    payload: Body::fixed(&[
        Field::new("qx", Ty::F32).doc("world-to-listener rotation quaternion; normalised by the core, non-finite or zero ignored"), // 12
        Field::new("qy", Ty::F32), // 16
        Field::new("qz", Ty::F32), // 20
        Field::new("qw", Ty::F32), // 24
        Field::new("rampFrames", Ty::U32).doc("slerped per quantum over this many frames"), // 28
        Field::new("flags", Ty::U32).flags(LISTENER_FLAGS), // 32
    ]),
    total_bytes: Some(36),
    sent: true,
    doc: "the listener's world-to-listener rotation for ambisonic voices (ADR 0162 C4); asap",
};

/// STATUS `beds` item, 8 B (C7, §4.3).
pub const BEDS_ITEM: &[Field] = &[
    Field::new("bus", Ty::U16).doc("the slot's host bus"),
    Field::new("voices", Ty::U16).doc("voices encoded into the slot"),
    Field::new("work", Ty::U32).doc("work units, last quantum"),
];

/// STATUS `zones` item, 12 B (C7, §4.3).
pub const ZONES_ITEM: &[Field] = &[
    Field::new("kernelId", Ty::U32),
    Field::new("state", Ty::U8).doc("ZoneState: 0 off, 1 waiting for kernel, 2 fading in, 3 active, 4 ringing out, 5 evicting"),
    Field::new("pad", Ty::U8),
    Field::new("quantaSinceInput", Ty::U16).doc("quanta since a send last fed the slot (saturating)"),
    Field::new("wetPeak", Ty::F32).doc("peak of the slot's wet output, last block"),
];

/// STATUS `zoneEvents` item, 4 B (C7, §4.3).
pub const ZONE_EVENTS_ITEM: &[Field] = &[
    Field::new("slot", Ty::U8),
    Field::new("code", Ty::U8).doc("ZoneEvent: 1 refused kernel, 2 refused slot, 3 bad blob"),
    Field::new("reserved", Ty::U16),
];

/// Format 3 (prepared zone kernel) first-chunk header, 32 B (C6, §4.5). The packed spectra follow:
/// head `[2 ch][headParts][128 bins][re, im]`, then tail `[2][tailParts][2048 bins][re, im]`, f32,
/// bin 0 holding DC in `re` and Nyquist in `im` as `convolver.rs`; normalisation baked in.
const ZONE_KERNEL_HEADER_FIELDS: &[Field] = &[
    Field::new("magic", Ty::U32).doc("ZONE_KERNEL_MAGIC, 'MYIR'"),
    Field::new("version", Ty::U32).doc("ZONE_KERNEL_VERSION (1)"),
    Field::new("irFrames", Ty::U32).doc("the IR's length in frames after trimming"),
    Field::new("sampleRate", Ty::F32).doc("the context rate it was prepared at"),
    Field::new("headParts", Ty::U32).doc("head partitions of 128 bins, at most 32"),
    Field::new("tailParts", Ty::U32).doc("tail partitions of 2,048 bins"),
    Field::new("flags", Ty::U32).flags(&[Bits::bit("sourceMono", 0, "the source IR was mono (both channels' kernels are equal)")]),
    Field::new("reserved", Ty::U32),
];

/// Format 4 (MagLS filters) first-chunk header, 32 B (C6, §4.5). f32 time responses
/// `[16 channels][2 ears][taps]` follow at the context rate; the core transforms them at commit.
const MAGLS_HEADER_FIELDS: &[Field] = &[
    Field::new("magic", Ty::U32).doc("MAGLS_MAGIC, 'MYBD'"),
    Field::new("version", Ty::U32).doc("MAGLS_VERSION (1)"),
    Field::new("order", Ty::U32).doc("ambisonic order, 3"),
    Field::new("taps", Ty::U32).doc("taps per response: MAGLS_TAPS (256) at up to 48 kHz, MAGLS_TAPS_HIGH_RATE (512) above 88.2 kHz"),
    Field::new("sampleRate", Ty::F32).doc("the rate of the responses (the context rate)"),
    Field::new("reserved", Ty::U32).array(3),
];

/// The blob headers of ADR 0162 (formats 3 and 4). Format 5 (zone IR PCM) has none.
pub const BLOB_HEADERS: &[BlobHeader] = &[
    BlobHeader { name: "ZoneKernelHeader", fields: ZONE_KERNEL_HEADER_FIELDS, doc: "First-chunk header of a format = 3 (prepared zone kernel) CLIP_CHUNK payload." },
    BlobHeader { name: "MaglsHeader", fields: MAGLS_HEADER_FIELDS, doc: "First-chunk header of a format = 4 (MagLS filters) CLIP_CHUNK payload." },
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gen::layout::{opcode_item, padded_bytes, resolve};

    fn size(fields: &[Field]) -> u32 {
        fields.iter().map(|f| f.bytes()).sum()
    }

    #[test]
    fn set_voice_fx_is_52_bytes_at_the_c3_offsets() {
        let it = opcode_item(&SET_VOICE_FX).unwrap();
        let at: Vec<(&str, u32)> = it.fields.iter().map(|p| (p.field.name, p.offset)).collect();
        assert_eq!(at, vec![("mask", 12), ("rampFrames", 16), ("hpHz", 20), ("send", 24), ("yaw", 40), ("auxLevel", 44), ("auxBus", 48), ("reserved", 50)]);
        assert_eq!(it.fixed_end, 52);
    }

    #[test]
    fn listener_is_36_bytes_at_the_c4_offsets() {
        let it = opcode_item(&LISTENER).unwrap();
        let at: Vec<(&str, u32)> = it.fields.iter().map(|p| (p.field.name, p.offset)).collect();
        assert_eq!(at, vec![("qx", 12), ("qy", 16), ("qz", 20), ("qw", 24), ("rampFrames", 28), ("flags", 32)]);
        assert_eq!(it.fixed_end, 36);
    }

    #[test]
    fn bed_config_sizes_follow_c2() {
        let it = opcode_item(&BED_CONFIG).unwrap();
        assert_eq!(it.fixed_end, 20);
        // 20 + pad4(busCount) + pad4(2 x slotCount): 5 buses and 3 slots are 20 + 8 + 8.
        assert_eq!(20 + padded_bytes(Ty::U8, 5) + padded_bytes(Ty::U16, 3), 36);
        assert_eq!(padded_bytes(Ty::U8, 0) + padded_bytes(Ty::U16, 0), 0);
    }

    #[test]
    fn zone_config_is_24_plus_16_per_slot() {
        let it = opcode_item(&ZONE_CONFIG).unwrap();
        assert_eq!(it.fixed_end, 24);
        assert_eq!(it.group.as_ref().unwrap().item.fixed_end, 16);
        let (slot, _) = resolve(0, ZONE_CONFIG_SLOTS.item).unwrap();
        let at: Vec<u32> = slot.iter().map(|p| p.offset).collect();
        assert_eq!(at, vec![0, 4, 6, 7, 8, 12]);
        assert_eq!(24 + 16 * 3, 72);
    }

    #[test]
    fn status_items_and_blob_headers() {
        assert_eq!(size(BEDS_ITEM), 8);
        assert_eq!(size(ZONES_ITEM), 12);
        assert_eq!(size(ZONE_EVENTS_ITEM), 4);
        for b in BLOB_HEADERS {
            assert_eq!(size(b.fields), 32, "{}", b.name);
        }
    }
}
