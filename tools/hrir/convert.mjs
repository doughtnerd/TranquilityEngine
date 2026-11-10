// H2-L1, H5: turns Chromium's IRC_Composite_C data into the HRIR asset main loads (src/plugins/audio/runtime/core/hrir.ts,
// which makes the wire's format = 2 blob from it at the context rate; the wire layout is the module doc of
// native/audio/crates/audio-dsp/src/hrtf/database.rs).
// Usage: node tools/hrir/convert.mjs [--out src/plugins/audio/runtime/wasm/myco_hrir.bin]
// Fetches the 240 WAVs into tools/hrir/raw/ (git-ignored) if missing, writes the asset and tools/hrir/PROVENANCE.json.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const RAW_DIR = join(HERE, "raw");
const PROVENANCE_PATH = join(HERE, "PROVENANCE.json");
const DEFAULT_OUT = join(REPO, "src", "plugins", "audio", "runtime", "wasm", "myco_hrir.bin");
const LICENCE_PATH = "docs/design/0157-audio-core/hrir-licence.md";

/** Chromium commit the Rust ports use. */
export const CHROMIUM_COMMIT = "cbba46fd94646232cfd2318ac962138c2a98c1f9";

const SOURCE_DIR = "third_party/blink/renderer/platform/audio/resources";
export const URL_PATTERN = `https://chromium.googlesource.com/chromium/src/+/${CHROMIUM_COMMIT}/${SOURCE_DIR}/<name>?format=TEXT`;
/** The same files from Chromium's GitHub mirror, tried when googlesource can't be reached. */
export const MIRROR_URL_PATTERN = `https://raw.githubusercontent.com/chromium/chromium/${CHROMIUM_COMMIT}/${SOURCE_DIR}/<name>`;

const ELEVATIONS = 10;
const AZIMUTHS = 24;
const DIRECTIONS = ELEVATIONS * AZIMUTHS;
const IR_LENGTH = 256;
const RATE = 44100;
const HEADER_BYTES = 16;
/** Header, then the 16-bit responses (no delay table: the delays are still in the responses). */
export const ASSET_BYTES = HEADER_BYTES + DIRECTIONS * IR_LENGTH * 2 * 2;
const FULL_SCALE = 32768;
/** The P values in elevation-index order (-45 up to 90 in 15 degree steps). */
const ELEVATION_STEPS = [315, 330, 345, 0, 15, 30, 45, 60, 75, 90];

const pad3 = (n) => String(n).padStart(3, "0");

/** @returns {string[]} the 240 file names IRC_Composite_C_R0195_T###_P###.wav, azimuth-major (T 000..345, P 315,330,345,000..090). */
export function sourceNames() {
  const names = [];
  for (let t = 0; t < 360; t += 15) {
    for (const p of ELEVATION_STEPS) {
      names.push(`IRC_Composite_C_R0195_T${pad3(t)}_P${pad3(p)}.wav`);
    }
  }
  return names;
}

/**
 * Direction index d = azIdx * 10 + elIdx, from a file name (the name is the source of truth).
 * @param {string} name
 * @returns {number}
 */
export function directionIndex(name) {
  const m = /^IRC_Composite_C_R0195_T(\d{3})_P(\d{3})\.wav$/.exec(name);
  if (!m) throw new Error(`unexpected source name ${name}`);
  const t = Number(m[1]);
  const p = Number(m[2]);
  if (t % 15 !== 0 || t > 345) throw new Error(`bad azimuth in ${name}`);
  const elevation = p <= 90 ? p : p - 360;
  const elIdx = (elevation + 45) / 15;
  if (!Number.isInteger(elIdx) || elIdx < 0 || elIdx >= ELEVATIONS) throw new Error(`bad elevation in ${name}`);
  return (t / 15) * ELEVATIONS + elIdx;
}

/**
 * Parses a RIFF PCM16 stereo 44.1 kHz WAV of 256 frames (chunks walked to find `fmt ` and `data`).
 * @param {Uint8Array} bytes
 * @param {string} name for error messages
 * @returns {{ left: Int16Array, right: Int16Array, peak: number }} the samples as stored; peak as a fraction of full scale
 */
export function parseWav(bytes, name = "wav") {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error(`${name}: not a RIFF/WAVE file`);
  let fmt = null;
  let data = null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      data = bytes.subarray(body, Math.min(body + size, bytes.length));
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${name}: missing fmt or data chunk`);
  if ((fmt.format !== 1 && fmt.format !== 0xfffe) || fmt.channels !== 2 || fmt.rate !== RATE || fmt.bits !== 16) {
    throw new Error(`${name}: want PCM16 stereo 44100 Hz, got ${JSON.stringify(fmt)}`);
  }
  const frames = data.length / 4;
  if (frames !== IR_LENGTH) throw new Error(`${name}: want ${IR_LENGTH} frames, got ${frames}`);
  const left = new Int16Array(frames);
  const right = new Int16Array(frames);
  let peak = 0;
  const samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < frames; i++) {
    left[i] = samples.getInt16(i * 4, true);
    right[i] = samples.getInt16(i * 4 + 2, true);
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  return { left, right, peak: peak / FULL_SCALE };
}

/**
 * The asset: the 16-byte header (`u32 elevations = 10; u32 azimuths = 24; u32 irLength = 256; f32 rate = 44100`), then
 * every direction's 256 frames as stored in the WAVs (int16, interleaved left, right; direction d = azIdx * 10 + elIdx),
 * leading delays still in. Chromium's `Composite.flac` decodes to the same samples (in its own order); main resamples
 * and extracts the delays at the context rate, as Chromium does (hrir.ts).
 * @param {Map<string, Uint8Array>} wavs file name to file bytes (PCM16 stereo 44.1 kHz, 256 frames)
 * @returns {{ blob: Uint8Array, peak: number }} peak is the largest absolute sample as a fraction of full scale
 */
export function convert(wavs) {
  const blob = new Uint8Array(ASSET_BYTES);
  const view = new DataView(blob.buffer);
  view.setUint32(0, ELEVATIONS, true);
  view.setUint32(4, AZIMUTHS, true);
  view.setUint32(8, IR_LENGTH, true);
  view.setFloat32(12, RATE, true);
  const seen = new Set();
  let peak = 0;
  for (const name of sourceNames()) {
    const bytes = wavs.get(name);
    if (!bytes) throw new Error(`missing source ${name}`);
    const d = directionIndex(name);
    if (seen.has(d)) throw new Error(`duplicate direction ${d} from ${name}`);
    seen.add(d);
    const wav = parseWav(bytes, name);
    peak = Math.max(peak, wav.peak);
    for (let n = 0; n < IR_LENGTH; n++) {
      view.setInt16(HEADER_BYTES + ((d * IR_LENGTH + n) * 2) * 2, wav.left[n], true);
      view.setInt16(HEADER_BYTES + ((d * IR_LENGTH + n) * 2 + 1) * 2, wav.right[n], true);
    }
  }
  if (seen.size !== DIRECTIONS) throw new Error("directions do not cover 0..239");
  return { blob, peak };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetches one source from googlesource (retrying 429 and 5xx with backoff), else from the GitHub mirror. */
async function fetchSource(name) {
  const url = URL_PATTERN.replace("<name>", name);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url);
      if (res.ok) {
        const text = (await res.text()).replace(/\s+/g, "");
        return Buffer.from(text, "base64");
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 8) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`fetch ${name}: HTTP ${res.status}`);
    }
  } catch (err) {
    const res = await fetch(MIRROR_URL_PATTERN.replace("<name>", name));
    if (!res.ok) throw new Error(`fetch ${name}: ${err instanceof Error ? err.message : err}; mirror HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

async function ensureRaw(names) {
  mkdirSync(RAW_DIR, { recursive: true });
  const missing = names.filter((n) => !existsSync(join(RAW_DIR, n)));
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(
      missing.slice(i, i + 4).map(async (name) => {
        const bytes = await fetchSource(name);
        writeFileSync(join(RAW_DIR, name), bytes);
      }),
    );
    await sleep(100);
  }
}

async function main(argv) {
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? resolve(argv[outIdx + 1]) : DEFAULT_OUT;
  const names = sourceNames();
  await ensureRaw(names);
  const wavs = new Map();
  const sources = [];
  for (const name of names) {
    const path = join(RAW_DIR, name);
    if (!existsSync(path)) throw new Error(`missing after fetch: ${path}`);
    const bytes = readFileSync(path);
    wavs.set(name, bytes);
    sources.push({ name, directionIndex: directionIndex(name), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const result = convert(wavs);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, result.blob);

  const provenance = {
    chromiumCommit: CHROMIUM_COMMIT,
    urlPattern: URL_PATTERN,
    mirrorUrlPattern: MIRROR_URL_PATTERN,
    date: new Date().toISOString().slice(0, 10),
    licence: LICENCE_PATH,
    format: { asset: "header + int16 responses, delays in (no delay table)", elevations: ELEVATIONS, azimuths: AZIMUTHS, irLength: IR_LENGTH, rate: RATE },
    sources,
    blob: {
      path: relative(REPO, outPath).split(sep).join("/"),
      bytes: result.blob.length,
      sha256: sha256(result.blob),
    },
    peak: { rawWavAbs: result.peak },
    chromiumResource: {
      name: "Composite.flac",
      path: `${SOURCE_DIR}/Composite.flac`,
      bytes: 136404,
      sha256: "40bda2ad9170fa2bcdc2d5f20cdd98c70609ad33a94df49fe7d6007cacab2ada",
      note: "what Chromium loads (IDR_AUDIO_SPATIALIZATION_COMPOSITE); decoded (ffmpeg, 2026-11-10) its 240 x 256 stereo frames equal the WAVs' samples, in its own order (elevation 0..90, then 315, 330, 345, per azimuth)",
    },
    processing:
      "none: the WAV samples as stored (they equal Chromium's Composite.flac decoded); hrir.ts resamples each response with a port of media's SincResampler and extracts its average group delay at the context rate, as Chromium's hrtf_elevation.cc and hrtf_kernel.cc do",
  };
  writeFileSync(PROVENANCE_PATH, JSON.stringify(provenance, null, 2) + "\n");
  console.log(`wrote ${outPath} (${result.blob.length} bytes); peak ${result.peak.toFixed(6)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
