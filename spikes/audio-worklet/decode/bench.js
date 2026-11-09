// Shared by Node and the browser page. Loads decode-spike wasm (plain extern "C", no imports needed).
export const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

export async function load(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

/** files: {name: Uint8Array}. Returns per-file duration and median/min decode ms over `reps`. */
export function benchDecode(x, files, now, reps = 9) {
  const out = {};
  for (const [name, bytes] of Object.entries(files)) {
    const times = [];
    let dur = 0, frames = 0, ch = 0, rate = 0;
    for (let i = 0; i < reps + 1; i++) {
      const t0 = now();
      const p = x.alloc(bytes.length);
      new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes); // read fresh: alloc may grow memory
      frames = Number(x.decode(p, bytes.length));
      const t1 = now();
      ch = x.out_channels(); rate = x.out_rate();
      if (i === 0) { x.out_free(); continue; } // first run is a warm-up (includes memory growth)
      times.push(t1 - t0);
      x.out_free();
    }
    dur = frames / rate;
    const m = median(times);
    out[name] = { frames, ch, rate, seconds: +dur.toFixed(2), medianMs: +m.toFixed(2), minMs: +Math.min(...times).toFixed(2), xRealtime: Math.round((dur * 1000) / m) };
  }
  return out;
}

export function benchFx(x, now, reps = 9, blocks = 5000) {
  const out = {};
  for (const [kind, name] of [[0, "reverb_stereo(20m, 2.5s)"], [1, "moog x2"], [2, "lowpass x2"], [3, "chain: lp>>dry+0.3 reverb>>limiter"]]) {
    x.fx_init(kind);
    x.fx_run(2000);
    const times = [];
    for (let i = 0; i < reps; i++) {
      const t0 = now();
      x.fx_run(blocks);
      times.push((now() - t0) / blocks);
    }
    const m = median(times);
    out[name] = { msPerBlock: +m.toFixed(5), pctOf2_667ms: +((m / 2.667) * 100).toFixed(2) };
  }
  return out;
}

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

/** Whole-file decode for fixtures; `decode` returns -1 for formats the build does not support. */
export function benchFormats(x, files, now, reps = 9) {
  const out = {};
  for (const [name, bytes] of Object.entries(files)) {
    const p0 = x.alloc(bytes.length);
    new Uint8Array(x.memory.buffer, p0, bytes.length).set(bytes);
    if (Number(x.decode(p0, bytes.length)) < 0) { out[name] = { supported: false }; continue; }
    x.out_free();
    out[name] = { supported: true, ...benchDecode(x, { [name]: bytes }, now, reps)[name] };
  }
  return out;
}

/** Incremental decode in `chunk`-frame reads, then seeks (coarse=0, accurate=1) around the middle. */
export function benchStream(x, files, now, chunk = 4096, seeks = 30) {
  const out = {};
  for (const [name, bytes] of Object.entries(files)) {
    const open = () => {
      const p = x.alloc(bytes.length);
      new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
      return x.stream_open(p, bytes.length);
    };
    if (open() !== 0) { out[name] = { supported: false }; continue; }
    const rate = x.stream_rate(), ch = x.stream_channels();
    let all = [], frames = 0;
    for (let rep = 0; rep < 4; rep++) { // rep 0 warms up; the chunk times of reps 1-3 are pooled
      if (rep > 0) { x.stream_close(); open(); }
      const t = [];
      for (;;) {
        const t0 = now();
        const n = x.stream_read(chunk);
        const dt = now() - t0;
        if (n === 0) break;
        if (rep > 0) t.push(dt);
        if (rep === 1) frames += n;
      }
      all = all.concat(t);
    }
    all.sort((a, b) => a - b);
    const r = { supported: true, rate, ch, chunks: all.length / 3, packets: x.stream_packets(), chunkBudgetMs: +((chunk / rate) * 1000).toFixed(1),
      p50Ms: +pct(all, 0.5).toFixed(3), p99Ms: +pct(all, 0.99).toFixed(3), maxMs: +all[all.length - 1].toFixed(3), seconds: +(frames / rate).toFixed(2) };
    const dur = frames / rate;
    x.stream_close(); open(); x.stream_read(chunk); // seeks start from a stream that is mid-file, not at EOF (symphonia 0.6.1 isomp4 cannot seek after EOF)
    for (const [mode, label] of [[0, "coarse"], [1, "accurate"]]) {
      const sk = [], first = [], err = [];
      for (let i = 0; i < seeks + 1; i++) {
        const want = dur / 2 + i * 0.37;
        const t0 = now();
        const ts = Number(x.stream_seek(want, mode));
        const t1 = now();
        x.stream_read(chunk);
        const t2 = now();
        if (i === 0) continue;
        sk.push(t1 - t0); first.push(t2 - t1); err.push((ts / rate - want) * 1000);
      }
      r[`seek_${label}`] = { medianMs: +median(sk).toFixed(3), maxMs: +Math.max(...sk).toFixed(3), firstChunkMedianMs: +median(first).toFixed(3), landedMinusRequestedMs: { median: +median(err).toFixed(1), min: +Math.min(...err).toFixed(1), max: +Math.max(...err).toFixed(1) } };
    }
    x.stream_close();
    out[name] = r;
  }
  return out;
}
