import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { numberedName, splitExtension } from "./freePath";
import { assetKinds } from "./sdk/contributions";
import { useCoreAssetKinds } from "./testing";

useCoreAssetKinds();

let undo: Array<() => void> = [];
beforeEach(() => {
  undo = [assetKinds.register({ id: "t.tileset", extensions: [".tileset.json"], label: "Tileset", icon: "" })];
});
afterEach(() => undo.forEach((u) => u()));

describe("numberedName", () => {
  it("numbers before the extension", () => {
    expect(numberedName("a.png", 0)).toBe("a.png");
    expect(numberedName("a.png", 1)).toBe("a (1).png");
    expect(numberedName("x.scene.json", 2)).toBe("x (2).scene.json");
  });

  it("keeps any registered kind's compound extension whole", () => {
    expect(numberedName("Grass.tileset.json", 1)).toBe("Grass (1).tileset.json");
    expect(numberedName("Cam.rendertexture.json", 3)).toBe("Cam (3).rendertexture.json");
  });
});

describe("splitExtension", () => {
  it("takes the longest registered extension, else the last one", () => {
    expect(splitExtension("a.b.tileset.json")).toEqual(["a.b", ".tileset.json"]);
    expect(splitExtension("data.level.json")).toEqual(["data.level", ".json"]);
    expect(splitExtension("notes.unknownext")).toEqual(["notes", ".unknownext"]);
    expect(splitExtension("README")).toEqual(["README", ""]);
    expect(splitExtension(".json")).toEqual([".json", ""]);
  });
});
