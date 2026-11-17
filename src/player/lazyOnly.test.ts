// The player build's lazy-only check (vite.shared.ts `lazyOnly` with `CAPTURE_CODEC`, which vite.player.config.ts
// uses; ADR 0230): the build fails when an entry's static imports reach the audio capture codec, whatever the chunks
// are called. Driven as Rollup drives it, through the plugin's `generateBundle` with a bundle, here a made-up one
// shaped like the player's.
import { describe, expect, it } from "vitest";
import type { Rollup } from "vite";
import { CAPTURE_CODEC, lazyOnly } from "../../vite.shared";

const ROOT = "/repo/src";
const CAPTURE = `${ROOT}/plugins/audio/runtime/capture`;

type Chunk = { fileName: string; isEntry?: boolean; imports?: string[]; dynamicImports?: string[]; moduleIds: string[] };
const bundleOf = (chunks: Chunk[]): Rollup.OutputBundle =>
  Object.fromEntries(chunks.map((c) => [c.fileName, { type: "chunk", isEntry: false, imports: [], dynamicImports: [], ...c } as unknown as Rollup.OutputChunk]));

/** The player's lazy-only check, run over `bundle`: the build error it raises, or null. */
function check(bundle: Rollup.OutputBundle): string | null {
  const plugin = lazyOnly([CAPTURE_CODEC]);
  const hook = plugin.generateBundle as (this: unknown, options: unknown, bundle: Rollup.OutputBundle, isWrite: boolean) => void;
  try {
    hook.call({ error: (message: string) => { throw new Error(message); } }, {}, bundle, true);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

describe("the player build's lazy-only check", () => {
  const entry = (imports: string[], dynamicImports: string[] = []): Chunk => ({ fileName: "myco.js", isEntry: true, imports, dynamicImports, moduleIds: [`${ROOT}/myco.ts`] });

  it("passes when the codec is reached only by import()", () => {
    const bundle = bundleOf([
      entry(["assets/core.js"], ["assets/rec.js"]),
      { fileName: "assets/core.js", moduleIds: [`${CAPTURE}/capture.ts`, `${CAPTURE}/keyframeLayout.ts`, `${ROOT}/plugins/audio/runtime/mix/keyframeBus.ts`] },
      { fileName: "assets/rec.js", moduleIds: [`${CAPTURE}/recorder.ts`, `${CAPTURE}/format.ts`, `${CAPTURE}/ring.ts`] },
    ]);
    expect(check(bundle)).toBeNull();
  });

  it("fails when an entry reaches it through static imports, however the chunk is named", () => {
    const bundle = bundleOf([
      entry(["assets/a.js"]),
      { fileName: "assets/a.js", imports: ["assets/shared-x1.js"], moduleIds: [`${CAPTURE}/capture.ts`] },
      { fileName: "assets/shared-x1.js", moduleIds: [`${ROOT}/plugins/audio/runtime/mix/keyframeBus.ts`, `${CAPTURE}/format.ts`] },
    ]);
    const error = check(bundle);
    expect(error).toContain(`myco.js statically imports ${CAPTURE}/format.ts (in assets/shared-x1.js)`);
    expect(error).toContain("ADR 0230");
  });

  it("reads Windows paths too", () => {
    const bundle = bundleOf([entry(["assets/a.js"]), { fileName: "assets/a.js", moduleIds: ["C:\\repo\\src\\plugins\\audio\\runtime\\capture\\save.ts"] }]);
    expect(check(bundle)).toContain("capture/save.ts");
  });
});
