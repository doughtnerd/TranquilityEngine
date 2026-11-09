import { describe, expect, it } from "vitest";
import { assetKind } from "./assetBrowser";
import { joinPath, openFolderProject } from "./projects";
import { readRenderTexture, writeRenderTexture } from "./renderTextureAssets";
import { MemoryFileSystem, ROOT, useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

describe("render texture assets (ADR 0109)", () => {
  it("is its own asset kind, ahead of generic json", () => {
    expect(assetKind("rt/Mirror.rendertexture.json")).toBe("rendertexture");
    expect(assetKind("rt/Mirror.RENDERTEXTURE.json")).toBe("rendertexture");
    expect(assetKind("data/other.json")).toBe("json");
  });

  it("writes and reads settings back, and reports a bad file", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, "bad.rendertexture.json"), "{ nope");
    const project = await openFolderProject(fs, ROOT);
    const settings = { width: 256, height: 128, format: "hdr" as const, depth: false, filter: "point" as const, wrap: "repeat" as const };
    await writeRenderTexture(project, "a.rendertexture.json", settings);
    expect(readRenderTexture(project, "a.rendertexture.json")).toEqual({ settings, problems: [] });
    expect(readRenderTexture(project, "bad.rendertexture.json").problems.length).toBeGreaterThan(0);
  });
});
