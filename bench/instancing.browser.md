# Measuring GPU instancing in a real browser

`bench/instancing.bench.ts` runs on Babylon's NullEngine: it measures CPU work (sync, culling, sorting, draw dispatch)
and derives draw calls, but NullEngine has no GPU, so it cannot show GPU frame time. For that, use a real WebGL/WebGPU context.

1. `npm run dev`, then open `http://localhost:3000/editor.html` (or `?sample=flappy`).
2. Build a scene of many cubes: one entity with a `MeshRenderer` (`mesh: builtin:cube`, one shared material asset),
   duplicated 1000 to 4000 times (a script that spawns them in `start` is easiest). Add a `Camera` that sees them all.
3. Compare the variants by editing the material asset's `instancing` field:
   unset (auto, GPU instances), `"thin"` (thin-instance buffer, play mode only; the editor scene view keeps per-object instances for picking), `"off"` (one mesh per renderer, the baseline).
   For sprites, play mode batches them; the editor's scene view keeps one mesh per sprite.
4. Press Play and turn on the **Stats** toggle in the play bar (`src/editor/ui/PlayStats.tsx`). It shows frame rate, per-phase
   timings (update, fixed, render ms) and the render counters from `renderStats(world)` (`src/engine/editor/index.ts`). Watch the
   frame rate and render ms across variants. The GPU row only lists geometry, texture and program counts, not GPU time.
5. For GPU time itself, use the browser's tools: Chrome DevTools Performance panel (GPU track), or `chrome://gpu` and
   "Rendering > Frame Rendering Stats".

`BabylonRenderer.renderStats().drawCalls` reads Babylon's draw-call counter for the last frame drawn, so the overlay's
Draw calls row shows real numbers (triangles are still 0). Babylon's inspector or Spector.js (a browser extension that
captures a frame's WebGL calls) give a per-call breakdown.
