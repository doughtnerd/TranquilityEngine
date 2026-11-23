// ADR 0371 (T19): a game build compiles every clip the project references to `*.anim.bin` beside its source, and the
// model skeletons they bind to `*.skel.bin`, listed in the manifest, through the Node exporter (`exportProject`). The
// project is a temporary folder holding the skinned glTF fixture (`engine/tests/fixtures/gltf/skinnedGltf.ts`), a scene
// that names one of its clips, and an authored clip without bone tracks.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAnimationHeader, type ClipInfo } from "../engine/animation/binaryHeader";
import { skinnedGltf } from "../engine/tests/fixtures/gltf/skinnedGltf";
import type { GameManifest } from "./format";
import { exportProject } from "./node";

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "myco-export-anim-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for dist/player/. */
function fakePlayer(): string {
  const dir = temp();
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "files.json"), JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] }));
  writeFileSync(join(dir, "assets", "player-x.js"), "// player");
  writeFileSync(join(dir, "myco.js"), "export {};");
  writeFileSync(join(dir, "player.html"), "<!DOCTYPE html><title>player</title>");
  return dir;
}

function project(extra: Record<string, string> = {}): string {
  const dir = temp();
  const files: Record<string, string> = {
    "project.json": JSON.stringify({ name: "Rig" }),
    "models/rig.gltf": skinnedGltf(),
    "scenes/main.scene.json": JSON.stringify({ nodes: [{ name: "Rig", components: [{ type: "engine.Animator", data: { defaultClip: "asset:models/rig.gltf#Anim/Wave" } }, { type: "engine.Skeleton", data: { skeleton: "asset:models/rig.gltf#Skeleton" } }] }, { name: "Lamp", components: [{ type: "engine.Animator", data: { defaultClip: "asset:clips/glow.anim.json" } }] }] }),
    "clips/glow.anim.json": JSON.stringify({ format: "myco.anim-source@1", duration: 1, tracks: [{ kind: "float", target: { nodePath: "", component: "engine.Light", field: "intensity" }, curves: [[[0, 0], [1, 2]]] }] }),
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const clipInfo = (bytes: Uint8Array): ClipInfo => {
  const h = readAnimationHeader(bytes, "myco.anim@1");
  if (!h.ok) throw new Error(h.problem);
  return h.header.info as ClipInfo;
};

describe("exports compile referenced clips (ADR 0371, T19)", () => {
  it("writes a scene's model clip, its skeleton and an authored clip beside their sources, compressed, and lists them", async () => {
    const out = join(temp(), "web");
    const lines: string[] = [];
    const result = await exportProject({ projectDir: project(), out, playerDir: fakePlayer(), log: (l) => lines.push(l) });
    const manifest = JSON.parse(readFileSync(join(out, "game.json"), "utf8")) as GameManifest;
    for (const file of ["models/rig.gltf.anim/Wave.anim.bin", "models/rig.gltf.anim/Skeleton.skel.bin", "clips/glow.anim.bin"]) {
      expect(manifest.files, file).toContain(file);
      expect(existsSync(join(out, "project", file)), file).toBe(true);
    }
    expect(result.plan.manifest).toEqual(manifest);
    const wave = clipInfo(new Uint8Array(readFileSync(join(out, "project/models/rig.gltf.anim/Wave.anim.bin"))));
    expect(wave).toMatchObject({ compressed: true, raw: false, bones: 6 });
    expect(clipInfo(new Uint8Array(readFileSync(join(out, "project/clips/glow.anim.bin"))))).toMatchObject({ compressed: true, bones: 0 });
    const skel = readAnimationHeader(new Uint8Array(readFileSync(join(out, "project/models/rig.gltf.anim/Skeleton.skel.bin"))), "myco.skel@1");
    expect(skel.ok && skel.header.info).toMatchObject({ kind: "skeleton", bones: 6 });
    // Only referenced clips: the model's other clips aren't compiled.
    expect(existsSync(join(out, "project/models/rig.gltf.anim/Walk.anim.bin"))).toBe(false);
    expect(lines.some((l) => /^models\/rig\.gltf#Anim\/Wave: .* max error [\d.]+ mm → models\/rig\.gltf\.anim\/Wave\.anim\.bin$/.test(l))).toBe(true);
    expect(lines.filter((l) => /couldn't|can't/.test(l))).toEqual([]);
  });

  it("compiles with the project's settings for the build's platform", async () => {
    const rateOf = async (settings: object) => {
      const out = join(temp(), "web");
      await exportProject({ projectDir: project({ "project.json": JSON.stringify({ name: "Rig", animation: { compression: settings } }) }), out, playerDir: fakePlayer() });
      return clipInfo(new Uint8Array(readFileSync(join(out, "project/models/rig.gltf.anim/Wave.anim.bin")))).rate;
    };
    expect(await rateOf({})).toBe(30);
    expect(await rateOf({ maxRate: 20 })).toBe(20);
    // The web build takes the web override (exportProject's default target).
    expect(await rateOf({ maxRate: 20, platforms: { web: { maxRate: 10 }, android: { maxRate: 5 } } })).toBe(10);
  });

  it("compiles nothing for a project that disables the Animation plugin", async () => {
    const out = join(temp(), "web");
    await exportProject({ projectDir: project({ "project.json": JSON.stringify({ name: "Rig", plugins: { disabled: ["myco.animation"] } }) }), out, playerDir: fakePlayer() });
    expect(existsSync(join(out, "project/clips/glow.anim.bin"))).toBe(false);
  });
});
