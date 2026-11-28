# Build log: mesh LOD (0446) and occlusion culling (0447)

Coordinator's log of merges, checks and findings. Newest last.

## 2026-11-28

- **Owner decisions:** accepted both records; decision 1 opt-in LOD generation; decision 2 the owner runs real-hardware
  measurements later; decision 3 tolerant occlusion (false occlusions under 16 px at 1080p accepted).
- **First wave:** `spikes/lod-apply/` (per-view object lists 0.055 ms/view at 10k instances; shared vertex buffers 1.13x),
  `spikes/occlusion-safety/` (the rules as first written failed; sloppy stand-ins dropped; decided rules in 0447 §3).
- **Wave 1 merged:** T1 import pipeline (946b858e), T2 visibility core and `LODGroup` (7b47b980), T4 benchmark and
  triangle stats (80f54ceb). Merge fixes: triangles report the last finished frame (a slow frame read early showed 0);
  `.mycomesh` v5 in two older tests; the editor installs the LOD host; `LodMember.castShadows` added to the contract.
- **Benchmark check:** city-auto reports 10,379,022 triangles per frame through the new counter (spike: 10.3M).
- **Wave 2 merged:** T5 Babylon application (4c7e4176), T6 editor (f292cdee). Merge fixes: `LODGroup` in the Rendering
  category; the import panel's styles moved into the meshes plugin (plugins reach the editor only through its SDK).
- **Checks on the merged wave 2:** typecheck clean; `npm test` 13,702 passed after the two fixes above; `npm run test:e2e`
  286 passed, 3 failed. `audio-mix-smoke.spec.ts:129` passed on re-run (flaky under load). **Pre-existing on master
  6a0740ca, not caused by this work:** `dragdrop.spec.ts:69` and `hierarchy.spec.ts:54` (drops onto nodes inside prefab
  instances) fail identically on an untouched master checkout.
