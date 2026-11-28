# Spike: what the game player ships, and what one lazy import per launch step costs

Measured at commit `33f89a4c` (branch `claude/admiring-hypatia-n09ol2`, fast-forwarded into this worktree). Sizes are
deterministic. Throwaway: nothing outside `spikes/player-chunks/` changed, `dist/player/` untouched (output goes to
`spikes/player-chunks/out/`, which is not committed).

Informs ADR 0451 (localisation plugin) and ADR 0452 (launch steps from plugins).

## Files and commands

| File | Purpose |
|---|---|
| `report-plugin.ts` | Rollup/Vite plugin: in `generateBundle` records per chunk raw, gzip-9, brotli-11, imports, dynamicImports and per-module `renderedLength` |
| `vite.spike.player.config.ts` | `mergeConfig(vite.player.config.ts, {plugins:[chunkReport], build.outDir: out/player})` (real config unmodified) |
| `analyze.mjs` | chunk table, feature to chunk map, localisation by group |
| `eager.mjs` | static-import closure of the three entries (eager vs lazy) and per-file localisation estimates |
| `lazy-overhead.mjs` | N trivial dynamic-import steps through Vite with `typescriptTranspile()` + `oxc: false` |
| `eager.txt`, `lazy-results.txt`, `build.log` | raw outputs |

```
npx vite build --config spikes/player-chunks/vite.spike.player.config.ts   # 57 s, 311 chunks
node spikes/player-chunks/analyze.mjs      # full tables (long: 311 rows)
node spikes/player-chunks/eager.mjs
node spikes/player-chunks/lazy-overhead.mjs
```

`npm run build:player` is `vite build --config vite.player.config.ts`; the spike config is that plus the plugin.
The bundler is Rolldown-backed Vite (build log has `[PLUGIN_TIMINGS]`), minified with its default minifier.

Caveat on module sizes: Rollup's `renderedLength` is per module after tree-shaking but **before** minification, so
the per-module sums are about 1.6x the minified bytes. Where this README gives per-module raw/gzip "estimates" it
scales `renderedLength` by the owning chunk's (minified raw or gzip) / (sum of rendered) ratio. Those are estimates;
chunk totals are exact.

## 1. The player build as a whole

311 chunks, **15,232 kB raw, 5,026 kB gzip** in total, of which:

| Set | Chunks | Raw kB | Gzip kB | Brotli kB |
|---|---|---|---|---|
| Eager (static closure of `player-*.js`, `myco.js`, `myco-ui-host.js`) | 47 | 2,047 | 645 | 556 |
| Lazy-only | 264 | 13,185 | 4,381 | n/a |

Eager does not mean "loaded by every game": it is what the three entries import statically (the engine core, the
Babylon pieces the renderer entry pulls, the audio runtime). Rapier (2D 3,337 kB, 3D 4,241 kB raw; 1,255 / 1,608 kB gzip,
WebAssembly inlined) and three.js are lazy and dominate the bytes, but only a project that uses them fetches them.

Largest chunks (full table via `analyze.mjs`; contents are the top module groups by rendered kB):

| Chunk | Class | Raw kB | Gzip kB | Contents |
|---|---|---|---|---|
| rapier3d | lazy | 4,241.2 | 1,607.8 | `@dimforge/rapier3d-compat` |
| rapier2d | lazy | 3,337.2 | 1,255.3 | `@dimforge/rapier2d-compat` |
| myco (engine core) | shared | 757.0 | 237.0 | plugins/animation 283, engine/net 190, engine/input 141, engine/animation 122, small `debugLink/topics`, localisation `runtime/boot` |
| three.module | lazy | 725.4 | 181.1 | three.js (OBJ/MTL/FBX/glTF loaders are separate lazy chunks, 8 to 49 kB) |
| layeredQuads | shared | 448.0 | 112.2 | Babylon core + `engine/render` |
| draco_decoder | lazy | 436.0 | 100.7 | glTF Draco decoder |
| math.vector | shared | 299.7 | 71.5 | Babylon core |
| take | shared | 227.7 | 76.4 | audio plugin runtime (328 kB rendered), capture `take/capture`, subtitles |
| engine.multiRender.pure, materials, vertexPullingHelper, sceneComponent, ... | shared | 225 to 190 each | 43 to 63 | Babylon core |
| BabylonRenderer | lazy | 213.7 | 62.4 | `engine/render` + Babylon |
| assembly | lazy | 213.5 | 68.5 | audio plugin graph assembly |
| ui, filters, styledTree, uiFeature | shared/lazy | 175, 156, 66, 57 | 47, 41, 22, 20 | UI core (`engine/ui` about 600 kB rendered in total) and `@babylonjs/gui` |
| `player-*.js` (entry) | entry | 7.7 | 3.3 | `player/main.ts` 6.2 kB rendered, `buildLaunch.ts` 1.4 |
| `myco.js`, `myco-ui-host.js` | entry | 7.2, 9.7 | 3.2, 4.3 | fixed-name re-export entries |

Feature totals (rendered kB across all chunks, pre-minify): Babylon 4,611 (core + gui), Rapier 7,643, three.js 1,411,
audio runtime (plugin) 1,156, UI core `engine/ui` 604, capture 105, debug link 74, localisation 62. Svelte: 0 (ADR 0425,
the player carries no Svelte; a game's UI bundle brings it).

## 2. Localisation's share

`src/engine/localisation/**` as bundled in the player, estimated minified bytes (module rendered length scaled by the
chunk ratio). 63.3 kB rendered, **about 38.8 kB raw / 14.2 kB gzip** after minification, that is 1.9% of the eager
closure's raw and 2.2% of its gzip (0.28% of all gzip).

| File / group | Raw ~B | Gzip ~B | Where it lands |
|---|---|---|---|
| `Locale.ts` | 5,177 | 2,054 | `Locale--*.js` (shared, eager) |
| `languages.ts` | 5,873 | 1,937 | `format-*.js` (shared) |
| `lenient.ts` | 1,876 | 619 | `format-*.js` |
| `variants.ts` | 639 | 214 | `Assets-*.js` |
| `pseudo.ts` | 978 | 388 | `Locale--*.js` |
| `t.ts` | 319 | 106 | `preferences-*.js` |
| `textHash.ts` | 1,610 | 961 | own chunk `textHash-*.js` |
| `message/` (format 2,339; parse 4,647; numberStyle 1,026) | 8,012 | 2,798 | format chunk, Locale chunk |
| `strings/` (format 2,789; translation 1,396) | 4,185 | 1,474 | format chunk, Locale chunk |
| `runtime/` (assets 962, boot 913, buildFile 1,444, participants 279, strings 2,141) | 5,739 | 2,200 | `Locale--*.js`, `myco-*.js` (boot) |
| `subtitles.ts`, `subtitleSettings.ts` | 4,440 | 1,488 | `take-*.js`, `World-*.js` |
| **Total** | **38,848** | **14,239** | |

**`exchange/` is not in the player** (zero modules in any chunk): confirmed by grepping the module report. Nothing in
the player pulls CSV/XLIFF/PO, gathering or `maxLength`.

Everything else in `localisation/` is in eager chunks, scattered across seven shared chunks (`Locale--`, `format-`,
`take-`, `World-`, `Assets-`, `preferences-`, `myco-`), several of which are shared with audio, UI core and animation.
So today no single chunk "is" localisation, and a one-language game pays for strings, ICU parsing and translation
format code.

Estimate of the ADR 0451 split (unverified: the Locale.ts split is by line ranges, not by symbol-level tree-shaking):

| Part | Raw ~kB | Gzip ~kB | Basis |
|---|---|---|---|
| Language core stays (languages.ts, variants.ts, about half of Locale.ts for state/formatters/participants, `lenient.ts` if `languages.ts` needs it) | 9.1 to 11.0 | 3.2 to 3.8 | 5,873 + 639 + about 2,600 (+ 1,876) |
| Moves to `myco.localisation` (message/, strings/, runtime/ except boot, pseudo, t.ts, textHash, rest of Locale.ts and LocalText) | about 25 | about 9.0 | 38.8 minus the core |
| Moves to `myco.subtitles` (not the localisation plugin) | 4.4 | 1.5 | ADR 0451 "Other moves" |

So a game without the plugin saves roughly 25 kB raw / 9 kB gzip, under 1.5% of the eager closure. The motivation for
0451 is modularity and clean opt-out, not player size: the saving is small next to Babylon (4.6 MB rendered), Rapier or
the audio runtime (1.2 MB rendered).

## 3. Per-feature lazy chunks in `src/player/main.ts` today

`player-*.js` has these dynamic imports (verified from the report: `dynamicImports`): `audioEffects`, `engineGate`,
`tauriListener`, `host`, `debugOverlay`, `tauriDiscovery`, `config`, `trigger`, `take`. Script/plugin/bootstrap
modules use `import(/* @vite-ignore */ url)` (user code, not in the bundle).

| Feature (import site) | Chunks (raw / gzip kB) | Notes |
|---|---|---|
| Audio effects (`./audioEffects`, `engineGate`) | audioEffects 9.6 / 3.9; engineGate 1.1 / 0.7 | gated on the build's effect plugins |
| Debug link (`debugLink/host`, `tauriListener`, `tauriDiscovery`, `config`, `debugOverlay`) | host 18.7 / 6.8; rooms 18.8 / 6.4; tauriListener 15.2 / 5.4; config 3.2 / 1.3; debugOverlay 1.0 / 0.6; tauriDiscovery 0.9 / 0.5; records 0.7 / 0.4; shared host-* 5.7 / 2.3; topic chunks (audio 9.3 / 3.7, animation 1.6 / 0.8) | about 74 kB rendered across 10+ chunks; release exports leave them out (ADR 0376) |
| Capture (`capture/trigger`) | trigger 3.3 / 1.7; recorder 9.6 / 3.5; events 8.7 / 3.3; format 20.4 / 7.2; save 4.8 / 2.2 | the `lazyOnly([CAPTURE_CODEC])` codec |
| Take triggers (`capture/take`, `trigger.installTakeTrigger`) | take 227.7 / 76.4 (shared, see below); takeRecorder 9.4 / 3.6; takeOwnership 0.8 / 0.5; takeRecord 3.6 / 1.6 | |
| Strings | none | `installBuildStrings` is imported statically (Locale chunk), not lazy |

Finding: `take-*.js` (228 kB raw, the audio plugin runtime) is listed in the entry's `imports` as well as its
`dynamicImports`, so it is an **eager** chunk; Rollup warned `INEFFECTIVE_DYNAMIC_IMPORT` for `plugins/audio/runtime/index.ts`
(statically imported by `src/myco.ts`, `src/plugins/runtime.ts`, `SubtitleDisplay.ts`). The `import("capture/take")` in
`main.ts` therefore moves nothing today. Same warning for `plugins/physics/runtime/index.ts`. Worth knowing before
ADR 0452 promises that a lazy step keeps a plugin's code out: any static import of the plugin runtime elsewhere defeats it.

## 4. Cost of one lazy import per launch step

`lazy-overhead.mjs`: a main module with N steps, each `() => import("./stepK")` of a 3-line async function, built via
Vite with `typescriptTranspile()` and `oxc: false` (`modulePreload.polyfill: false`), versus the same N statements
inline in one module. Totals over all emitted files (gzip/brotli are per file, so they include each file's own header).

| N | inline raw B | lazy files | lazy raw B | lazy gzip B | lazy brotli B | inline gzip B |
|---|---|---|---|---|---|---|
| 0 | 36 | 1 | n/a | n/a | n/a | 53 |
| 1 | 81 | 2 | 1,882 | 1,016 | 875 | 89 |
| 5 | 231 | 6 | 2,420 | 1,436 | 1,223 | 118 |
| 20 | 811 | 21 | 4,465 | 2,992 | 2,466 | 192 |

Output excerpt (`lazy-results.txt`):

```
lazy   N= 1  files=2  raw=1882  gzip=1016  brotli=875  entry-raw=1808
lazy   N=20  files=21  raw=4465  gzip=2992  brotli=2466  entry-raw=2958
```

- **Fixed cost: about 1.75 kB raw / 0.95 kB gzip**, Vite's preload helper (`__vitePreload`: modulepreload/CSS link logic,
  CSP nonce, `vite:preloadError` event) emitted once. In the real player it is already paid: `preload-helper-*.js`
  is in the entry's static imports, so **the helper adds zero for launch steps**.
- **Marginal cost per step: about 136 B raw / 104 B gzip / 82 B brotli** (slope from N=5 to N=20: 2,045 B raw and
  1,556 B gzip over 15 steps). That is the step chunk (about 70 B wrapper: `export{e as run}` plus filename) plus the
  entry's `a(()=>import("./stepK-HASH.js"),[],import.meta.url)` call. Hashed filenames are the bulk of it; the
  per-file gzip header adds about 20 B.
- Twenty steps cost about 2.7 kB raw / 2 kB gzip beyond a single bundle, i.e. 0.3% of the player's eager gzip. Byte
  cost is negligible. Request count and latency were not measured (desktop first); each step is one more sequential
  `await import()` round trip, and chunks that share dependencies still add `imports` the preload helper fetches in
  parallel.
- Caveat: real steps import shared code, so the cost is whatever Rollup's chunking does with shared modules, not the
  wrapper. Rollup can create small shared chunks (the player has 47 eager chunks of 311 total, many under 1 kB).

## Conclusions for the design

1. **0451 is not a size win.** Localisation is about 39 kB raw / 14 kB gzip as shipped, split across seven shared
   chunks; roughly 25 kB raw / 9 kB gzip leaves the engine core. Justify the plugin by modularity and opt-out, not bytes.
2. **`exchange/` is already absent**; the editor-only exchange code costs the player nothing, so moving it to the
   plugin's editor half changes no player size.
3. **A lazy step is cheap in bytes** (about 136 B raw / 104 B gzip each; the preload helper is already in the player).
   The risk is not the wrapper but chunking: steps whose plugin runtime is also imported statically (audio's
   `INEFFECTIVE_DYNAMIC_IMPORT`) stay in an eager chunk and give no saving. 0452 should make the lazy step the only
   importer of a plugin's runtime, or report ineffective steps at build time.
4. Lazy features already in `main.ts` (debug link about 74 kB over 10+ chunks, capture about 105 kB) are the template: each is
   already a handful of small chunks, so a per-step lazy import adds about 0.1 kB per chunk on top of that.
5. The player entry itself is 7.7 kB raw / 3.3 kB gzip, so launch-phase orchestration is not where the bytes are:
   the player's cost is Babylon, the audio runtime and `myco` core, all eager today.

## Unverified

- Per-module minified/gzip numbers are scaled estimates (see caveat above); chunk numbers are exact.
- The language-core vs plugin split of `Locale.ts` is by judgement from ADR 0451's text, not from symbol analysis.
- Whether the lazy-step overhead holds with `base: "./"` and the real chunk graph (the spike used trivial steps).
- Runtime load time and request count: not measured.
