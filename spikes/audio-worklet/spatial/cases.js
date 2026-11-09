// The benchmark cases, shared by Node and the browser runner. Each returns ms per quantum.
// Setup (filter spectra) happens inside the timed call, so each case runs a warm-up call with few
// quanta first and reports (t(n) - t(warm)) / (n - warm) to remove setup cost.
export const CASES = [
  ["fir 128 taps, 1 voice", (x, n) => x.sp_fir(1, 128, n)],
  ["fir 256 taps, 1 voice", (x, n) => x.sp_fir(1, 256, n)],
  ["fft 128 taps, 1 voice", (x, n) => x.sp_fft(1, 128, n, 0)],
  ["fft 256 taps, 1 voice", (x, n) => x.sp_fft(1, 256, n, 0)],
  ["fft 256 taps, 32 voices", (x, n) => x.sp_fft(32, 256, n, 0)],
  ["moving fft 256 taps, 1 voice", (x, n) => x.sp_fft(1, 256, n, 1)],
  ["ambisonics 3rd order, 256 taps, 64 voices", (x, n) => x.sp_ambi(64, 256, n)],
  ["ambisonics 3rd order, 256 taps, 256 voices", (x, n) => x.sp_ambi(256, 256, n)],
  ["convolution reverb 2 s stereo", (x, n) => x.sp_reverb(2, n)],
  ["convolution reverb 4 s stereo", (x, n) => x.sp_reverb(4, n)],
  ["non-uniform conv reverb 2 s stereo", (x, n) => x.sp_reverb_nu(2, n)],
  ["non-uniform conv reverb 4 s stereo", (x, n) => x.sp_reverb_nu(4, n)],
  ["non-uniform conv reverb 8 s stereo", (x, n) => x.sp_reverb_nu(8, n)],
];

/** Per-quantum timing of the non-uniform reverb (worst case matters for an audio thread). */
export async function nonUniformWorst(bytes, now, seconds = 4) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  x.sp_nu_init(seconds);
  for (let i = 0; i < 400; i++) x.sp_nu_step();
  const t = [];
  for (let i = 0; i < 4800; i++) { const a = now(); x.sp_nu_step(); t.push(now() - a); }
  t.sort((a, b) => a - b);
  const avg = t.reduce((s, v) => s + v, 0) / t.length;
  return { seconds, avg: +avg.toFixed(4), p99: +t[Math.floor(t.length * 0.99)].toFixed(4), p999: +t[Math.floor(t.length * 0.999)].toFixed(4), max: +t[t.length - 1].toFixed(4) };
}

export async function runCases(bytes, now) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const x = instance.exports;
  const budget = (128 / 48000) * 1000;
  const rows = [];
  for (const [name, fn] of CASES) {
    const warm = 50, n = 1050;
    fn(x, warm); // JIT warm-up
    let t0 = now(); fn(x, warm); const tw = now() - t0;
    t0 = now(); fn(x, n); const tn = now() - t0;
    const ms = (tn - tw) / (n - warm);
    rows.push({ name, ms: +ms.toFixed(4), budgetPct: +((ms / budget) * 100).toFixed(1) });
  }
  return rows;
}
