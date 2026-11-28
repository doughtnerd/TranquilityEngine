// ADR 0432: the committed wasm the native build scripts write name no checkout. Their builds remap the repository root
// to `/myco` and CARGO_HOME to `/cargo` (native/rustflags.mjs), so a module rebuilt in another checkout or worktree is
// the same bytes; one built some other way (a plain `cargo build`, an older script) shows here as a path. native/nav's
// module is left out: navigation is frozen until its upstream merge, and its committed build still embeds paths.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);

/** Each native build script's committed modules, by path from the repository root. */
const MODULES: Record<string, readonly string[]> = {
  "native/anim/build.mjs": ["src/plugins/animation/runtime/wasm/myco_anim_bg.wasm", "src/plugins/animation/runtime/wasm/editor/myco_anim_editor_bg.wasm"],
  "native/tween/build.mjs": ["src/engine/tween/wasm/myco_tween_bg.wasm"],
  "native/audio/build.mjs": [
    "src/plugins/audio/runtime/wasm/myco_audio.wasm",
    "src/plugins/audio/runtime/wasm/myco_audio_decode.wasm",
    "src/plugins/audio/runtime/wasm/myco_audio_decode_aac.wasm",
    "src/engine/audio/sample/wasm/myco_audio_offline.wasm",
    "src/export/wasm/myco_audio_encode.wasm",
    "tools/audio-bench/metered/audio_bench.metered.wasm",
  ],
  "native/input/build.mjs": ["src/engine/input/wasm/myco_input_bg.wasm"],
  "native/fx-sdk/build.mjs": ["native/fx-sdk/wasm/test_fx.wasm", "samples/fx-tremolo/plugins/tremolo/dsp/tremolo.wasm"],
};

/** Absolute paths of a builder's machine: home folders, a Windows drive, Cargo's registry, an agent worktree. */
const CHECKOUT_PATH = /\/home\/[^/\0]+\/|\/Users\/[^/\0]+\/|\/root\/|[A-Za-z]:\\[^\0]{0,40}\\|\.claude[\\/]worktrees|\.cargo[\\/]registry/;

describe("committed native wasm (ADR 0432)", () => {
  for (const [script, modules] of Object.entries(MODULES)) {
    for (const path of modules) {
      it(`${path} (${script}) embeds no checkout's path`, () => {
        const text = readFileSync(new URL(path, root)).toString("latin1");
        expect(CHECKOUT_PATH.exec(text)?.[0] ?? null).toBeNull();
      });
    }
  }
});
