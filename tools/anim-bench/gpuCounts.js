// The anim-bench's GPU call counter (run.mjs `--count`): a page init script, run before any of the player's code. It
// wraps the browser's own WebGL2 and WebGPU entry points (prototypes, nothing of the engine) and counts what the page
// asks the GPU for, so the bench can say which renderer and which skinning backend ran and what a frame costs in calls:
//
// - renderer: the context the page's canvases got ("webgpu" or "webgl2");
// - skinning backend: "webgpu" when a compute pipeline labelled `kernel mycoSkin…` exists (render/skinning's labels),
//   "webgl2" when a program captures the item kernel's transform-feedback varyings (`kout0`…), else none;
// - per-frame counters: uploads (calls and bytes), compute dispatches (the skinning kernel's apart), transform-feedback
//   passes, draws, submits, pipeline/program and binding changes, and calls that wait on the GPU.
//
// Every page gets the renderer and skinning backend (a few rare calls are wrapped). The per-frame counters only when
// `globalThis.__animBenchCountCalls` is true before this runs (run.mjs --count): wrapping every call slows the page, so
// timings from a counted page aren't comparable and run.mjs counts in a page of its own. The game script
// (game/bench.ts) snapshots `globalThis.__animBenchCounts` at the start and end of its measured frames. Nothing here
// reads engine state.
(() => {
  const all = globalThis.__animBenchCountCalls === true;
  const c = Object.create(null);
  const add = (k, n = 1) => {
    c[k] = (c[k] ?? 0) + n;
  };
  const info = { contexts: [], skinning: null, computePipelines: [] };
  const bytesOf = (v, size) => (typeof size === "number" ? size : v && typeof v.byteLength === "number" ? v.byteLength : 0);
  /** Counts a hot call (only in a counted page). */
  const wrap = (proto, name, before) => {
    if (!all || !proto || typeof proto[name] !== "function") return;
    const orig = proto[name];
    proto[name] = function (...a) {
      before.call(this, a);
      return orig.apply(this, a);
    };
  };
  const wrapAfter = (proto, name, after) => {
    if (!proto || typeof proto[name] !== "function") return;
    const orig = proto[name];
    proto[name] = function (...a) {
      const r = orig.apply(this, a);
      after.call(this, a, r);
      return r;
    };
  };

  // --- Which contexts ---------------------------------------------------------------------------------------------
  wrapAfter(globalThis.HTMLCanvasElement?.prototype, "getContext", (a, r) => {
    if (r && (a[0] === "webgl2" || a[0] === "webgpu" || a[0] === "webgl")) info.contexts.push(a[0]);
  });

  // --- WebGPU -------------------------------------------------------------------------------------------------------
  const pipelineLabel = new WeakMap();
  const SKIN = /mycoSkin/;
  wrapAfter(globalThis.GPUDevice?.prototype, "createComputePipeline", (a, r) => {
    const label = String(a[0]?.label ?? "");
    pipelineLabel.set(r, label);
    info.computePipelines.push(label);
    if (SKIN.test(label)) info.skinning = "webgpu";
  });
  wrapAfter(globalThis.GPUDevice?.prototype, "createComputePipelineAsync", (a, r) => {
    const label = String(a[0]?.label ?? "");
    r?.then?.((p) => pipelineLabel.set(p, label));
    if (SKIN.test(label)) info.skinning = "webgpu";
  });
  const current = new WeakMap();
  wrap(globalThis.GPUQueue?.prototype, "writeBuffer", function (a) {
    add("gpu.writeBuffer");
    add("gpu.writeBuffer.bytes", bytesOf(a[2], a[4]) * (a[2] && a[2].BYTES_PER_ELEMENT && typeof a[4] === "number" ? a[2].BYTES_PER_ELEMENT : 1));
  });
  wrap(globalThis.GPUQueue?.prototype, "writeTexture", (a) => {
    add("gpu.writeTexture");
    add("gpu.writeTexture.bytes", bytesOf(a[1]));
  });
  wrap(globalThis.GPUQueue?.prototype, "submit", (a) => {
    add("gpu.submit");
    add("gpu.commandBuffers", a[0]?.length ?? 0);
  });
  wrap(globalThis.GPUQueue?.prototype, "onSubmittedWorkDone", () => add("wait.onSubmittedWorkDone"));
  wrap(globalThis.GPUBuffer?.prototype, "mapAsync", () => add("wait.mapAsync"));
  wrap(globalThis.GPUDevice?.prototype, "createCommandEncoder", () => add("gpu.createCommandEncoder"));
  wrap(globalThis.GPUDevice?.prototype, "createBindGroup", () => add("gpu.createBindGroup"));
  wrap(globalThis.GPUDevice?.prototype, "createBuffer", () => add("gpu.createBuffer"));
  wrap(globalThis.GPUCommandEncoder?.prototype, "beginComputePass", () => add("gpu.computePasses"));
  wrap(globalThis.GPUCommandEncoder?.prototype, "beginRenderPass", () => add("gpu.renderPasses"));
  wrap(globalThis.GPUComputePassEncoder?.prototype, "setPipeline", function (a) {
    current.set(this, a[0]);
    add("gpu.compute.setPipeline");
  });
  wrap(globalThis.GPUComputePassEncoder?.prototype, "setBindGroup", () => add("gpu.compute.setBindGroup"));
  wrap(globalThis.GPUComputePassEncoder?.prototype, "dispatchWorkgroups", function () {
    add("gpu.dispatch");
    if (SKIN.test(pipelineLabel.get(current.get(this)) ?? "")) add("gpu.dispatch.skin");
  });
  for (const P of [globalThis.GPURenderPassEncoder?.prototype, globalThis.GPURenderBundleEncoder?.prototype]) {
    wrap(P, "draw", () => add("draws"));
    wrap(P, "drawIndexed", () => add("draws"));
    wrap(P, "setPipeline", () => add("gpu.render.setPipeline"));
    wrap(P, "setBindGroup", () => add("gpu.render.setBindGroup"));
    wrap(P, "setVertexBuffer", () => add("gpu.render.setVertexBuffer"));
  }
  wrap(globalThis.GPURenderPassEncoder?.prototype, "executeBundles", (a) => add("gpu.bundlesExecuted", a[0]?.length ?? 0));

  // --- WebGL2 -------------------------------------------------------------------------------------------------------
  const GL = globalThis.WebGL2RenderingContext?.prototype;
  if (GL) {
    wrapAfter(GL, "transformFeedbackVaryings", (a) => {
      if ((a[1] ?? []).includes("kout0")) info.skinning = "webgl2";
    });
    wrap(GL, "bufferSubData", (a) => {
      add("gl.bufferSubData");
      add("gl.upload.bytes", typeof a[4] === "number" && a[2]?.BYTES_PER_ELEMENT ? a[4] * a[2].BYTES_PER_ELEMENT : bytesOf(a[2]));
    });
    wrap(GL, "bufferData", (a) => {
      add("gl.bufferData");
      if (typeof a[1] !== "number") add("gl.upload.bytes", bytesOf(a[1]));
    });
    wrap(GL, "texSubImage2D", (a) => {
      add("gl.texSubImage2D");
      const data = a.find((x) => x && typeof x === "object" && typeof x.byteLength === "number");
      add("gl.upload.bytes", bytesOf(data));
    });
    wrap(GL, "texImage2D", () => add("gl.texImage2D"));
    for (const n of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "drawRangeElements"]) wrap(GL, n, () => add("draws"));
    wrap(GL, "beginTransformFeedback", () => add("gl.feedbackPasses"));
    wrap(GL, "useProgram", () => add("gl.useProgram"));
    wrap(GL, "bindBuffer", () => add("gl.bindBuffer"));
    wrap(GL, "bindBufferBase", () => add("gl.bindBuffer"));
    wrap(GL, "bindVertexArray", () => add("gl.bindVertexArray"));
    wrap(GL, "bindTexture", () => add("gl.bindTexture"));
    wrap(GL, "bindFramebuffer", () => add("gl.bindFramebuffer"));
    wrap(GL, "vertexAttribPointer", () => add("gl.vertexAttribPointer"));
    wrap(GL, "enable", () => add("gl.enableDisable"));
    wrap(GL, "disable", () => add("gl.enableDisable"));
    for (const n of Object.getOwnPropertyNames(GL)) if (/^uniform(\d|Matrix|Block)/.test(n)) wrap(GL, n, () => add("gl.uniform"));
    // Calls that make the page wait for the GPU process (round trips).
    for (const n of ["getError", "getParameter", "getBufferSubData", "readPixels", "finish", "clientWaitSync", "getProgramParameter", "getShaderParameter", "getUniformLocation", "getQueryParameter", "checkFramebufferStatus"]) wrap(GL, n, () => add(`wait.${n}`));
  }

  globalThis.__animBenchCounts = {
    info,
    snapshot: () => ({ ...c }),
  };
})();
