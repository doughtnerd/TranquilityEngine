// Injected into the page before any script runs (Playwright addInitScript). Counts, per frame, the WebGL draw
// calls and triangles the page issues, bucketed by render target and viewport size (the main pass is the canvas-sized
// viewport on the default framebuffer; shadow cascades are the square viewports of a framebuffer; anything else is
// post-processing or helper passes). Exact: triangles are summed from the arguments of every draw call
// (instanced calls count `instances * primitives`). A context flagged `gl.__benchSkip = true` (the spike's own
// object-ID pass) is not counted. Also records, per bucket, when the first and last draw of the frame was issued
// (JS submit span).
(() => {
  const buckets = new Map();
  window.__gl = {
    /** true: draw calls are counted but not issued (no GPU work): the CPU-only measurement mode. */
    skip: false,
    reset() { buckets.clear(); },
    snapshot() { return [...buckets].map(([key, v]) => ({ key, ...v })); },
  };
  const P = WebGL2RenderingContext.prototype;
  const st = new WeakMap();
  const of = (gl) => { let s = st.get(gl); if (!s) st.set(gl, (s = { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight, fbo: null })); return s; };
  const wrap = (name, fn) => { const orig = P[name]; P[name] = function (...a) { fn.call(this, ...a); return orig.apply(this, a); }; };
  wrap("viewport", function (x, y, w, h) { const s = of(this); s.w = w; s.h = h; });
  wrap("bindFramebuffer", function (target, fb) { if (target === 0x8d40 || target === 0x8ca9) of(this).fbo = fb; });
  const tris = (mode, count) => (mode === 4 ? count / 3 : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0);
  const rec = (gl, mode, count, inst) => {
    if (gl.__benchSkip) return;
    const s = of(gl);
    const key = `${s.fbo ? "fbo" : "canvas"}:${s.w}x${s.h}`;
    let b = buckets.get(key);
    const now = performance.now();
    if (!b) buckets.set(key, (b = { draws: 0, tris: 0, other: 0, sig: 0, t0: now, t1: now }));
    b.draws++;
    // order-sensitive checksum of every draw's (mode, count, instances): equal when two frames submit the same geometry the same way
    b.sig = (Math.imul(b.sig, 31) + mode * 7919 + count * 31 + inst) >>> 0;
    const t = tris(mode, count) * inst;
    b.tris += t;
    if (t === 0) b.other += count * inst;
    b.t1 = now;
  };
  const wrapDraw = (name, args) => {
    const orig = P[name];
    P[name] = function (...a) {
      const [m, c, n] = args(a);
      rec(this, m, c, n);
      if (window.__gl.skip && !this.__benchSkip) return;
      return orig.apply(this, a);
    };
  };
  wrapDraw("drawArrays", (a) => [a[0], a[2], 1]);
  wrapDraw("drawElements", (a) => [a[0], a[1], 1]);
  wrapDraw("drawArraysInstanced", (a) => [a[0], a[2], a[3]]);
  wrapDraw("drawElementsInstanced", (a) => [a[0], a[1], a[4]]);
  wrapDraw("drawRangeElements", (a) => [a[0], a[3], 1]);
})();
