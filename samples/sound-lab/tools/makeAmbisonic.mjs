// Generates ambisonic test clips: a tone at a given azimuth and elevation encoded into 4, 9 or 16 channels (first to
// third order) of AmbiX (ACN order, SN3D), plus a FuMa twin of each (Furse-Malham order, MaxN). 16-bit PCM WAV, the form
// the engine imports (ADR 0162 §2.4); a clip needs a `<clip>.meta.json` sidecar `{"format":"myco.import@1","ambisonic":{}}`
// (add `"convention":"fuma"` for the FuMa twin) before the engine plays it as ambisonic.
//
//   node samples/sound-lab/tools/makeAmbisonic.mjs [--out DIR] [--az DEG] [--el DEG] [--seconds S] [--rate HZ] [--hz F]
//
// writes `ambi-o{1,2,3}-az{AZ}-el{EL}.wav` and `…-fuma.wav` to DIR (default ../audio). Azimuth is degrees, 0 in front and
// positive to the left seen from above (AmbiX: x front, y left, z up); elevation is positive up. Deterministic.
// The tests import `encodeTone`, `fumaFromAmbix` and `ambisonicWav` and generate their clips at run time.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;

/** Channels of an order-`order` field: `(order + 1)²`. */
export const channelsOf = (order) => (order + 1) ** 2;

/**
 * The 16 SN3D real harmonics, ACN order, of the unit vector (x, y, z) in AmbiX axes: the formulas of
 * `native/audio/crates/audio-dsp/src/ambisonic.rs` (`sh_sn3d`), in f64.
 */
export function shSn3d(x, y, z) {
  const [xx, yy, zz] = [x * x, y * y, z * z];
  const s3 = Math.sqrt(3), s15 = Math.sqrt(15), c33 = Math.sqrt(5 / 8), c31 = Math.sqrt(3 / 8);
  return [
    1,
    y,
    z,
    x,
    s3 * x * y,
    s3 * y * z,
    0.5 * (3 * zz - 1),
    s3 * x * z,
    (s3 / 2) * (xx - yy),
    c33 * y * (3 * xx - yy),
    s15 * x * y * z,
    c31 * y * (5 * zz - 1),
    0.5 * z * (5 * zz - 3),
    c31 * x * (5 * zz - 1),
    (s15 / 2) * z * (xx - yy),
    c33 * x * (xx - 3 * yy),
  ];
}

/** The SN3D encode gains of a source at `azDeg` (0 front, positive left) and `elDeg` (positive up): `channelsOf(order)` values. */
export function encodeGains(azDeg, elDeg, order) {
  const [az, el] = [azDeg * RAD, elDeg * RAD];
  return shSn3d(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)).slice(0, channelsOf(order));
}

/** A mono signal encoded at (`azDeg`, `elDeg`): planar `Float32Array[]`, `channelsOf(order)` channels (AmbiX). */
export function encodeTone(mono, azDeg, elDeg, order) {
  const g = encodeGains(azDeg, elDeg, order);
  return g.map((gain) => Float32Array.from(mono, (s) => s * gain));
}

/** A sine of `hz` with 5 ms fades, `seconds` long at `rate`, peak `amp`. */
export function tone(hz = 440, seconds = 0.5, rate = 48000, amp = 0.5) {
  const n = Math.round(seconds * rate);
  const fade = Math.round(0.005 * rate);
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((TAU * hz * i) / rate) * Math.min(1, i / fade, (n - 1 - i) / fade));
}

/** AmbiX channel `n` is FuMa channel `FUMA_INDEX_OF_ACN[n]` times `FUMA_TO_SN3D[n]` (audio-decode/src/ambisonic.rs). */
export const FUMA_INDEX_OF_ACN = [0, 2, 3, 1, 8, 6, 4, 5, 7, 15, 13, 11, 9, 10, 12, 14];
export const FUMA_TO_SN3D = [Math.SQRT2, 1, 1, 1, Math.sqrt(3) / 2, Math.sqrt(3) / 2, 1, Math.sqrt(3) / 2, Math.sqrt(3) / 2, Math.sqrt(5 / 8), Math.sqrt(5) / 3, Math.sqrt(32 / 45), 1, Math.sqrt(32 / 45), Math.sqrt(5) / 3, Math.sqrt(5 / 8)];

/** An AmbiX field (planar, 4/9/16 channels) as FuMa: channels reordered `W X Y Z R S T U V K L M N O P Q` and MaxN-scaled. */
export function fumaFromAmbix(planar) {
  const out = new Array(planar.length);
  for (let n = 0; n < planar.length; n++) {
    const w = FUMA_TO_SN3D[n];
    out[FUMA_INDEX_OF_ACN[n]] = Float32Array.from(planar[n], (s) => s / w);
  }
  return out;
}

/** A 16-bit PCM WAV of planar channels at `rate` (plain PCM header: the decoder reads any channel count). */
export function ambisonicWav(planar, rate = 48000) {
  const ch = planar.length;
  const frames = planar[0].length;
  const data = Buffer.alloc(frames * ch * 2);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, planar[c][f])) * 32767), (f * ch + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * 2, 28);
  h.writeUInt16LE(ch * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  const out = args.out ?? join(dirname(fileURLToPath(import.meta.url)), "..", "audio");
  const [az, el, rate] = [Number(args.az ?? 90), Number(args.el ?? 0), Number(args.rate ?? 48000)];
  const mono = tone(Number(args.hz ?? 440), Number(args.seconds ?? 0.5), rate);
  mkdirSync(out, { recursive: true });
  for (const order of [1, 2, 3]) {
    const ambix = encodeTone(mono, az, el, order);
    const base = `ambi-o${order}-az${az}-el${el}`;
    writeFileSync(join(out, `${base}.wav`), ambisonicWav(ambix, rate));
    writeFileSync(join(out, `${base}-fuma.wav`), ambisonicWav(fumaFromAmbix(ambix), rate));
    console.log(`${base}.wav, ${base}-fuma.wav (${channelsOf(order)} channels)`);
  }
}
