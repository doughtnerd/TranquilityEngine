// The dedicated server's project reader and the samples manifest with import settings sidecars
// beside assets (ADR 0040): sidecars are JSON assets like any other.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../engine";
import { sampleManifest } from "../../vite.shared";
import { readProject } from "./project";

const temps: string[] = [];
afterEach(() => {
  Assets.clearSources();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("import settings sidecars outside the editor", () => {
  it("the server's project reader serves sidecars, and the engine reads them through it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-sidecars-"));
    temps.push(dir);
    mkdirSync(join(dir, "images"));
    writeFileSync(join(dir, "project.json"), "{}");
    writeFileSync(join(dir, "images", "hero.png"), new Uint8Array([137, 80, 78, 71]));
    writeFileSync(join(dir, "images", "hero.png.meta.json"), JSON.stringify({ format: "myco.import@1", pixelsPerUnit: 16, sprites: [{ name: "idle", rect: [0, 0, 16, 16] }] }));
    const project = await readProject(dir);
    expect(project.assets.has("images/hero.png")).toBe(true);
    expect(project.assets.get("images/hero.png.meta.json")).toMatchObject({ format: "myco.import@1" });
    Assets.addSource(project.assets);
    expect(Assets.importSettings("images/hero.png#idle")).toMatchObject({ pixelsPerUnit: 16, sprites: [{ name: "idle", rect: [0, 0, 16, 16], pivot: [0.5, 0.5] }] });
  });

  it("the samples manifest lists sidecars as files", () => {
    for (const sample of sampleManifest().samples) {
      for (const f of sample.files.filter((x) => x.path.endsWith(".meta.json"))) expect(f.size).toBeGreaterThan(0);
    }
    expect(sampleManifest().samples.length).toBeGreaterThan(0);
  });
});
