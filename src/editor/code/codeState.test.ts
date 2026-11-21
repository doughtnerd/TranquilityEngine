import { describe, expect, it } from "vitest";
import { assetKind } from "../assetBrowser";
import { scriptFor } from "./codeState";
import { useCoreAssetKinds } from "../testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

describe("finding the script for a type", () => {
  const scripts = new Map([
    ["scripts/Wheel.ts", `@behavior("game.Wheel")\nexport class Wheel extends GameBehavior {}`],
    ["scripts/data.ts", `export const Wind = defineComponent( 'game.Wind', { strength: f32 });`],
    ["scripts/systems.ts", `defineSystem({ name: "game.Blow", phase: "update", query: [], run() {} });`],
    ["scripts/notes.ts", `// mentions "game.Wheelbarrow" and game.Wheel in passing`],
  ]);

  it("finds behaviors, data components and systems by the id they register", () => {
    expect(scriptFor(scripts, "game.Wheel")).toBe("scripts/Wheel.ts");
    expect(scriptFor(scripts, "game.Wind")).toBe("scripts/data.ts");
    expect(scriptFor(scripts, "game.Blow")).toBe("scripts/systems.ts");
  });

  it("matches whole ids only, and finds nothing for engine types", () => {
    expect(scriptFor(scripts, "game.Wheelbarrow")).toBeNull();
    expect(scriptFor(scripts, "engine.SpriteRenderer")).toBeNull();
  });
});

describe("scripts in the Assets panel", () => {
  it("are their own kind", () => {
    expect(assetKind("scripts/Wheel.ts")).toBe("script");
    expect(assetKind("scripts/types.d.ts")).toBe("other");
  });
});
