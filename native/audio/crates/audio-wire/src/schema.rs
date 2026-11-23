//! The audio wire schema as data (ADR 0157 section 4; contract K1). One definition for Rust and
//! TypeScript: `gen_wire` turns it into `src/generated.rs` and `wire.generated.ts`.
//!
//! This file (lead-owned) holds the constants, enums and **error codes** (section 5), and assembles
//! the transcribed tables: `envelope` (4.1), `batch` (4.2), `status` (4.3), ADR 0162's `spatial` and
//! ADR 0166's `music` (the M4 constants and enums; the M4 fields are in `batch` and `status`) and ADR 0171's
//! `mix` (the M5 constants, opcodes and STATUS items) and the Audio Studio's `studio` (ADRs 0342, 0346).
//!
//! **Schema hash.** First 16 bytes of SHA-256 over `SCHEMA_SOURCES` (see `schema_hash`). The generated
//! TypeScript embeds it, the wasm exports `myco_audio_schema_hash()`, and `wire.schemaHash.test.ts`
//! recomputes it from these files with `node:crypto`. Adding a file under `schema/` means adding it
//! to `SCHEMA_SOURCES` (a unit test fails otherwise).

pub mod batch;
pub mod envelope;
pub mod generator;
pub mod mix;
pub mod music;
pub mod spatial;
pub mod status;
pub mod studio;

use crate::model::{Const, Enum, ErrorCode, Schema};

/// Files hashed into the schema hash, as `(path relative to the crate dir, contents)`, sorted by path.
pub const SCHEMA_SOURCES: &[(&str, &str)] = &[
    ("src/model.rs", include_str!("model.rs")),
    ("src/schema.rs", include_str!("schema.rs")),
    ("src/schema/batch.rs", include_str!("schema/batch.rs")),
    ("src/schema/envelope.rs", include_str!("schema/envelope.rs")),
    ("src/schema/generator.rs", include_str!("schema/generator.rs")),
    ("src/schema/mix.rs", include_str!("schema/mix.rs")),
    ("src/schema/music.rs", include_str!("schema/music.rs")),
    ("src/schema/spatial.rs", include_str!("schema/spatial.rs")),
    ("src/schema/status.rs", include_str!("schema/status.rs")),
    ("src/schema/studio.rs", include_str!("schema/studio.rs")),
];

/// `SHA-256( for each file in SCHEMA_SOURCES: path, 0x00, contents with CRLF turned into LF, 0x00 )`,
/// first 16 bytes. The TypeScript test builds the same byte string.
pub fn schema_hash() -> [u8; 16] {
    let mut data = Vec::new();
    for (path, text) in SCHEMA_SOURCES {
        data.extend_from_slice(path.as_bytes());
        data.push(0);
        data.extend_from_slice(text.replace("\r\n", "\n").as_bytes());
        data.push(0);
    }
    let full = crate::sha256::sha256(&data);
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

/// Lower-case hex of `schema_hash()`.
pub fn schema_hash_hex() -> String {
    schema_hash().iter().map(|b| format!("{b:02x}")).collect()
}

macro_rules! c {
    ($name:literal, $value:expr, $doc:literal) => {
        Const { name: $name, value: $value as u64, doc: $doc }
    };
}

/// The core's C ABI version, `(major, minor)` (api-and-models section 5): the minor for an added export, the major for a
/// change. Defined once here, beside the schema hash, so the wasm (`myco_audio_abi_version`), the shell and the capture
/// header read one value. 2.0 (ADR 0162 C8): nine init parameters and the kernel budget; 3.0 (ADR 0166 W1):
/// `max_music_rings`; 4.0 (ADR 0171/0172 M5): the 256 B STATUS header and the M5 opcodes; 5.0 (ADR 0327, 0328):
/// `myco_audio_init` reads the INIT record from the inbox, `myco_audio_memory_pages` and `myco_audio_memory_part_bytes`
/// replace `myco_audio_layout_bytes` and `myco_audio_zone_kernel_budget_bytes`, and a refusal names its field.
///
/// The Audio Studio's line, built on its own branch from 4.0 beside master's 5.0, so its numbers below were never
/// shipped together with master's: 4.1 (ADR 0346): CURVES keys carry Bézier handles (interp 5), 64 keys a curve;
/// 4.2 (ADR 0346): time parameters (binding `param` bit 14) and TIME (0x1D); 4.3 (ADR 0342): LOOPS (0x0B) loop
/// programs; 4.4 (ADR 0345, 0343): AUTOMATE targets 3 (highpass floor) and 4 (pan); 4.5 (ADR 0345): SUBMIX (0x0C);
/// 4.6 (ADR 0345 DSP): the catalogue's effect kinds on submixes and bus chains, eight effects a bus, the `FxMem` region;
/// 4.7 (ADR 0344): BUS_SENDS (0x1E); 4.9 (ADR 0345, 0346, 0350): SUBMIX `parent`, ROUTE (0x0D), AUTOMATE time
/// `offset`, LOOPS `shapes`; 4.10 (ADR 0344, 0345): BUS_AUTOMATE fx and send targets, SUBMIX_AUTOMATE (0x1F), held
/// parameters, the BUS_RAMP `Decibel` law, STATUS `fxStarved`; 4.11 (ADR 0347): SET_VOICE_FX `spread`; 4.12 (ADR 0351
/// A4, 0359 §5): CLIP_BEGIN format 6 (IMA ADPCM) and the `AdpcmCursors` region; 5.0 (ADR 0352, 0358): effect records
/// carry 16 parameters, plugin effect kinds `FX_PLUGIN_BASE + e` through the `myco_ext` import the shell supplies at
/// instantiation, plugin fuel per chain level, a 128 KB core-state region; 5.1 (ADR 0360): sound generators (reserved
/// `GEN_CLIP_ID_FIRST` clip ids, GEN (0x21), AUTOMATE target kind 5, STATUS `genStarved`, the `GenEntries` region).
///
/// 6.0 (the merge of both lines, 2026-11-23): master's 5.0 (the INIT record, the memory exports) with the Studio's 5.1
/// (the `myco_ext` import, 16-parameter effect records and the records above). Both 5.0s changed the ABI
/// incompatibly, so the joined core is a new major.
/// Owner decision D67 (ADR 0360) adds no version: the oscillator, synth and blip end their parameters with `quality`
/// (standard: two-sample PolyBLEP; high: a 16-tap minBLEP, read two samples late), so they have 11, 26 and 25, which GEN
/// (at most `GEN_PARAMS_MAX`, 32) and AUTOMATE target 5 carry as one more index; no record changes layout, and a core
/// without it ignores the index (plays `standard`).
///
/// 6.1 (ADR 0362 items 2 and 3): AMP_ENVELOPE (0x22), a clip voice's per-sample Amp envelope, and the PLAY flag
/// `reverse` (bit 9), a PCM clip voice read backwards. Both are additions an older shell never sends.
const CORE_ABI: (u64, u64) = (6, 1);

/// Constants from section 4 and 5 that code on both sides needs.
pub const CONSTANTS: &[Const] = &[
    c!("CORE_ABI_MAJOR", CORE_ABI.0, "the core's C ABI major (`myco_audio_abi_version() >> 8`); a shell refuses a different one"),
    c!("CORE_ABI_MINOR", CORE_ABI.1, "the core's C ABI minor (an added export)"),
    c!("CORE_ABI_VERSION", (CORE_ABI.0 << 8) | CORE_ABI.1, "`(CORE_ABI_MAJOR << 8) | CORE_ABI_MINOR`: `myco_audio_abi_version()`, STATUS `abiVersion` and the capture header"),
    c!("MAGIC", 0x4D59_4131u32, "envelope magic, 'MYA1'"),
    c!("VERSION_MAJOR", 1, "a core refuses a different major"),
    c!("VERSION_MINOR", 3, "new opcodes or appended payload words are minor (1.1: ADR 0162; 1.2: the shape word, ADR 0166; 1.3: the M5 mix opcodes, ADR 0171)"),
    c!("ENVELOPE_BYTES", 16, "envelope size"),
    c!("BATCH_HEADER_BYTES", 16, "f64 firstFrame; u32 count; u32 flags"),
    c!("RECORD_HEAD_BYTES", 12, "u16 opcode; u16 words; u32 voiceId; u32 frameOffset"),
    c!("ASAP", 0xFFFF_FFFFu32, "frameOffset: apply on arrival at the next quantum, never counted late"),
    c!("BATCH_MAX_BYTES", 64 * 1024, "a BATCH is capped at 64 KB; the excess carries over"),
    c!("INBOX_BYTES", 1024 * 1024, "the fixed 1 MiB inbox"),
    c!("REPLAY_CHUNK_MAX_BYTES", 1024 * 1024 - 32, "each REPLAY message: 1 MiB minus 32 bytes"),
    c!("STATUS_HEADER_BYTES", 256, "STATUS header, envelope included (256 B with the M5 fields, ADR 0171 API section 4.3; 176 B in M4)"),
    c!("STATUS_POOL_BUFFERS", 8, "the shell's pool of STATUS buffers"),
    c!("STATUS_BUFFER_BYTES", 20480, "size of each STATUS buffer (20 KB with the M5 sections)"),
    c!("STATUS_WORST_CASE_BYTES", 17824, "256 + 4096*3 + 2048 + 512 + 512 + 256 + 32 + 48 + 64 + 128 + 128 + 144 + 1152 + 256"),
    c!("STATUS_EVERY_QUANTA", 6, "STATUS cadence"),
    c!("STATUS_IDLE_EVERY_QUANTA", 48, "cadence when no batch arrived for 250 ms"),
    c!("STATUS_IDLE_AFTER_MS", 250, "idle threshold"),
    c!("QUANTUM_FRAMES", 128, "frames per process() call"),
    c!("BUS_ROOT", 0xFFFF, "BUS_CONFIG parent of the root bus"),
    c!("BUS_LP_OFF_HZ", 24000, "BUS_MIX and BUS_RAMP lpHz meaning off"),
    c!("STREAM_TOTAL_FRAMES_UNKNOWN", 0xFFFF_FFFFu32, "STREAM_OPEN totalFrames"),
    c!("HRIR_CLIP_ID_FIRST", 0xFFFF_0000u32, "reserved clip ids for format = 2"),
    c!("HRIR_CLIP_ID_LAST", 0xFFFF_00FFu32, "reserved clip ids for format = 2"),
    c!("CLIP_ID_RESERVED_FIRST", 0xFFFF_0000u32, "ids from here up are not allocated to ordinary clips"),
    c!("STREAM_RING_FRAMES", 32768, "stream ring size (section 5)"),
    c!("STREAM_RING_FRAMES_WIDE", 32768, "wide (3-16 channel) stream ring size (ADR 0162 R16, §5.2; 32,768 after B4's 300 ms stall test failed at 16,384)"),
    c!("STREAM_WIDE_CHUNK_FRAMES", 2048, "frames per chunk of a wide stream (128 KB at 16 channels)"),
    c!("STREAM_MAX_CHANNELS", 16, "most channels of a stream (STREAM_OPEN)"),
    c!("MAX_BEDS", 4, "most bed slots (BED_CONFIG slotCount, STATUS beds)"),
    c!("MAX_ZONE_SLOTS", 4, "most zone slots (ZONE_CONFIG slotCount, SET_VOICE_FX send, STATUS zones)"),
    c!("MAX_ZONE_EVENTS_PER_BLOCK", 16, "STATUS zoneEvents cap"),
    c!("BED_CHANNELS", 16, "channels of a bed: third-order ambisonics, ACN/SN3D"),
    c!("BED_SLOT_NONE", 0xFF, "BED_CONFIG bedSlot: the bus has no bed"),
    c!("BED_HOST_NONE", 0xFFFF, "BED_CONFIG hostBus: the slot is unused"),
    c!("AUX_BUS_NONE", 0xFFFF, "SET_VOICE_FX auxBus: no aux send"),
    c!("PANNER_BED", 2, "the panner value 2 (bed) of PLAY and SET_PARAMS flags bits 5-6"),
    c!("AMBI_FLAG", 0x80, "PLAY flags bit 7: an ambisonic voice"),
    c!("LP_TOP", 20000, "lpHz at or above this is no low-pass"),
    c!("HP_BOTTOM", 20, "SET_VOICE_FX hpHz at or below this is no high-pass"),
    c!("MAGLS_CLIP_ID", 0xFFFF_0100u32, "the reserved clip id of the MagLS filters (format 4)"),
    c!("ZONE_KERNEL_ID_FIRST", 0xFFFF_0200u32, "reserved clip ids of zone kernels (formats 3 and 5)"),
    c!("ZONE_KERNEL_ID_LAST", 0xFFFF_02FFu32, "reserved clip ids of zone kernels (formats 3 and 5)"),
    c!("ZONE_KERNEL_MAGIC", 0x5249_594Du32, "format 3 header magic, 'MYIR'"),
    c!("ZONE_KERNEL_VERSION", 1, "format 3 header version"),
    c!("ZONE_KERNEL_HEADER_BYTES", 32, "format 3 header size"),
    c!("ZONE_KERNEL_MAX_HEAD_PARTS", 32, "format 3 headParts cap"),
    c!("ZONE_HEAD_BINS", 128, "bins per head partition of a zone kernel"),
    c!("ZONE_TAIL_BINS", 2048, "bins per tail partition of a zone kernel"),
    c!("MAGLS_MAGIC", 0x4442_594Du32, "format 4 header magic, 'MYBD'"),
    c!("MAGLS_VERSION", 1, "format 4 header version"),
    c!("MAGLS_HEADER_BYTES", 32, "format 4 header size"),
    c!("MAGLS_ORDER", 3, "ambisonic order of the MagLS filters"),
    c!("MAGLS_TAPS", 256, "taps per MagLS response at up to 48 kHz"),
    c!("MAGLS_TAPS_HIGH_RATE", 512, "taps per MagLS response above 88.2 kHz"),
    c!("MAX_ENDED_PER_BLOCK", 1024, "STATUS ended section cap"),
    c!("MAX_DEMOTED_PER_BLOCK", 1024, "STATUS demoted section cap"),
    c!("MAX_STARVED_PER_BLOCK", 1024, "STATUS starved section cap"),
    c!("MAX_PLAYHEADS_PER_BLOCK", 256, "STATUS playheads section cap, round-robin"),
    c!("MAX_CLIP_EVENTS_PER_BLOCK", 64, "STATUS clipEvents cap"),
    c!("MAX_STREAM_EVENTS_PER_BLOCK", 64, "STATUS streamEvents cap"),
    c!("ADPCM_BLOCK_FRAMES", 1024, "frames per channel in one block of a format 6 (IMA ADPCM) clip (ADR 0351 §3, 0359 §5)"),
    c!("ADPCM_CHANNEL_BYTES", 516, "bytes per channel per block of a format 6 clip: a 4-byte header, then 512 bytes of codes"),
    c!("ERR_OK", 0, "i32 result: ok"),
];

macro_rules! en {
    ($name:literal, $doc:literal, [$(($v:literal, $n:expr, $d:literal)),* $(,)?]) => {
        Enum { name: $name, doc: $doc, variants: &[$(($v, $n, $d)),*] }
    };
}

/// Enumerations used by field values.
pub const ENUMS: &[Enum] = &[
    en!("ClipFormat", "CLIP_BEGIN format", [
        ("F32", 0, "float samples"),
        ("I16", 1, "int16 samples"),
        ("HRIR", 2, "HRIR: int16, already at the context rate; ids 0xFFFF0000..0xFFFF00FF"),
        ("ZoneKernel", 3, "prepared zone kernel: ZoneKernelHeader then packed spectra; channels 1, frames = bytes / 4"),
        ("MagLS", 4, "MagLS filters: MaglsHeader then f32 [16][2][taps]; id 0xFFFF0100"),
        ("ZoneIrPcm", 5, "zone IR PCM: interleaved stereo f32 at the context rate; the core prepares it"),
        ("AdpcmIma", 6, "IMA ADPCM blocks (ADR 0351 §3, 0359 §5): channels 1 or 2, ADPCM_BLOCK_FRAMES frames of ADPCM_CHANNEL_BYTES per channel per block; chunks start on a block and carry whole blocks; decoded per voice"),
    ]),
    en!("ClipEvent", "STATUS clipEvents code", [
        ("Resident", 1, "the last range was committed"),
        ("RefusedCeiling", 2, "clipMemoryMB ceiling"),
        ("RefusedGrow", 3, "the arena could not grow"),
        ("HrtfReady", 4, "the HRIR load completed"),
        ("RefusedFormat", 5, "the clip's format or channel count is not accepted (ADR 0162)"),
    ]),
    en!("StreamEvent", "STATUS streamEvents code", [
        ("Starved", 1, "the ring ran dry"),
        ("Eos", 2, "end of stream"),
        ("Error", 3, "decode error"),
        ("MusicFull", 4, "a music STREAM_OPEN found no free music ring (ADR 0167 R7)"),
    ]),
    en!("HrtfLoadFailure", "STATUS hrtfLoadFailure", [
        ("None", 0, "no failure"),
        ("Fetch", 1, "the HRIR asset could not be fetched"),
        ("Data", 2, "the HRIR data was invalid"),
    ]),
    en!("Panner", "PLAY and SET_PARAMS flags bits 5-6", [
        ("EqualPower", 0, "equal-power"),
        ("Hrtf", 1, "HRTF"),
        ("Bed", 2, "encode into the bus's bed slot; equal-power when it has none (ADR 0162 C1)"),
        ("Reserved3", 3, "reserved"),
    ]),
    en!("StreamConvention", "STREAM_OPEN convention", [
        ("AmbiX", 0, "ACN order, SN3D"),
        ("FuMa", 1, "Furse-Malham; the worker converts to AmbiX per chunk"),
    ]),
    en!("ZoneSlotState", "ZONE_CONFIG slot state", [
        ("Active", 1, "sends accepted; wet fades in over 100 ms once the kernel is resident"),
        ("Release", 2, "sends ignored; the tail rings out, then the slot is off"),
        ("Evict", 3, "sends ignored; wet fades out over 150 ms, then the slot is off (low preset)"),
    ]),
    en!("ZoneState", "STATUS zones state", [
        ("Off", 0, "no kernel"),
        ("WaitingKernel", 1, "active, the kernel is not resident yet"),
        ("FadingIn", 2, "fading in over 100 ms"),
        ("Active", 3, "active"),
        ("RingingOut", 4, "released; the tail rings out"),
        ("Evicting", 5, "evicted; wet fades out over 150 ms"),
    ]),
    en!("ZoneEvent", "STATUS zoneEvents code", [
        ("RefusedKernel", 1, "a new kernelId in a slot that is not off"),
        ("RefusedSlot", 2, "a slot past max_zone_slots"),
        ("BadBlob", 3, "a zone kernel blob that does not fit its header"),
    ]),
    en!("EffectType", "BUS_CONFIG effect type", [
        ("Lowpass", 0, "p0 frequency Hz, p1 q in dB"),
        ("Highpass", 1, "p0 frequency Hz, p1 q in dB"),
        ("Compressor", 2, "threshold dB, knee dB, ratio, attack s, release s"),
        ("ReverbSend", 3, "p0 send"),
    ]),
    en!("MemoryPart", "`myco_audio_memory_part_bytes` part (ADR 0327): bytes the core takes for the INIT record in the inbox", [
        ("Layout", 0, "the block `myco_audio_init` takes: every fixed region and the arena's initial reserve, in whole pages"),
        ("Beds", 1, "the `Beds` region: bed slots and the wide streams' private decoders"),
        ("Zones", 2, "the `Zones` region: zone convolver slots, the aux accumulator and the sends area"),
        ("Wide", 3, "the `Wide` region: 16-channel stream rings"),
        ("ZoneKernels", 4, "the zone kernel budget: prepared kernels in the arena, outside clipMemoryMB"),
        ("SpatialData", 5, "the HRIR table, its HRTF bank and the MagLS filters in the arena, outside clipMemoryMB"),
    ]),
];

macro_rules! er {
    ($name:literal, $v:expr, $doc:literal) => {
        ErrorCode { name: $name, value: $v, doc: $doc }
    };
}

/// Negative `i32` results of the C ABI (section 5: "negative codes in `schema.rs`"). `0` is ok.
/// A0.1's stubs return `NOT_IMPLEMENTED`. Appending a code is minor; never renumber one.
pub const ERRORS: &[ErrorCode] = &[
    er!("NOT_IMPLEMENTED", -1, "K2 stub: the export exists but does nothing yet"),
    er!("BAD_ARG", -2, "an argument is out of range"),
    er!("BAD_MAGIC", -3, "envelope magic mismatch"),
    er!("VERSION_MISMATCH", -4, "a different major version (counted, STATUS flag bit0)"),
    er!("TRUNCATED", -5, "the message or a record is shorter than its header says"),
    er!("OVERSIZE", -6, "length over the inbox, BATCH or record cap"),
    er!("BAD_STATE", -7, "not initialised, or called in the wrong state"),
    er!("INBOX_OVERFLOW", -8, "the inbox could not take the message (STATUS flag bit2)"),
    er!("ARENA_FULL", -9, "no slab of the class and the arena cannot grow (STATUS flag bit1)"),
    er!("CEILING", -10, "clip memory ceiling reached"),
    er!("UNKNOWN_CLIP", -11, "no such clip id"),
    er!("STALE_ID", -12, "id generation mismatch (stale handle or chunk)"),
    er!("STALE_EPOCH", -13, "stream chunk of an old epoch, dropped"),
    er!("UNKNOWN_STREAM", -14, "no such stream id"),
    er!("BAD_FORMAT", -15, "unsupported clip format, or an HRIR header that does not fit"),
    er!("MALFORMED", -16, "a record's fields are inconsistent (count versus length)"),
    // ADR 0328: `myco_audio_init` names the INIT field it refused: `INIT_` + the field's name.
    er!("INIT_SAMPLE_RATE", -17, "INIT sampleRate is outside 8 kHz..192 kHz"),
    er!("INIT_MAX_LOGICAL", -18, "INIT maxLogical is 0 or above 65,536"),
    er!("INIT_MAX_MIXED", -19, "INIT maxMixed is 0 or above maxLogical"),
    er!("INIT_MAX_BUSES", -20, "INIT maxBuses is 0 or above 256"),
    er!("INIT_MAX_BEDS", -21, "INIT maxBeds is above MAX_BEDS"),
    er!("INIT_MAX_ZONE_SLOTS", -22, "INIT maxZoneSlots is above MAX_ZONE_SLOTS"),
    er!("INIT_ZONE_MAX_FRAMES", -23, "INIT zoneMaxFrames is 0 or past 8 s at sampleRate while there are zone slots"),
    er!("INIT_MAX_WIDE", -24, "INIT maxWide is above 4"),
    er!("INIT_MAX_MUSIC_RINGS", -25, "INIT maxMusicRings is above MAX_MUSIC_RINGS"),
];

/// `CONSTANTS` followed by `music::CONSTANTS`, `mix::CONSTANTS`, `studio::CONSTANTS` and `generator::CONSTANTS`.
fn all_constants() -> &'static [Const] {
    static ALL: std::sync::OnceLock<Vec<Const>> = std::sync::OnceLock::new();
    ALL.get_or_init(|| CONSTANTS.iter().chain(music::CONSTANTS).chain(mix::CONSTANTS).chain(studio::CONSTANTS).chain(generator::CONSTANTS).copied().collect())
}

/// `ENUMS` followed by `music::ENUMS`.
fn all_enums() -> &'static [Enum] {
    static ALL: std::sync::OnceLock<Vec<Enum>> = std::sync::OnceLock::new();
    ALL.get_or_init(|| ENUMS.iter().chain(music::ENUMS).copied().collect())
}

/// The assembled schema. Cheap (static slices); the generator and tests call it freely.
pub fn schema() -> Schema {
    Schema {
        envelope: envelope::ENVELOPE,
        kinds: envelope::KINDS,
        batch_header: batch::BATCH_HEADER,
        record_head: batch::RECORD_HEAD,
        opcodes: batch::OPCODES,
        status: status::STATUS,
        hrir_header: envelope::HRIR_HEADER,
        blob_headers: spatial::BLOB_HEADERS,
        constants: all_constants(),
        enums: all_enums(),
        errors: ERRORS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `*.rs` under `src/schema/` plus `schema.rs` and `model.rs` is in `SCHEMA_SOURCES`.
    #[test]
    fn schema_sources_are_complete_and_sorted() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/schema");
        let mut found: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| format!("src/schema/{}", e.unwrap().file_name().to_string_lossy()))
            .filter(|p| p.ends_with(".rs"))
            .collect();
        found.push("src/model.rs".into());
        found.push("src/schema.rs".into());
        found.sort();
        let listed: Vec<String> = SCHEMA_SOURCES.iter().map(|(p, _)| p.to_string()).collect();
        assert_eq!(found, listed);
    }

    #[test]
    fn constant_names_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for c in all_constants() {
            assert!(seen.insert(c.name), "duplicate constant {}", c.name);
        }
    }

    /// ADR 0328: every `INIT_*` code names a field of the INIT record, so a refusal says which parameter.
    #[test]
    fn init_error_codes_name_init_fields() {
        let fields: Vec<String> = envelope::INIT_FIELDS.iter().map(|f| crate::gen::layout::screaming(f.name)).collect();
        let named: Vec<&str> = ERRORS.iter().filter_map(|e| e.name.strip_prefix("INIT_")).collect();
        assert_eq!(named.len(), 9);
        for n in named {
            assert!(fields.iter().any(|f| f == n), "INIT_{n} names no INIT field");
        }
    }

    #[test]
    fn error_codes_are_negative_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for e in ERRORS {
            assert!(e.value < 0, "{}", e.name);
            assert!(seen.insert(e.value), "duplicate {}", e.value);
        }
    }
}
