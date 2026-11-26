// Release exports hold none of the debug link's code (ADR 0376 "Security"). The player build's file list (vite.shared.ts
// `playerFileList` with `DEBUG_LINK`, which vite.player.config.ts uses) names as `debug` every chunk only the link
// reaches; the build writer leaves those out of a build without `game.json` `debug` (`src/export/buildWriter.test.ts`).
// Driven as Rollup drives it, through the plugin's `generateBundle` with a made-up bundle shaped like the player's.
import { describe, expect, it } from "vitest";
import type { Rollup } from "vite";
import { DEBUG_LINK, playerFileList } from "../../vite.shared";

const ROOT = "/repo/src";
type Chunk = { fileName: string; isEntry?: boolean; imports?: string[]; dynamicImports?: string[]; moduleIds: string[] };
const bundleOf = (chunks: Chunk[]): Rollup.OutputBundle =>
  Object.fromEntries(chunks.map((c) => [c.fileName, { type: "chunk", isEntry: false, imports: [], dynamicImports: [], ...c } as unknown as Rollup.OutputChunk]));

/** The player's file list plugin over `bundle`: the files.json it emits, or the build error it raises. */
function list(bundle: Rollup.OutputBundle): { files: string[]; debug?: string[] } | { error: string } {
  const plugin = playerFileList({ debug: DEBUG_LINK });
  const hook = plugin.generateBundle as (this: unknown, options: unknown, bundle: Rollup.OutputBundle, isWrite: boolean) => void;
  let emitted: string | null = null;
  try {
    hook.call({ emitFile: (f: { source: string }) => void (emitted = f.source), error: (m: string) => { throw new Error(m); } }, {}, bundle, true);
  } catch (err) {
    return { error: (err as Error).message };
  }
  return JSON.parse(emitted!) as { files: string[]; debug?: string[] };
}

/** A player-shaped bundle: the page entry imports the engine; the link and the animation topic load by import(). */
const player = (extra: Partial<Record<string, Partial<Chunk>>> = {}): Rollup.OutputBundle =>
  bundleOf(
    [
      { fileName: "assets/player-a.js", isEntry: true, imports: ["myco.js"], dynamicImports: ["assets/host-b.js", "assets/audioEffects-c.js"], moduleIds: [`${ROOT}/player/main.ts`] },
      // The engine entry: the topic registry plugins register through stays here, with the animation plugin's register.
      { fileName: "myco.js", isEntry: true, imports: ["assets/shared-d.js"], dynamicImports: ["assets/topic-e.js"], moduleIds: [`${ROOT}/myco.ts`, `${ROOT}/engine/debugLink/topics.ts`, `${ROOT}/plugins/animation/runtime/features/debug/register.ts`] },
      { fileName: "assets/shared-d.js", moduleIds: [`${ROOT}/engine/net/Transport.ts`] },
      { fileName: "assets/audioEffects-c.js", moduleIds: [`${ROOT}/player/audioEffects.ts`] },
      // The link: its host and session, a chunk it shares with the topic, and the engine's transports it reuses.
      { fileName: "assets/host-b.js", imports: ["assets/shared-d.js", "assets/link-f.js"], moduleIds: [`${ROOT}/engine/debugLink/host.ts`, `${ROOT}/engine/debugLink/session.ts`, `${ROOT}/engine/debugLink/config.ts`] },
      { fileName: "assets/link-f.js", moduleIds: [`${ROOT}/engine/debugLink/records.ts`] },
      // The animation topic and what only it uses (the T52 recorder, the frame record).
      { fileName: "assets/topic-e.js", imports: ["assets/link-f.js", "assets/animatorRecorder-g.js"], moduleIds: [`${ROOT}/plugins/animation/runtime/features/debug/debugLink/topic.ts`] },
      { fileName: "assets/animatorRecorder-g.js", moduleIds: [`${ROOT}/plugins/animation/runtime/features/debug/animatorRecorder.ts`, `${ROOT}/plugins/animation/runtime/features/debug/frameRecord.ts`] },
    ].map((c) => ({ ...c, ...extra[c.fileName] })),
  );

describe("the player's debug link files", () => {
  it("names the chunks only the link reaches, and lists every file", () => {
    const out = list(player());
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.files).toHaveLength(8);
    expect(out.debug).toEqual(["assets/animatorRecorder-g.js", "assets/host-b.js", "assets/link-f.js", "assets/topic-e.js"]);
    // What every build ships holds no debug link module but the registry.
    const shipped = out.files.filter((f) => !out.debug!.includes(f));
    expect(shipped).toEqual(["assets/audioEffects-c.js", "assets/player-a.js", "assets/shared-d.js", "myco.js"]);
  });

  it("keeps a chunk the game uses too out of the debug files", () => {
    const out = list(player({ "assets/audioEffects-c.js": { imports: ["assets/animatorRecorder-g.js"] } }));
    expect("debug" in out && out.debug).toEqual(["assets/host-b.js", "assets/link-f.js", "assets/topic-e.js"]);
  });

  it("fails the build when an entry needs the link without import()", () => {
    const out = list(player({ "assets/shared-d.js": { imports: ["assets/host-b.js"] } }));
    expect(out).toEqual({ error: expect.stringContaining("assets/shared-d.js statically imports assets/host-b.js") });
    expect((out as { error: string }).error).toContain("ADR 0376");
    const inEntry = list(player({ "myco.js": { moduleIds: [`${ROOT}/myco.ts`, `${ROOT}/engine/debugLink/session.ts`] } }));
    expect(inEntry).toEqual({ error: expect.stringContaining("the entry myco.js holds debug link modules") });
  });

  it("the rule: the link and plugins' topics, but not the registry; Windows paths too", () => {
    expect(DEBUG_LINK.matches(`${ROOT}/engine/debugLink/host.ts`)).toBe(true);
    expect(DEBUG_LINK.matches(`${ROOT}/engine/debugLink/topics.ts`)).toBe(false);
    expect(DEBUG_LINK.matches(`${ROOT}/plugins/animation/runtime/features/debug/debugLink/topic.ts`)).toBe(true);
    expect(DEBUG_LINK.matches(`${ROOT}/plugins/animation/runtime/features/debug/register.ts`)).toBe(false);
    expect(DEBUG_LINK.matches(`${ROOT}/editor/debugLink/editorLink.ts`)).toBe(false); // the editor's, never in the player
    const out = list(bundleOf([{ fileName: "myco.js", isEntry: true, dynamicImports: ["h.js"], moduleIds: ["C:\\repo\\src\\myco.ts"] }, { fileName: "h.js", moduleIds: ["C:\\repo\\src\\engine\\debugLink\\host.ts"] }]));
    expect("debug" in out && out.debug).toEqual(["h.js"]);
  });

  it("the rule covers ADR 0403's pairing code: subfolders of the link, the webrtc transport, the player's overlay", () => {
    expect(DEBUG_LINK.matches(`${ROOT}/engine/debugLink/pairing/code.ts`)).toBe(true);
    expect(DEBUG_LINK.matches(`${ROOT}/engine/debugLink/rendezvous/client.ts`)).toBe(true);
    expect(DEBUG_LINK.matches(`${ROOT}/engine/debugLink/tauriListener.ts`)).toBe(true);
    expect(DEBUG_LINK.matches(`${ROOT}/engine/debugLink/pairing/topics.ts`)).toBe(true); // only the top-level registry is exempt
    expect(DEBUG_LINK.matches(`${ROOT}/engine/net/transport/webrtc.ts`)).toBe(true);
    expect(DEBUG_LINK.matches(`${ROOT}/engine/net/transport/websocket.ts`)).toBe(false); // game traffic uses it
    expect(DEBUG_LINK.matches(`${ROOT}/player/debugOverlay.ts`)).toBe(true);
    expect(DEBUG_LINK.matches(`${ROOT}/player/main.ts`)).toBe(false);
    const out = list(bundleOf([
      { fileName: "myco.js", isEntry: true, dynamicImports: ["p.js", "o.js"], moduleIds: [`${ROOT}/myco.ts`] },
      { fileName: "p.js", moduleIds: [`${ROOT}/engine/debugLink/pairing/code.ts`, `${ROOT}/engine/net/transport/webrtc.ts`] },
      { fileName: "o.js", moduleIds: [`${ROOT}/player/debugOverlay.ts`] },
    ]));
    expect("debug" in out && out.debug).toEqual(["o.js", "p.js"]);
  });
});
