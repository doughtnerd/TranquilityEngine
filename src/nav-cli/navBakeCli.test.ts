import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bakeProject, parseArgs } from "./main";

// `npm run nav:bake` (ADR 0065): bakes a project folder's NavChunks in Node and writes each bake beside its scene.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tinyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-navbake-"));
  dirs.push(dir);
  mkdirSync(join(dir, "scenes"));
  writeFileSync(join(dir, "project.json"), JSON.stringify({ name: "Tiny", navigation: { tileSize: 32 } }));
  writeFileSync(
    join(dir, "scenes", "main.scene.json"),
    JSON.stringify({
      format: "myco.scene@1",
      nodes: [
        { id: "nav", name: "Navigation", components: [{ type: "engine.Transform", data: {} }, { type: "engine.NavChunk", data: { collect: "both" } }] },
        { id: "ground", name: "Ground", components: [{ type: "engine.Transform", data: {} }, { type: "engine.MeshRenderer", data: { mesh: "builtin:plane" } }] },
        { id: "rock", name: "Rock", components: [{ type: "engine.Transform", data: { position: [2, 0.5, 2] } }, { type: "engine.BoxCollider", data: {} }, { type: "engine.NavObstacle", data: { source: "collider" } }] },
      ],
    }),
  );
  writeFileSync(join(dir, "scenes", "menu.scene.json"), JSON.stringify({ format: "myco.scene@1", nodes: [] }));
  return dir;
}

describe("nav:bake", () => {
  it("parses its arguments", () => {
    expect(parseArgs(["proj"])).toEqual({ projectDir: "proj", scenes: [] });
    expect(parseArgs(["proj", ".\\scenes\\a.scene.json"])).toEqual({ projectDir: "proj", scenes: ["scenes/a.scene.json"] });
    expect(parseArgs(["-h"])).toBe("help");
    expect(() => parseArgs([])).toThrow(/project folder/);
    expect(() => parseArgs(["proj", "--fast"])).toThrow(/Unknown option/);
  });

  it("bakes every scene with a NavChunk, writes the .nav.bin beside it and sets the scene's reference", async () => {
    const dir = tinyProject();
    const lines: string[] = [];
    const result = await bakeProject(dir, [], (l) => lines.push(l));
    expect(result.failed).toEqual([]);
    expect(result.baked).toEqual([{ scene: "scenes/main.scene.json", asset: "scenes/main.nav.bin", summary: expect.stringMatching(/\d+ polys/) }]);
    expect(readFileSync(join(dir, "scenes", "main.nav.bin")).subarray(0, 4).length).toBe(4);
    expect(existsSync(join(dir, ".myco", "nav", "scenes", "main.nav.bin.json"))).toBe(true);
    expect(lines.join("\n")).toMatch(/menu\.scene\.json: no NavChunk; skipped/);
    const scene = JSON.parse(readFileSync(join(dir, "scenes", "main.scene.json"), "utf8"));
    expect(scene.nodes[0].components[1].data).toEqual({ collect: "both", bake: "asset:scenes/main.nav.bin" });
    // Named scenes only; an unknown one is an error.
    expect((await bakeProject(dir, ["scenes/menu.scene.json"])).baked).toEqual([]);
    await expect(bakeProject(dir, ["scenes/nope.scene.json"])).rejects.toThrow(/No such scene/);
  });

  it("runs from source in Node", () => {
    const dir = tinyProject();
    const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/scenes\/main\.nav\.bin: \d[\d,]* polys/);
    expect(run.stdout).toMatch(/Baked 1 chunk\./);
    expect(existsSync(join(dir, "scenes", "main.nav.bin"))).toBe(true);
    const usage = spawnSync(process.execPath, [cli], { encoding: "utf8" });
    expect(usage.status).toBe(2);
  }, 60_000);
});
