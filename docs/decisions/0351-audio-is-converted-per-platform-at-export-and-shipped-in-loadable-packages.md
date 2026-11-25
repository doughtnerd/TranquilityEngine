# 0351. Audio is converted per platform at export, from inherited encoding settings, and ships in loadable packages

- **Status:** Accepted, amended by [0359](0359-audio-encoding-follows-the-a0-spike.md) (encoder build, resampling, Opus decode, ADPCM decode and notices from the A0 spike)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0040 (extended: the sidecar gains an `encoding` block), 0041, 0115, 0119, 0155, 0157, 0171, 0179, 0293, 0296, 0342, 0343, 0344, 0345, 0348, 0349, 0352

## Context

The owner's follow-on scope (plan "Follow-on scope", 2026-11-22) asks for per-platform encoding and packaging, first
in order with third-party DSP (0352), following Wwise and FMOD.

**What exists today.**
- A game build (0041, 0296) copies every audio file as it is. Only images are processed per platform (0119:
  `processImages` re-encodes to WebP under the same path, resolved for `web` or `desktop`).
- Sidecars (`myco.import@1`, 0040) hold `volume`, `stream`, loop points, `ambisonic` and the `sample` block (0342).
  Per-platform overrides (`platforms`, 0115) exist for image keys only. `ImportPlatform` is `"web" | "desktop"`;
  Android is an accepted export target (0155, 0169) that isn't built yet.
- 0342 says "Format and Sample rate are export settings (0119)" without defining them, and that exports render baked
  samples (the offline render is W9-B work).
- **Decoding** (`audio-decode`, symphonia 0.6.1, 804,382 B; gate 900 KB): WAV/PCM, FLAC, MP3, Ogg Vorbis; AAC in a
  second build (1,128,625 B) behind `audio.codecs.aac`. symphonia 0.6.1 also has an `adpcm` feature (IMA and Microsoft
  ADPCM) we don't enable. It has **no Opus decoder**, and there is no encoder of any kind in the repo.
- **Memory.** Decoded clips are int16 in the core's clip arena (`audio.clipMemoryMB`, a per-preset ceiling).
  `stream: true` decodes in the decoder worker into one of the core's **stream rings**: 4–16 of them
  (`max_mixed / 16`, `stream.rs`), shared by every streamed voice.
- **Loading.** `Assets` maps a project path to a URL; the clip resolver (0293) turns a path into a play request, and a
  clip loads on demand the first time something plays it or a scene preloads it. Nothing groups sounds, and nothing
  unloads a clip except asset release and play-session end.

**How the reference tools do it.**
- **Wwise:** *Conversion Settings* ShareSets (codec, quality, sample rate, channels) assigned in the hierarchy and
  inherited, with per-platform overrides; streamed media stays loose (`.wem`) with an optional zero-latency prefetch;
  *SoundBanks* group events and media, loaded and unloaded by code or by the `AkBank` component; the Init bank always
  loads; the SoundBank report gives size per platform.
- **FMOD:** per-platform encoding (Vorbis, FADPCM, Opus, PCM) and quality, set per bank or per asset; *banks* hold
  events and sample data; the Master bank always loads; `loadSampleData` separates metadata from sample data; loading
  modes "decompress", "compressed" and "stream".
- **Unity:** per-clip Load Type (Decompress On Load, Compressed In Memory, Streaming), Compression Format (PCM, ADPCM,
  Vorbis), Quality, Sample Rate Setting, Force To Mono, with platform overrides; Addressables for groups.
- **Unreal:** per-platform compression quality and the Audio Stream Caching chunk cache; sound groups for defaults.

## Decision

We will convert audio per platform in the export, from encoding settings inherited project → folder rule → file →
platform, cache the results by content hash, ship optional **packages** (banks) that scripts load and unload, and show
sizes, memory and the converted sound per platform in the Studio.

### 1. Platforms

- `ImportPlatform` becomes `"web" | "desktop" | "android"` (`src/engine/scene/importSettings.ts`). Export targets map
  one to one (`--target web|desktop|android`; Android when 0155's exporter lands). `Assets.platform` detects `android`
  under Tauri mobile. Image overrides (0115) gain the platform too, at no cost.
- The editor's Play and the Studio play **sources** by default (fast iteration); the Studio's **Hear as** (§6) plays
  what a platform would ship.

### 2. Encoding settings and inheritance

One settings shape, `EncodingSettings` (`src/engine/audio/encoding/types.ts`), every key optional:

| Key | Values | Meaning |
|---|---|---|
| `codec` | `auto` · `source` · `pcm` · `adpcm` · `vorbis` · `opus` | `auto`: lossless sources (WAV, FLAC, AIFF) → `vorbis`, lossy sources (MP3, Ogg, M4A) shipped as they are; `source`: never converted |
| `quality` | 0..1 | Vorbis: `q = quality × 10` (0.4 ≈ 112 kbps stereo at 44.1 kHz); Opus: 16 + 112 × quality kbps per stereo pair; ignored for `pcm`/`adpcm` |
| `sampleRate` | `source` · 11025 · 16000 · 22050 · 24000 · 32000 · 44100 · 48000 | A ceiling: never upsampled; Opus always 48000 |
| `channels` | `source` · `mono` | `mono` downmixes as (L+R)/2; refused for ambisonic files (an error naming the file) |
| `load` | `decode` · `compressed` · `stream` | §3 |
| `prefetchMs` | 0..2000 | `compressed`/`stream`: the first N ms decoded into the clip arena, so the sound starts at once and sample-accurately |

**Where settings live and how they resolve** (`src/engine/audio/encoding/resolve.ts`, pure). Each key resolves on its
own, first hit wins:

1. the file's sidecar `encoding.platforms.<platform>`;
2. the file's sidecar `encoding` (and the profile it names);
3. the profile chosen for the file (sidecar `encoding.profile`, else the first matching folder rule, else
   `encoding.default`) — its `platforms.<platform>`, then its base;
4. the engine's built-in default for the platform (below).

Derived samples (`*.sample.json`, 0342) resolve through their own file's sidecar-equivalent `encoding` key, then their
source's chain as above. A sidecar's legacy `stream: true` reads as `load: "stream"`; the Studio writes only `load`.

**`audio.json`** (0344) gains an `encoding` section (Wwise's ShareSets and hierarchy assignment, Unity's Preset Manager
filters):

```jsonc
"encoding": {
  "default": "Default",
  "profiles": {
    "Default":  { "codec": "auto", "quality": 0.5, "load": "decode",
                  "platforms": { "android": { "quality": 0.35, "sampleRate": 32000 } } },
    "Music":    { "codec": "vorbis", "quality": 0.6, "load": "stream", "prefetchMs": 250 },
    "Dialogue": { "codec": "opus", "quality": 0.3, "channels": "mono", "load": "compressed" },
    "UI":       { "codec": "adpcm", "load": "compressed" }
  },
  "rules": [                                      // first match wins; globs as in .gitignore, project paths
    { "path": "audio/music/**", "profile": "Music" },
    { "path": "audio/vo/**",    "profile": "Dialogue" }
  ],
  "budgets": { "web": { "downloadMB": 40, "memoryMB": 64 }, "android": { "downloadMB": 60, "memoryMB": 48 } }
}
```

**The sidecar** gains an optional `encoding` block (still `myco.import@1`; old readers ignore it):

```jsonc
"encoding": { "profile": "UI", "quality": 0.7, "platforms": { "android": { "channels": "mono" } } }
```

It has its own `platforms` rather than reusing the image `platforms` object, so image and audio keys never mix.
Parse is lenient: unknown keys, bad values and unknown platforms are skipped with one problem line each; a profile name
that doesn't exist falls back to the default with a problem.

**Built-in defaults** (`encoding/defaults.ts`): `codec: auto`, `load: decode`, `sampleRate: source`,
`channels: source`, `prefetchMs: 0`; quality 0.6 desktop, 0.5 web, 0.4 Android. So a project with no encoding settings
ships its lossy files unchanged and its WAV/FLAC files as Vorbis.

### 3. Load modes

| `load` | Where the sound lives at runtime | Voices | Use |
|---|---|---|---|
| `decode` | int16 PCM in the clip arena (decoded when its package or clip loads) | any number | short, frequent SFX |
| `compressed` | `adpcm`: the ADPCM blocks in the clip arena, decoded by the voice inside the core. `vorbis`/`opus`: the encoded bytes in the decoder worker, decoded into a stream ring as the voice plays | ADPCM any number; Vorbis/Opus share the stream rings | ADPCM: many concurrent SFX at ≈ ¼ the memory (FMOD FADPCM, Wwise ADPCM). Vorbis/Opus: long ambiences and dialogue |
| `stream` | a loose build file, fetched progressively as it plays, through a stream ring; `prefetchMs` of it decoded into the arena when its package loads | stream rings | music, long beds |

- **ADPCM in the core.** A new clip format `ADPCM_IMA` (CLIP_BEGIN `format = 6`): IMA ADPCM blocks of 1,024 frames per
  channel with their predictor headers, so any block decodes alone. A voice keeps a 1,024-frame decode cache per channel
  and decodes a block when its read position enters it; loops and seeks land mid-block by decoding the block and
  skipping in. A wire minor bump (an added format value: ABI 4.8, or the next minor if W11 bumps first). Cost is counted by the metered gate (raised with a
  build-log note if needed).
- **Compressed Vorbis/Opus** use the existing stream-voice path with an in-memory source, so they inherit gapless loops,
  seek fades and starvation handling. When every ring is busy the voice is refused like any stream voice (profiler
  reason `noStreamRing`), and the Studio lints a playlist that can layer more compressed/streamed voices than the
  platform preset's rings.
- **Prefetch.** A `compressed`/`stream` sound with `prefetchMs > 0` starts on its arena head and hands over to the ring
  at a chunk boundary (as M1b's "waiting for data" state, but without the wait).

### 4. Codecs

| Codec | Decode (game) | Encode (export, Studio) | Licence |
|---|---|---|---|
| `pcm` | existing | trivial (16-bit WAV) | — |
| `adpcm` | symphonia `adpcm` feature (decoder worker) and the core's ADPCM reader (§3) | our own IMA ADPCM encoder (public algorithm) in Rust | — |
| `vorbis` | existing (symphonia) | libvorbis 1.3.x + libogg (C) | BSD-3-Clause |
| `opus` | libopus decoder in the **default** decoder build, Ogg Opus with pre-skip and end trimming | libopus encoder (C) | BSD-3-Clause; royalty-free patent grants |

- **The encoder** is a new crate `native/audio/crates/audio-encode`, built by `npm run build:audio` to
  `myco_audio_encode.wasm` for `wasm32-wasip1` (the C libraries need a libc; it never runs in the worklet). It holds the
  four encoders, the resampler (`rubato`, MIT; windowed sinc, offline quality) and the downmix. It runs in a Node
  `worker_threads` pool in the CLI (Node's built-in WASI) and in a Web Worker in the editor and Studio (a ≤ 60-line WASI
  shim: `fd_write` to the console, `random_get`, `clock_time_get`, `proc_exit`). It is never shipped in game builds.
  Building it needs the pinned wasi-sdk clang; the output is committed like the decoder, with a size tripwire of 1.5 MB.
- **Opus decode** compiles libopus (fixed-point, no libc beyond what Rust's `compiler_builtins` and `libm` provide)
  into `audio-decode` for `wasm32-unknown-unknown`. If that adds more than the decoder gate allows, the gate is raised
  with a build-log note (CLAUDE.md: gates are tripwires); the AAC build gets Opus too.
- **Gapless and loops.** Loop points and markers are in seconds (0342), so rate conversion doesn't move them. Vorbis
  granule positions and Opus pre-skip are written and honoured so a converted loop stays sample-accurate; a golden test
  per codec checks the seam.
- **Not chosen:** MP3 encoding (LAME is LGPL and MP3 is worse than Vorbis at the same size), AAC encoding (patent-
  encumbered encoders), FLAC as a shipping codec (decode-heavy for little saving over Vorbis at high quality; sources may
  still be FLAC).

### 5. Conversion in the export

A pure planner, `processAudio(plan, options)` in `src/export/audio.ts`, beside `processImages` (0119), with the
encoder injected as an `AudioEncoder` (`audioEncoderNode.ts`, `audioEncoderBrowser.ts`, like `imagesNode.ts` and
`imagesBrowser.ts`). The build writer (0296) runs it in step 3, after baking models and processing images:

1. **Collect** every audio file and derived sample the build ships (today's file selection), plus each sample's
   **offline render** (0342/0345: baked effects, trim, closed gaps, normalisation) when it has one: the render's PCM is
   the conversion input, never the raw source.
2. **Resolve** each one's `EncodingSettings` for the build's platform (§2).
3. **Cache key** = SHA-256 of (input bytes or render hash, resolved settings as canonical JSON, encoder version). Hits
   come from `.myco/cache/audio/<key>.<ext>` (Node: the project folder; editor: the same through `FileSystem`, else
   IndexedDB in a browser without folder access). The Studio's audition (§6) fills the same cache.
4. **Encode** misses in parallel (workers = cores − 1), with progress lines.
5. **Place** each result: in its package (§7) or as a loose file at its **own project path** with the converted bytes
   (`step.wav` may hold Ogg Vorbis bytes, as 0119 keeps `hero.png` holding WebP). The decoder and the fallback detect
   format by content (symphonia's probe; the extension is only a hint); a test covers a mismatched extension.
6. **Write the media table** into `game.json` under `audio` (§7) and a report, `audio-report.json`, beside the build
   (not in it): every sound's source size, shipped size, codec, rate, channels, load mode, packages, and per-package
   totals.
7. **Skip copies** of sources that went into a package (the plan's new `omit` set; the writer's "write each file once"
   rule already skips copies replaced by a processed file).

The CLI prints a summary (`audio: 212 files, 48.1 MB → 9.7 MB for android; 3 packages`) and a warning line per budget
passed (§8). `--no-audio-convert` ships sources unchanged (debugging), and the report says so.

### 6. The Studio

- **Samples Inspector → Encoding** section: a platform switch (Web · Desktop · Android), one row per key showing
  the inherited value and where it comes from ("Music profile", "rule audio/music/**", "built-in"), with an override
  control and a reset; the readouts per platform: source size, shipped size (exact once cached, else an estimate from
  bitrate × length, marked "≈"), ratio, runtime memory by load mode, and packages it's in.
- **Hear as** (Source · Web · Desktop · Android) in the player bar: the Studio runtime plays converted media for that
  platform for every sound it plays (auditions, playlists, take replay), encoding misses in the background with a
  progress chip; A/B against Source with one key. The editor's Play keeps sources.
- **Packages screen** (new, `src/studio/screens/packages/`; Wwise's SoundBank Manager, FMOD's Banks tab), from the kit
  (0349): a packages tree; a contents table (sound, profile, codec, load, shipped size and memory for the chosen
  platform, "in N packages" warning, missing-from-any-package hint for sounds a scene or script names); a package
  inspector (preload, platforms it ships on, totals against budgets); a Profiles tab editing `encoding.profiles` and
  `rules` with a preview of which files each rule catches; **Convert now** warms the cache for a platform; **Report**
  shows `audio-report.json`'s view without exporting.
- **Profiler** (0348): a memory track with the arena, decoder-held compressed bytes and rings, and package load and
  unload marks (§9).

### 7. Packages

**Authoring** in `audio.json`:

```jsonc
"packages": [
  { "name": "Core",   "preload": true,  "include": ["audio/ui/**", "playlists/ui/**"] },
  { "name": "Forest", "include": ["playlists/forest/**", "audio/amb/forest_bed.wav"] },
  { "name": "Boss",   "include": ["playlists/boss_theme.playlist.json"], "platforms": ["desktop", "web"] }
]
```

- `include` lists playlists, samples, derived samples and globs. **Dependencies are added automatically**: a playlist
  brings its samples, nested and embedded playlists; a derived sample brings its source or render. Names are unique; a
  rename rewrites `AudioPackageLoader` fields through the named-list module (0262). Script string literals aren't
  rewritten; the Studio lints names in `Audio.package("…")` calls it can read that match no package.
- A sound may be in several packages: the bytes are duplicated in each package file (download cost, flagged in the
  Packages screen) and shared at runtime (one clip, reference-counted).
- **Loose sounds**: anything in no package ships as today (a loose file, loaded on demand). A project without
  `packages` behaves exactly as before.
- `strict` (`"packaging": { "strict": true }`, default true): playing a packaged sound whose packages are all unloaded
  is refused with handle reason `notLoaded` and one warning naming the package (Wwise and FMOD fail the same way).
  The editor's Play and the Studio enforce the same rule over sources, so a missing load shows before export. With
  `strict: false` the sound loads on demand with the warning.

**Build output** (`src/engine/audio/packaging/format.ts`, pure reader and writer):

```
audio/packages/<name>.mycopak
  "MYCOPAK1"  u32 tocBytes  TOC (UTF-8 JSON)  entries (16-byte aligned)
TOC: { "format": "myco.audiopack@1", "name": "Forest", "platform": "web",
       "entries": [{ "path": "audio/amb/birds.wav", "offset": 4096, "bytes": 18211, "codec": "vorbis",
                     "rate": 32000, "channels": 2, "frames": 961000, "load": "decode", "hash": "…",
                     "prefetch": null }] }
```

- `stream` sounds are **not** inside the package: their media ships loose under `audio/stream/<hash>.<ext>` (Wwise's
  loose streamed media), and the package holds only their prefetch head (an entry with `prefetch: { frames }`).
- `game.json` gains `audio: { platform, packages: [{ name, url, bytes, preload }], media: { "<project path>":
  { package?: string, url?: string, codec, load, rate, channels, frames } } }`. The clip resolver consults this media
  table first; `Assets` keeps serving everything else. References in scenes, playlists and scripts stay project paths.

**Runtime** (`src/plugins/audio/runtime/media/`: `mediaTable.ts`, `packages.ts`; the decoder worker gains
`packs.ts`):
- A package load fetches the `.mycopak` with progress, transfers the buffer to the decoder worker, which parses the
  TOC and, per entry: decodes `decode` entries to int16 and sends them to the clip arena (the existing chunked clip
  path); sends ADPCM `compressed` entries to the arena as format 6; keeps Vorbis/Opus `compressed` entries as slices of
  the package buffer; decodes prefetch heads. The package is `loaded` when every arena copy is committed.
- Clips are reference-counted across packages. Unloading a package frees clips no other loaded package holds.
- **Preload**: `preload: true` packages load at engine start, before the first scene starts (FMOD's Master bank,
  Wwise's Init bank); the player waits for them as it waits for scene assets.
- The **Babylon fallback** (0179) can't fetch a URL for a package entry, so it takes packaged and converted media as
  PCM from the decoder worker into `AudioBuffer`s, and ADPCM `compressed` plays as `decode` there.
- The dedicated server and headless Worlds never load packages.

### 8. Budgets

`encoding.budgets.<platform>`: `downloadMB` (all audio in the build) and `memoryMB` (the preload packages plus the
largest non-preload package, a static upper bound for one level's worth of sound). Both are **tripwires** (CLAUDE.md):
the Packages screen shows the bar in `var(--danger)` past them and the export prints a warning, never fails. A real
platform limit (Google Play's base-module size, 0155) stays the exporter's business, not this section's. The Profiler's
measured peak memory from a take or capture is the real number, shown beside the static bound.

### 9. Public API (scripts)

```ts
interface AudioPackage {
  readonly name: string;
  readonly state: "unloaded" | "loading" | "loaded" | "failed";
  readonly progress: number;          // 0..1 while loading
  readonly bytes: number;             // download size for this platform
  readonly memoryBytes: number;       // arena + decoder bytes when loaded
  load(): Promise<void>;              // reference-counted; resolves when loaded, rejects with the reason
  unload(options?: { finish?: boolean }): void;  // last reference: stops its voices with a 50 ms fade
                                                  // (finish: true lets them end first)
}
Audio.package(name: string): AudioPackage   // unknown name: a handle whose load() rejects, one warning
Audio.packages: readonly AudioPackage[]
```

- `AudioHandle.reason` gains `notLoaded`. `Audio.debug()` gains `packages` (state, refs, bytes, memory).
- A new component, **`AudioPackageLoader`** (`packages: string[]`, `unloadOnDestroy = true`): scene preloading waits
  for its packages, so a scene doesn't start before its sound (Wwise's `AkBank`).
- Captures gain a main-side event kind `PKG` (load start, loaded, failed, unload; package name, bytes) and the memory
  section of §6; the capture format's minor version rises (0171).
- All of it is engine-native (0010): no codec, wasm or Web Audio types.

## Alternatives considered

- **Convert at import, ship the converted file as the asset** (Unreal's old model) — the project would hold lossy
  copies, and one file can't serve three platforms; conversion at export from sources with a cache is Wwise's and
  FMOD's model.
- **Settings only per file (Unity)** — hundreds of files can't be retuned at once; profiles and folder rules give
  Wwise's inheritance while per-file overrides keep Unity's precision.
- **Profiles as separate asset files (`*.encoding.json`)** — more files to rename-track for a small, project-wide table;
  `audio.json` is already the Studio's mix document with one history.
- **Overloading the sidecar's image `platforms` object** — image and audio keys would mix and parse rules would need to
  know the file's kind.
- **Decoding Vorbis/Opus per voice inside the core** (Wwise's model on consoles) — a second decoder in the worklet
  wasm, decode cost on the audio thread per voice, and the core's size; ADPCM gives the many-voices case cheaply and the
  ring path already handles the long ones.
- **The browser's `decodeAudioData` or WebCodecs for Opus** — 0157 removed `decodeAudioData` as a decode path, and
  WebCodecs' `AudioDecoder` isn't available in every target webview's worker; one Rust decoder keeps output identical
  across platforms.
- **Every sound in a package, no loose sounds** — a migration for every project; opt-in packages keep old projects
  unchanged.
- **Packages as zip files** — needs a zip reader in the worker and gives nothing the 16-byte-aligned TOC doesn't; a
  custom container also lets entries be transferred as slices without copying.
- **Lazy, on-demand loading instead of strict packages** — that's today's behaviour and gives no memory control; kept
  as `strict: false`.

## Consequences

**Positive**
- Download size and memory become per-platform choices, set once in profiles and tuned per file, as in Wwise and FMOD.
- Designers hear what each platform ships before exporting.
- Scripts and scenes control what is resident; the Profiler shows it.
- Old projects export as before except that WAV/FLAC sources now ship as Vorbis (smaller; `codec: "source"` in the
  Default profile restores the old output).

**Negative / costs**
- A C toolchain (wasi-sdk) for contributors who rebuild the audio wasm, and three C libraries (libvorbis, libogg,
  libopus) with notices in `native/audio/PORTS.md`.
- The decoder grows by libopus and the ADPCM codec (decoder gate likely raised); the core gains the ADPCM reader.
- Converted files keep their source extension, which confuses tools that trust extensions (as 0119 accepted).
- Exports get slower on cold caches (Vorbis encode is roughly 50–100× realtime per core, to be measured in spike S1).
- Strict packages surface "not loaded" mistakes that used to work by on-demand loading; the lint and the editor's Play
  enforcing the rule are the mitigation.
- The Babylon fallback gains a decoder-worker PCM path.

## Deprecates

- The sidecar's `stream` boolean as written by the Studio (still read: `stream: true` = `load: "stream"`).
- 0342's "Format and Sample rate are export settings (0119)" placeholder: they are these encoding settings.

## Open questions

- Opus quality mapping and whether Dialogue should default to Opus once measured (spike S2).
- An HTTP Range reader for streaming from inside packages (Unreal's chunk cache) if loose streamed files prove a problem
  for some hosts.
- Localised packages (one per language) belong to the localisation record (feature 1, W13).

## References

- Wwise: Conversion Settings ShareSets, SoundBank Manager and reports, streaming and prefetch. FMOD Studio: Banks,
  platform encoding settings, `Studio::Bank::loadSampleData`. Unity: AudioClip import settings and platform overrides.
  Unreal: Audio Stream Caching, platform compression overrides.
- `src/export/images.ts`, `buildWriter.ts`, `webBuild.ts`; `src/engine/scene/importSettings.ts`;
  `src/plugins/audio/runtime/clipResolver.ts`, `decoder/`; `native/audio/crates/audio-decode/`, `audio-core/src/stream.rs`,
  `clips.rs`; `native/audio/build.mjs`.
- symphonia 0.6.1 features (`adpcm`; no Opus); libvorbis, libogg, libopus (BSD-3-Clause); rubato (MIT); wasi-sdk.

## Build plan

**Spikes first (A0, one engineer, ≤ 3 days, results in `docs/design/0351-audio-packaging/spikes.md`):** S1 build
`audio-encode` for `wasm32-wasip1` with libvorbis + libogg + rubato and run it in Node `node:wasi` and a browser Worker
with the shim (encode speed per core, wasm size); S2 libopus decoder in `audio-decode` for `wasm32-unknown-unknown`
(added bytes, decode speed, Ogg Opus pre-skip); S3 the core ADPCM reader's cost in the metered gate.

| # | Milestone | Contents | Files (owner) |
|---|---|---|---|
| A1 | Formats | `ImportPlatform` + `android`; `EncodingSettings` types, parse (sidecar block, `audio.json` `encoding`/`packages`/`packaging`), write, resolve, defaults; package dependency closure; `.mycopak` reader/writer; `game.json` `audio` types; unit tests (resolve table, inheritance per key, legacy `stream`, closure, pack round trip) | `src/engine/audio/encoding/**`, `src/engine/audio/packaging/**`, `src/engine/scene/importSettings.ts`, `src/engine/audio/project/format.ts`, `src/export/format.ts` |
| A2 | Encoder | `audio-encode` crate (PCM, IMA ADPCM, Vorbis, resample, downmix), `build.mjs` target and gate, `PORTS.md`, Node and browser `AudioEncoder` adapters with a worker pool; Rust tests (ADPCM round trip, rate conversion, Vorbis decodes through `audio-decode` to the expected frame count) | `native/audio/crates/audio-encode/**`, `native/audio/build.mjs`, `src/export/audioEncoder*.ts` |
| A3 | Export | `processAudio` planner, cache, placement, media table, report, `omit` in the writer, CLI summary/budget warnings and `--no-audio-convert`; tests in `buildWriter.test.ts` with a fake encoder (cache hit, package placement, stream files loose, render as input) | `src/export/audio.ts`, `src/export/buildWriter.ts`, `src/export/main.ts`, `src/export/node.ts`, `src/editor/exportBuild.ts` |
| A4 | Core and decoder | symphonia `adpcm`; CLIP format 6 and the voice ADPCM reader (ABI 4.8) with goldens; decoder `packs.ts` (TOC, per-entry dispatch, in-memory compressed sources, prefetch heads); content-sniffed hints | `native/audio/crates/audio-core/src/clips.rs`, `voices.rs`, new `adpcm.rs`; `audio-wire` schema (wire single writer for the wave); `audio-decode`; `src/plugins/audio/runtime/decoder/**` |
| A5 | Runtime API | media table, packages with refcounts, preload at start, `Audio.package`/`packages`, `notLoaded`, `AudioPackageLoader` and scene preload, strict rule in editor Play, Babylon PCM path, `Audio.debug().packages`, capture `PKG`; tests on the fake backend (refcount, stop on unload, `finish`, strict and lenient) | `src/plugins/audio/runtime/media/**`, `Audio.ts`, `clipResolver.ts`, `babylonBackend.ts`, `capture/**`, `src/player/main.ts`, `src/myco.ts` |
| A6 | Studio | Samples Inspector Encoding section, Hear as, Packages screen with Profiles tab and Report, Profiler memory track; stories with `play` tests | `src/studio/screens/samples/InspectorPanel.tsx` (+ `encodingModel.ts`), `src/studio/components/PlayerBar.tsx`, `src/studio/screens/packages/**`, `src/studio/screens/profiler/**`, `src/studio/screens/index.tsx` |
| A7 | Opus | libopus in `audio-decode` (default and AAC builds) and `audio-encode`; Opus golden seam test; gate notes | `native/audio/crates/audio-decode/**`, `audio-encode/**`, `build.mjs` |
| A8 | Docs and e2e | `docs/wiki/guide/audio-encoding-and-packages.md`; `@slow` export spec: a sample project with two packages exports for web, boots, `Audio.package("Forest").load()` then plays a packaged sound | `docs/wiki/guide/**`, `tests/e2e/export-audio.spec.ts` |

A1 first; A2, A4 and the Studio's readout half of A6 run beside A3; A5 needs A1 and A4; A7 after S2. Shared
single-writer files across 0351 and 0352 in W12: the wire schema and `audio-wasm/src/lib.rs` (ABI: 4.8 here, then
0352's 5.0), `native/audio/build.mjs`, `Audio.ts`, `src/myco.ts`, `game.json`'s format; the coordinator names one task
per wave for each.
