// H2-L1: converts Chromium's IRC_Composite_C data into the format = 2 HRIR blob (api-and-models 4.1;
// the byte layout is the module doc of native/audio/crates/audio-dsp/src/hrtf/database.rs).
// Usage: node tools/hrir/convert.mjs [--out src/plugins/audio/runtime/wasm/myco_hrir.bin]
// Fetches the 240 WAVs into tools/hrir/raw/ (git-ignored) if missing, writes the blob and tools/hrir/PROVENANCE.json.

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

const ELEVATIONS = 10;
const AZIMUTHS = 24;
const DIRECTIONS = ELEVATIONS * AZIMUTHS;
const IR_LENGTH = 256;
const RATE = 44100;
const HEADER_BYTES = 16;
const DELAY_BYTES = DIRECTIONS * 2 * 4;
const IR_OFFSET = HEADER_BYTES + DELAY_BYTES;
const BLOB_BYTES = IR_OFFSET + DIRECTIONS * IR_LENGTH * 2 * 2;
const FULL_SCALE = 32768;
/** The P values in elevation-index order (-45 up to 90 in 15 degree steps). */
const ELEVATION_STEPS = [315, 330, 345, 0, 15, 30, 45, 60, 75, 90];
const DELAY_HEADROOM = 20;

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
 * Plain radix-2 complex FFT, in place, unnormalised. sign -1 is the forward transform, +1 the inverse.
 * @param {Float64Array} re
 * @param {Float64Array} im
 * @param {number} sign
 */
function fft(re, im, sign) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (sign * 2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/**
 * ExtractAverageGroupDelay (hrtf_kernel.cc / fft_frame.cc; the port is kernel.rs `extract_average_group_delay`).
 * @param {Float64Array} ir a 256-frame response; modified in place
 * @returns {number} the removed delay in frames
 */
export function extractAverageGroupDelay(ir) {
  const n = ir.length;
  if (n !== IR_LENGTH) throw new Error(`extractAverageGroupDelay expects ${IR_LENGTH} frames, got ${n}`);
  const half = n / 2;
  const TWO_PI = 2 * Math.PI;

  // Forward 256-point real FFT, then the packed form: spec[0] = (X[0].re, X[128].re), spec[k] = X[k].
  const re = Float64Array.from(ir);
  const im = new Float64Array(n);
  fft(re, im, -1);
  const specRe = new Float64Array(half);
  const specIm = new Float64Array(half);
  specRe[0] = re[0];
  specIm[0] = re[half];
  for (let k = 1; k < half; k++) {
    specRe[k] = re[k];
    specIm[k] = im[k];
  }

  let aveSum = 0;
  let weightSum = 0;
  let lastPhase = 0;
  const samplePhaseDelay = TWO_PI / n;
  // Upstream includes bin 0, read as the complex (DC, Nyquist).
  for (let k = 0; k < half; k++) {
    const mag = Math.hypot(specRe[k], specIm[k]);
    const phase = Math.atan2(specIm[k], specRe[k]);
    let d = phase - lastPhase;
    lastPhase = phase;
    if (d < -Math.PI) d += TWO_PI;
    if (d > Math.PI) d -= TWO_PI;
    aveSum += mag * d;
    weightSum += mag;
  }
  if (weightSum === 0) return 0;

  const ave = aveSum / weightSum;
  let delay = -ave / samplePhaseDelay;
  // Leave 20 sample headroom (for leading edge of impulse).
  if (delay > DELAY_HEADROOM) delay -= DELAY_HEADROOM;

  // AddConstantGroupDelay(-delay): rotate bins 1..127, then remove DC.
  const phaseAdj = delay * samplePhaseDelay;
  for (let i = 1; i < half; i++) {
    const mag = Math.hypot(specRe[i], specIm[i]);
    const phase = Math.atan2(specIm[i], specRe[i]) + i * phaseAdj;
    specRe[i] = mag * Math.cos(phase);
    specIm[i] = mag * Math.sin(phase);
  }
  specRe[0] = 0;

  // Inverse real FFT: rebuild the Hermitian spectrum from the packed bins, inverse transform, scale by 1/n.
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  outRe[0] = specRe[0];
  outRe[half] = specIm[0];
  for (let k = 1; k < half; k++) {
    outRe[k] = specRe[k];
    outIm[k] = specIm[k];
    outRe[n - k] = specRe[k];
    outIm[n - k] = -specIm[k];
  }
  fft(outRe, outIm, 1);
  for (let i = 0; i < n; i++) ir[i] = outRe[i] / n;
  return delay;
}

/** Quantise: round(x * 32768), half away from zero, clamped to [-32768, 32767]. */
function quantise(x) {
  const v = x * FULL_SCALE;
  const r = v < 0 ? -Math.round(-v) : Math.round(v);
  return Math.min(32767, Math.max(-32768, r));
}

/**
 * Parses a RIFF PCM16 stereo 44.1 kHz WAV of 256 frames (chunks walked to find `fmt ` and `data`).
 * @param {Uint8Array} bytes
 * @param {string} name for error messages
 * @returns {{ left: Float64Array, right: Float64Array, peak: number }} samples as s / 32768
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
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  let peak = 0;
  const samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < frames; i++) {
    const l = samples.getInt16(i * 4, true) / FULL_SCALE;
    const r = samples.getInt16(i * 4 + 2, true) / FULL_SCALE;
    left[i] = l;
    right[i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  return { left, right, peak };
}

/**
 * @param {Map<string, Uint8Array>} wavs file name to file bytes (PCM16 stereo 44.1 kHz, 256 frames)
 * @returns {{ blob: Uint8Array, peak: number, delays: Float32Array, rawPeak: number, delayRemovedPeak: number, scale: number }}
 *   peak is the blob's peak absolute sample as a fraction of full scale; delays holds the 480 table entries.
 */
export function convert(wavs) {
  const names = sourceNames();
  /** @type {(Float64Array)[][]} irs[d] = [left, right], delay removed, before scaling */
  const irs = new Array(DIRECTIONS);
  const delays = new Float32Array(DIRECTIONS * 2);
  let rawPeak = 0;
  for (const name of names) {
    const bytes = wavs.get(name);
    if (!bytes) throw new Error(`missing source ${name}`);
    const d = directionIndex(name);
    if (irs[d]) throw new Error(`duplicate direction ${d} from ${name}`);
    const { left, right, peak } = parseWav(bytes, name);
    rawPeak = Math.max(rawPeak, peak);
    for (let ear = 0; ear < 2; ear++) {
      const ir = ear === 0 ? left : right;
      const delay = extractAverageGroupDelay(ir);
      if (!Number.isFinite(delay) || delay < 0) throw new Error(`${name} ear ${ear}: delay ${delay} is not usable`);
      delays[d * 2 + ear] = Math.fround(delay);
    }
    irs[d] = [left, right];
  }
  if (irs.some((x) => !x)) throw new Error("directions do not cover 0..239");

  let delayRemovedPeak = 0;
  for (const pair of irs) {
    for (const ir of pair) {
      for (let n = 0; n < IR_LENGTH; n++) delayRemovedPeak = Math.max(delayRemovedPeak, Math.abs(ir[n]));
    }
  }
  // The format has no gain field. Scale only if the delay-removed peak would clip.
  const scale = delayRemovedPeak > 1 ? 0.999 / delayRemovedPeak : 1;

  const blob = new Uint8Array(BLOB_BYTES);
  const view = new DataView(blob.buffer);
  view.setUint32(0, ELEVATIONS, true);
  view.setUint32(4, AZIMUTHS, true);
  view.setUint32(8, IR_LENGTH, true);
  view.setFloat32(12, RATE, true);
  for (let i = 0; i < delays.length; i++) view.setFloat32(HEADER_BYTES + i * 4, delays[i], true);
  let blobPeak = 0;
  for (let d = 0; d < DIRECTIONS; d++) {
    for (let n = 0; n < IR_LENGTH; n++) {
      for (let ear = 0; ear < 2; ear++) {
        const q = quantise(irs[d][ear][n] * scale);
        blobPeak = Math.max(blobPeak, Math.abs(q));
        view.setInt16(IR_OFFSET + ((d * IR_LENGTH + n) * 2 + ear) * 2, q, true);
      }
    }
  }
  return {
    blob,
    peak: blobPeak / FULL_SCALE,
    delays,
    rawPeak,
    delayRemovedPeak,
    scale,
  };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetches one source; retries 429 and 5xx with backoff (googlesource rate-limits bursts). */
async function fetchSource(name) {
  const url = `https://chromium.googlesource.com/chromium/src/+/${CHROMIUM_COMMIT}/${SOURCE_DIR}/${name}?format=TEXT`;
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
    date: new Date().toISOString().slice(0, 10),
    licence: LICENCE_PATH,
    format: { number: 2, elevations: ELEVATIONS, azimuths: AZIMUTHS, irLength: IR_LENGTH, rate: RATE },
    sources,
    blob: {
      path: relative(REPO, outPath).split(sep).join("/"),
      bytes: result.blob.length,
      sha256: sha256(result.blob),
    },
    peak: {
      rawWavAbs: result.rawPeak,
      delayRemovedAbs: result.delayRemovedPeak,
      blobAbs: result.peak,
    },
    scaling: {
      factor: result.scale,
      rule: "1.0 unless the delay-removed peak exceeds 1.0; then every IR is scaled by 0.999 / peak before quantising",
    },
    delayRemoval: "extractAverageGroupDelay (kernel.rs port), f64, 256-point FFT, 20-frame headroom; quantise = round(x * 32768) clamped",
  };
  writeFileSync(PROVENANCE_PATH, JSON.stringify(provenance, null, 2) + "\n");
  console.log(
    `wrote ${outPath} (${result.blob.length} bytes); raw peak ${result.rawPeak.toFixed(6)}, delay-removed peak ${result.delayRemovedPeak.toFixed(6)}, scale ${result.scale}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
