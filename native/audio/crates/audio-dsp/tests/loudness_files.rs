//! Ld6 (ADR 0171 amended by 0172, test plan): the EBU's own loudness test files, when present.
//!
//! **What it runs.** Set `EBU_FILES` to a folder holding the EBU loudness test set (Tech 3341
//! "seq-3341-*" and Tech 3342 "seq-3342-*" WAVs, any subfolder layout flattened into that folder)
//! and [`ebu_reference_files`] reads every file it recognises, runs it through Ld1's meter
//! (`audio_dsp::loudness::Meter`, 128-frame quanta, a STATUS take every 6) and the main half's
//! exact gating, and checks the published expectation: integrated ±0.1 LU, LRA ±1 LU, maximum
//! momentary and short-term ±0.1 LU, true peak +0.2 / −0.4 dB. Without `EBU_FILES` it prints why
//! it skipped and passes. A file is recognised by its published name's prefix (`seq-3341-7_`,
//! `seq-3341-15-`, …), so the "-v02" and ".wav.wav" spellings of the set's releases all match.
//!
//! **Unverified here.** The EBU and ITU hosts are blocked in the build environment, so the real
//! files have never been run; the file names and expected values below are Tech 3341 (2016) and
//! Tech 3342 (2016) as recalled, not checked against the documents. The multichannel case
//! (3341-6, five channels) is reported as skipped: the meter is stereo (ARCH §4.4). The
//! "constant" momentary and short-term cases (3341-9, -12) are checked as the maximum reading, and
//! the multi-segment ones (3341-11, -14) as the maximum over the whole file, not per segment: the
//! segment edges aren't known without the files.
//!
//! **The harness's own tests** write synthesised stand-ins under the published names to a
//! temporary folder (16-bit, 24-bit and float WAVE_FORMAT_EXTENSIBLE files, a five-channel file)
//! and check that the right files run, pass, are skipped, and that a wrong level is reported.

mod loudness_common;

use loudness_common::{dbf, feed, stats};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- the published table

/// One expectation of a test file.
#[derive(Clone, Copy, Debug)]
enum Check {
    /// Integrated loudness, LUFS ± LU.
    I(f64, f64),
    /// Loudness range, LU ± LU.
    Lra(f64, f64),
    /// The highest momentary reading, LUFS ± LU.
    MaxM(f64, f64),
    /// The highest short-term reading, LUFS ± LU.
    MaxS(f64, f64),
    /// The true peak (max over channels), dBTP, within (−below, +above).
    Tp(f64, f64, f64),
}

const I23: Check = Check::I(-23.0, 0.1);
const M23: Check = Check::MaxM(-23.0, 0.1);
const S23: Check = Check::MaxS(-23.0, 0.1);
const fn tp(v: f64) -> Check {
    Check::Tp(v, 0.4, 0.2)
}

/// A test file of the set: its id, the prefixes (lower case) its names start with, its checks.
struct Case {
    id: &'static str,
    prefixes: &'static [&'static str],
    checks: &'static [Check],
}

const fn case(id: &'static str, prefixes: &'static [&'static str], checks: &'static [Check]) -> Case {
    Case { id, prefixes, checks }
}

macro_rules! numbered {
    ($series:literal, $check:expr) => {
        [
            case(concat!("3341-", $series, "-1"), &[concat!("seq-3341-", $series, "-1-")], &[$check]),
            case(concat!("3341-", $series, "-2"), &[concat!("seq-3341-", $series, "-2-")], &[$check]),
            case(concat!("3341-", $series, "-3"), &[concat!("seq-3341-", $series, "-3-")], &[$check]),
            case(concat!("3341-", $series, "-4"), &[concat!("seq-3341-", $series, "-4-")], &[$check]),
            case(concat!("3341-", $series, "-5"), &[concat!("seq-3341-", $series, "-5-")], &[$check]),
            case(concat!("3341-", $series, "-6"), &[concat!("seq-3341-", $series, "-6-")], &[$check]),
            case(concat!("3341-", $series, "-7"), &[concat!("seq-3341-", $series, "-7-")], &[$check]),
            case(concat!("3341-", $series, "-8"), &[concat!("seq-3341-", $series, "-8-")], &[$check]),
            case(concat!("3341-", $series, "-9"), &[concat!("seq-3341-", $series, "-9-")], &[$check]),
            case(concat!("3341-", $series, "-10"), &[concat!("seq-3341-", $series, "-10-")], &[$check]),
            case(concat!("3341-", $series, "-11"), &[concat!("seq-3341-", $series, "-11-")], &[$check]),
            case(concat!("3341-", $series, "-12"), &[concat!("seq-3341-", $series, "-12-")], &[$check]),
            case(concat!("3341-", $series, "-13"), &[concat!("seq-3341-", $series, "-13-")], &[$check]),
            case(concat!("3341-", $series, "-14"), &[concat!("seq-3341-", $series, "-14-")], &[$check]),
            case(concat!("3341-", $series, "-15"), &[concat!("seq-3341-", $series, "-15-")], &[$check]),
            case(concat!("3341-", $series, "-16"), &[concat!("seq-3341-", $series, "-16-")], &[$check]),
            case(concat!("3341-", $series, "-17"), &[concat!("seq-3341-", $series, "-17-")], &[$check]),
            case(concat!("3341-", $series, "-18"), &[concat!("seq-3341-", $series, "-18-")], &[$check]),
            case(concat!("3341-", $series, "-19"), &[concat!("seq-3341-", $series, "-19-")], &[$check]),
            case(concat!("3341-", $series, "-20"), &[concat!("seq-3341-", $series, "-20-")], &[$check]),
        ]
    };
}

const MAIN: &[Case] = &[
    // Tech 3341: integrated, momentary and short-term of steady and stepped 1 kHz sines
    case("3341-1", &["seq-3341-1-"], &[I23, M23, S23]),
    case("3341-2", &["seq-3341-2-"], &[Check::I(-33.0, 0.1), Check::MaxM(-33.0, 0.1), Check::MaxS(-33.0, 0.1)]),
    case("3341-3", &["seq-3341-3-"], &[I23]),
    case("3341-4", &["seq-3341-4-"], &[I23]),
    case("3341-5", &["seq-3341-5-"], &[I23]),
    case("3341-6", &["seq-3341-6-"], &[I23]),
    // authentic programme (also Tech 3342's cases 5 and 6)
    case("3341-7 / 3342-5", &["seq-3341-7_", "seq-3341-7-"], &[I23, Check::Lra(5.0, 1.0)]),
    case("3341-8 / 3342-6", &["seq-3341-2011-8_", "seq-3341-8_", "seq-3341-8-"], &[I23, Check::Lra(15.0, 1.0)]),
    case("3341-9", &["seq-3341-9-"], &[S23]),
    case("3341-11", &["seq-3341-11-"], &[S23]),
    case("3341-12", &["seq-3341-12-"], &[M23]),
    case("3341-14", &["seq-3341-14-"], &[M23]),
    // true peak
    case("3341-15", &["seq-3341-15-"], &[tp(-6.0)]),
    case("3341-16", &["seq-3341-16-"], &[tp(-6.0)]),
    case("3341-17", &["seq-3341-17-"], &[tp(-6.0)]),
    case("3341-18", &["seq-3341-18-"], &[tp(-6.0)]),
    case("3341-19", &["seq-3341-19-"], &[tp(3.0)]),
    case("3341-20", &["seq-3341-20-"], &[tp(0.0)]),
    case("3341-21", &["seq-3341-21-"], &[tp(0.0)]),
    case("3341-22", &["seq-3341-22-"], &[tp(0.0)]),
    case("3341-23", &["seq-3341-23-"], &[tp(0.0)]),
    // Tech 3342: loudness range of stepped sines
    case("3342-1", &["seq-3342-1-"], &[Check::Lra(10.0, 1.0)]),
    case("3342-2", &["seq-3342-2-"], &[Check::Lra(5.0, 1.0)]),
    case("3342-3", &["seq-3342-3-"], &[Check::Lra(20.0, 1.0)]),
    case("3342-4", &["seq-3342-4-"], &[Check::Lra(15.0, 1.0)]),
];

/// Tech 3341 cases 10 (20 files, maximum short-term) and 13 (20 files, maximum momentary).
const SERIES_10: [Case; 20] = numbered!("10", S23);
const SERIES_13: [Case; 20] = numbered!("13", M23);

fn all_cases() -> impl Iterator<Item = &'static Case> {
    MAIN.iter().chain(SERIES_10.iter()).chain(SERIES_13.iter())
}

// ---------------------------------------------------------------- WAV reading

/// A decoded WAV: rate and one `Vec<f32>` per channel.
#[derive(Debug)]
struct Wav {
    rate: u32,
    channels: Vec<Vec<f32>>,
}

/// PCM 16, 24 and 32-bit, IEEE float 32 and 64-bit, plain or WAVE_FORMAT_EXTENSIBLE.
fn read_wav(bytes: &[u8]) -> Result<Wav, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let u16le = |b: &[u8], o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
    let u32le = |b: &[u8], o: usize| u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    let (mut fmt, mut data) = (None, None);
    let mut o = 12;
    while o + 8 <= bytes.len() {
        let id = &bytes[o..o + 4];
        let len = u32le(bytes, o + 4) as usize;
        let body = &bytes[o + 8..(o + 8 + len).min(bytes.len())];
        match id {
            b"fmt " => fmt = Some(body),
            b"data" => data = Some(body),
            _ => {}
        }
        o += 8 + len + (len & 1);
    }
    let fmt = fmt.ok_or("no fmt chunk")?;
    let data = data.ok_or("no data chunk")?;
    if fmt.len() < 16 {
        return Err("short fmt chunk".into());
    }
    let mut tag = u16le(fmt, 0);
    let ch = u16le(fmt, 2) as usize;
    let rate = u32le(fmt, 4);
    let bits = u16le(fmt, 14) as usize;
    if tag == 0xFFFE {
        if fmt.len() < 26 {
            return Err("short WAVE_FORMAT_EXTENSIBLE fmt chunk".into());
        }
        tag = u16le(fmt, 24); // the sub-format GUID's first two bytes
    }
    if ch == 0 || bits % 8 != 0 {
        return Err(format!("{ch} channels, {bits} bits"));
    }
    let width = bits / 8;
    let sample = |s: &[u8]| -> Option<f32> {
        Some(match (tag, bits) {
            (1, 16) => i16::from_le_bytes([s[0], s[1]]) as f32 / 32_768.0,
            (1, 24) => (i32::from_le_bytes([0, s[0], s[1], s[2]]) >> 8) as f32 / 8_388_608.0,
            (1, 32) => (i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64 / 2_147_483_648.0) as f32,
            (3, 32) => f32::from_le_bytes([s[0], s[1], s[2], s[3]]),
            (3, 64) => f64::from_le_bytes(s[..8].try_into().unwrap()) as f32,
            _ => return None,
        })
    };
    let frames = data.len() / (width * ch);
    let mut channels = vec![Vec::with_capacity(frames); ch];
    for f in 0..frames {
        for (c, out) in channels.iter_mut().enumerate() {
            let at = (f * ch + c) * width;
            out.push(sample(&data[at..at + width]).ok_or_else(|| format!("format tag {tag}, {bits} bits: unsupported"))?);
        }
    }
    Ok(Wav { rate, channels })
}

// ---------------------------------------------------------------- the harness

/// The meter's readings of one file.
#[derive(Debug)]
struct Readings {
    i: f64,
    lra: f64,
    max_m: f64,
    max_s: f64,
    tp_db: f64,
}

fn measure(w: &Wav) -> Readings {
    let rate = w.rate as f64;
    let zeros;
    let (l, r) = match w.channels.len() {
        // mono: BS.1770's single channel, weight 1 (the meter's L + R sum with R silent)
        1 => {
            zeros = vec![0.0f32; w.channels[0].len()];
            (&w.channels[0][..], &zeros[..])
        }
        _ => (&w.channels[0][..], &w.channels[1][..]),
    };
    let fed = feed(rate, l, r, 6);
    let subs: Vec<f64> = fed.subs.iter().map(|&e| e as f64).collect();
    let all = stats(&subs);
    let lufs = audio_dsp::loudness::lufs;
    let mean = |x: &[f64]| x.iter().sum::<f64>() / x.len() as f64;
    let max_m = subs.windows(4).map(|w| lufs(mean(w))).fold(f64::NEG_INFINITY, f64::max);
    let max_s = subs.windows(30).map(|w| lufs(mean(w))).fold(f64::NEG_INFINITY, f64::max);
    Readings { i: all.i, lra: all.lra, max_m, max_s, tp_db: dbf(fed.peak[0].max(fed.peak[1]) as f64) }
}

/// What a check read, and whether it passed.
fn judge(c: Check, r: &Readings) -> (String, bool) {
    let within = |got: f64, want: f64, below: f64, above: f64| got >= want - below && got <= want + above;
    match c {
        Check::I(v, t) => (format!("I {:.3} LUFS (want {v} ± {t})", r.i), within(r.i, v, t, t)),
        Check::Lra(v, t) => (format!("LRA {:.3} LU (want {v} ± {t})", r.lra), within(r.lra, v, t, t)),
        Check::MaxM(v, t) => (format!("max M {:.3} LUFS (want {v} ± {t})", r.max_m), within(r.max_m, v, t, t)),
        Check::MaxS(v, t) => (format!("max S {:.3} LUFS (want {v} ± {t})", r.max_s), within(r.max_s, v, t, t)),
        Check::Tp(v, below, above) => (format!("TP {:.3} dBTP (want {v} −{below}/+{above})", r.tp_db), within(r.tp_db, v, below, above)),
    }
}

/// A run over a folder.
#[derive(Default, Debug)]
struct Report {
    /// (case id, file name, one line per check)
    ran: Vec<(String, String, Vec<String>)>,
    /// (case id, file name, why)
    skipped: Vec<(String, String, String)>,
    /// Case ids with no file in the folder.
    absent: Vec<String>,
    /// One line per failed check or unreadable file.
    failures: Vec<String>,
}

fn run_dir(dir: &Path) -> Report {
    let mut names: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("EBU_FILES={}: {e}", dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| (e.file_name().to_string_lossy().to_lowercase(), e.path()))
        .filter(|(n, _)| n.ends_with(".wav"))
        .collect();
    names.sort();
    let mut rep = Report::default();
    for c in all_cases() {
        let Some((name, path)) = names.iter().find(|(n, _)| c.prefixes.iter().any(|p| n.starts_with(p))) else {
            rep.absent.push(c.id.into());
            continue;
        };
        let wav = match std::fs::read(path).map_err(|e| e.to_string()).and_then(|b| read_wav(&b)) {
            Ok(w) => w,
            Err(e) => {
                rep.failures.push(format!("{} ({name}): {e}", c.id));
                continue;
            }
        };
        if wav.channels.len() > 2 {
            rep.skipped.push((c.id.into(), name.clone(), format!("{} channels: the meter is stereo (ARCH §4.4)", wav.channels.len())));
            continue;
        }
        let r = measure(&wav);
        let mut lines = Vec::new();
        for &chk in c.checks {
            let (line, ok) = judge(chk, &r);
            if !ok {
                rep.failures.push(format!("{} ({name}): {line}", c.id));
            }
            lines.push(format!("{} {line}", if ok { "ok  " } else { "FAIL" }));
        }
        rep.ran.push((c.id.into(), name.clone(), lines));
    }
    rep
}

fn print(rep: &Report) {
    for (id, name, lines) in &rep.ran {
        eprintln!("{id} ({name}):");
        for l in lines {
            eprintln!("    {l}");
        }
    }
    for (id, name, why) in &rep.skipped {
        eprintln!("{id} ({name}): skipped, {why}");
    }
    if !rep.absent.is_empty() {
        eprintln!("not in the folder: {}", rep.absent.join(", "));
    }
}

/// The real files, when `EBU_FILES` names their folder.
#[test]
fn ebu_reference_files() {
    let Some(dir) = std::env::var_os("EBU_FILES") else {
        eprintln!("EBU_FILES is not set: skipping the EBU Tech 3341/3342 reference files (set it to the folder holding seq-3341-*.wav and seq-3342-*.wav to run them)");
        return;
    };
    let rep = run_dir(Path::new(&dir));
    print(&rep);
    assert!(!rep.ran.is_empty() || !rep.failures.is_empty(), "EBU_FILES={}: no seq-3341-*/seq-3342-* WAV found", Path::new(&dir).display());
    assert!(rep.failures.is_empty(), "{} failed:\n{}", rep.failures.len(), rep.failures.join("\n"));
}

// ---------------------------------------------------------------- the harness's own tests

/// A temporary folder, removed on drop.
struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        let p = std::env::temp_dir().join(format!("myco-ld6-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Copy)]
enum Enc {
    Pcm16,
    Pcm24,
    /// IEEE float 32, WAVE_FORMAT_EXTENSIBLE.
    FloatExt,
}

fn write_wav(path: &Path, rate: u32, channels: &[Vec<f32>], enc: Enc) {
    let (tag, bits) = match enc {
        Enc::Pcm16 => (1u16, 16u16),
        Enc::Pcm24 => (1, 24),
        Enc::FloatExt => (3, 32),
    };
    let ext = matches!(enc, Enc::FloatExt);
    let ch = channels.len() as u16;
    let width = bits as usize / 8;
    let mut data = Vec::new();
    for f in 0..channels[0].len() {
        for c in channels {
            let x = c[f].clamp(-1.0, 1.0);
            match enc {
                Enc::Pcm16 => data.extend_from_slice(&((x * 32_767.0).round() as i16).to_le_bytes()),
                Enc::Pcm24 => data.extend_from_slice(&((x * 8_388_607.0).round() as i32).to_le_bytes()[..3]),
                Enc::FloatExt => data.extend_from_slice(&x.to_le_bytes()),
            }
        }
    }
    let mut fmt = Vec::new();
    fmt.extend_from_slice(&(if ext { 0xFFFEu16 } else { tag }).to_le_bytes());
    fmt.extend_from_slice(&ch.to_le_bytes());
    fmt.extend_from_slice(&rate.to_le_bytes());
    fmt.extend_from_slice(&(rate * ch as u32 * width as u32).to_le_bytes());
    fmt.extend_from_slice(&(ch * width as u16).to_le_bytes());
    fmt.extend_from_slice(&bits.to_le_bytes());
    if ext {
        fmt.extend_from_slice(&22u16.to_le_bytes());
        fmt.extend_from_slice(&bits.to_le_bytes()); // valid bits
        fmt.extend_from_slice(&0u32.to_le_bytes()); // channel mask
        fmt.extend_from_slice(&tag.to_le_bytes());
        fmt.extend_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71]);
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((4 + 8 + fmt.len() + 8 + 8 + data.len()) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
    out.extend_from_slice(&fmt);
    out.extend_from_slice(b"LIST"); // an unknown chunk the reader must step over
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    std::fs::write(path, out).unwrap();
}

fn stereo(s: loudness_common::Stereo) -> Vec<Vec<f32>> {
    vec![s.0, s.1]
}

/// Stand-ins under the published names: 3341-1 (16-bit, −23 dBFS sine, 20 s), 3342-1 (24-bit,
/// −20 then −30 dBFS, LRA 10), 3341-15 (float extensible, fs/4 at 45° with a −6 dBTP true peak),
/// and a five-channel 3341-6. They run and pass, the five-channel one is skipped, the rest are
/// absent, and a non-WAV file beside them is ignored.
#[test]
fn harness_runs_synthesised_stand_ins() {
    use loudness_common::{concat, db, fs4_45, sine};
    let t = TempDir::new("stand-ins");
    write_wav(&t.0.join("seq-3341-1-16bit.wav"), 48_000, &stereo(sine(48_000.0, 1000.0, -23.0, 20.0)), Enc::Pcm16);
    write_wav(&t.0.join("seq-3342-1-16bit.wav"), 48_000, &stereo(concat(vec![sine(48_000.0, 1000.0, -20.0, 20.0), sine(48_000.0, 1000.0, -30.0, 20.0)])), Enc::Pcm24);
    write_wav(&t.0.join("SEQ-3341-15-24bit.wav.wav"), 48_000, &stereo(fs4_45(48_000.0, db(-6.0), 2.0)), Enc::FloatExt);
    let five = sine(48_000.0, 1000.0, -28.0, 2.0).0;
    write_wav(&t.0.join("seq-3341-6-6channels-WAVEX-16bit.wav"), 48_000, &vec![five; 5], Enc::Pcm16);
    std::fs::write(t.0.join("readme.txt"), "not a wav").unwrap();

    let rep = run_dir(&t.0);
    print(&rep);
    assert!(rep.failures.is_empty(), "{:?}", rep.failures);
    let ran: Vec<&str> = rep.ran.iter().map(|(id, _, _)| id.as_str()).collect();
    assert_eq!(ran, ["3341-1", "3341-15", "3342-1"]);
    assert_eq!(rep.ran[0].2.len(), 3, "I, max M, max S");
    assert_eq!(rep.skipped.len(), 1);
    assert_eq!(rep.skipped[0].0, "3341-6");
    assert!(rep.skipped[0].2.contains("5 channels"));
    assert_eq!(rep.absent.len(), all_cases().count() - 4);
}

/// A file whose level is wrong for its name is reported: a −23 dBFS sine named 3341-2 (−33).
#[test]
fn harness_reports_a_wrong_reading() {
    let t = TempDir::new("wrong");
    write_wav(&t.0.join("seq-3341-2-16bit.wav"), 44_100, &stereo(loudness_common::sine(44_100.0, 1000.0, -23.0, 5.0)), Enc::Pcm16);
    std::fs::write(t.0.join("seq-3342-2-16bit.wav"), b"RIFF\0\0\0\0WAVEjunk").unwrap();
    let rep = run_dir(&t.0);
    print(&rep);
    assert_eq!(rep.failures.len(), 4, "I, max M and max S of 3341-2, and the unreadable 3342-2: {:?}", rep.failures);
    assert!(rep.failures[0].starts_with("3341-2 (seq-3341-2-16bit.wav): I -22.9"), "{}", rep.failures[0]);
    assert!(rep.failures[3].contains("3342-2") && rep.failures[3].contains("no fmt chunk"), "{}", rep.failures[3]);
}

/// Every encoding the reader takes decodes to the samples written (to the format's resolution),
/// and an unsupported one is refused.
#[test]
fn wav_reader_decodes_each_encoding() {
    let t = TempDir::new("reader");
    let x: Vec<f32> = (0..64).map(|i| (i as f32 - 32.0) / 33.0).collect();
    for (enc, tol) in [(Enc::Pcm16, 1.0 / 16_000.0), (Enc::Pcm24, 1.0 / 4_000_000.0), (Enc::FloatExt, 0.0)] {
        let p = t.0.join("x.wav");
        write_wav(&p, 32_000, &[x.clone(), x.iter().map(|v| -v).collect()], enc);
        let w = read_wav(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(w.rate, 32_000);
        assert_eq!(w.channels.len(), 2);
        for (a, b) in w.channels[0].iter().zip(&x) {
            assert!((a - b).abs() <= tol, "{a} vs {b}");
        }
        for (a, b) in w.channels[1].iter().zip(&x) {
            assert!((a + b).abs() <= tol, "{a} vs -{b}");
        }
    }
    let mut bad = std::fs::read(t.0.join("x.wav")).unwrap();
    let fmt_at = bad.windows(4).position(|w| w == b"fmt ").unwrap() + 8;
    bad[fmt_at..fmt_at + 2].copy_from_slice(&2u16.to_le_bytes()); // ADPCM
    assert!(read_wav(&bad).unwrap_err().contains("unsupported"));
    assert!(read_wav(b"nope").is_err());
}
