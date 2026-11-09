// Fake decoder: a sine wave kept `target` frames ahead of the wall clock, written to the worklet by
// MessagePort (mode "port"), to main for relaying (mode "relay") or into a SAB ring (mode "sab").
const SR = 48000;
let cfg, port, sh, sL, sR, mask;

function busy(ms) { const e = performance.now() + ms; while (performance.now() < e); }

self.onmessage = (e) => {
  cfg = e.data;
  port = cfg.port;
  if (cfg.mode === "sab") {
    sh = new Int32Array(cfg.sab, 0, 4);
    sL = new Float32Array(cfg.sab, 16, cfg.cap);
    sR = new Float32Array(cfg.sab, 16 + 4 * cfg.cap, cfg.cap);
    mask = cfg.cap - 1;
  }
  run();
};

function run() {
  let produced = 0, phaseL = 0, phaseR = 0, nextJank = 500, stalled = false;
  const t0 = performance.now();
  const C = cfg.chunk;
  const tick = () => {
    let now = performance.now();
    const el = now - t0;
    if (cfg.workerJank) {
      if (!stalled && el >= 10000) { stalled = true; busy(300); }
      else if (el >= nextJank) { busy(50); nextJank += 500; }
      now = performance.now();
    }
    const want = Math.floor((now - t0) / 1000 * SR) + cfg.target;
    while (produced < want) {
      if (cfg.mode === "sab") {
        const w = sh[0], r = Atomics.load(sh, 1);
        if (w - r + C > cfg.cap) break; // ring full
        for (let i = 0; i < C; i++) {
          sL[(w + i) & mask] = 0.1 * Math.sin(phaseL); sR[(w + i) & mask] = 0.1 * Math.sin(phaseR);
          phaseL += 0.0576; phaseR += 0.0864;
        }
        Atomics.store(sh, 0, w + C);
      } else {
        const l = new Float32Array(C), r = new Float32Array(C);
        for (let i = 0; i < C; i++) { l[i] = 0.1 * Math.sin(phaseL); r[i] = 0.1 * Math.sin(phaseR); phaseL += 0.0576; phaseR += 0.0864; }
        (port || self).postMessage({ l, r }, [l.buffer, r.buffer]);
      }
      produced += C;
    }
    if (el < (cfg.durationMs || 25000) + 8000) setTimeout(tick, 4);
  };
  tick();
}
