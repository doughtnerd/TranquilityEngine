import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const here = dirname(fileURLToPath(import.meta.url));
export const repo = join(here, '../../..');
export const RT = join(repo, 'src/plugins/audio/runtime');
export const DEC_WASM = join(RT, 'wasm/myco_audio_decode.wasm');
export const DEC_AAC_WASM = join(RT, 'wasm/myco_audio_decode_aac.wasm');
export const CORE_WASM = join(RT, 'wasm/myco_audio.wasm');
export const RATE = 48000;
export const CHUNK = 4096;
export const CHUNK_MS = (CHUNK / RATE) * 1000; // 85.333 ms
export const args = process.argv.slice(2);
export const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
export const flag = (k) => args.includes(k);
export const pct = (s, p) => s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1];
/** p50/p99/p99.9/max/mean of an array of numbers. */
export function stats(t) {
  const s = Float64Array.from(t).sort();
  if (!s.length) return { n: 0, p50: NaN, p99: NaN, p999: NaN, max: NaN, mean: NaN };
  return { n: s.length, p50: pct(s, 0.5), p99: pct(s, 0.99), p999: pct(s, 0.999), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}
export const median = (a) => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : NaN; };
export const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
export function saveJson(name, obj) { mkdirSync(join(here, 'results'), { recursive: true }); writeFileSync(join(here, 'results', name), JSON.stringify(obj, null, 1)); }
export function loadEngine() { return import(join(here, 'build/engine.js')); }
export function ffmpegF32(path) {
  return new Float32Array(Uint8Array.from(execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'], { maxBuffer: 1 << 30 })).buffer);
}
