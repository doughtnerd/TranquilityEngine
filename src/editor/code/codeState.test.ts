import { beforeEach, describe, expect, it } from "vitest";
import { assetKind } from "../assetBrowser";
import { layout, resetLayout } from "../layout/store";
import { activeScript, closeAllScripts, closeScript, dirtyScripts, openScript, openScripts, scriptFor, setDirty } from "./codeState";

beforeEach(() => {
  closeAllScripts();
  resetLayout();
});

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

describe("Code panel tabs", () => {
  it("open once each, bring the Code panel forward, and close to the neighbouring tab", () => {
    openScript("scripts/a.ts");
    openScript("scripts/b.ts");
    openScript("scripts/a.ts");
    expect(openScripts.value).toEqual(["scripts/a.ts", "scripts/b.ts"]);
    expect(activeScript.value).toBe("scripts/a.ts");
    const group = layout.value.docks.flatMap((d) => d.groups).find((g) => g.panels.includes("code"))!;
    expect(group.active).toBe("code");

    setDirty("scripts/a.ts", true);
    closeScript("scripts/a.ts");
    expect(activeScript.value).toBe("scripts/b.ts");
    expect(dirtyScripts.value.has("scripts/a.ts")).toBe(false);
    closeScript("scripts/b.ts");
    expect(activeScript.value).toBeNull();
  });

  it("list scripts in the Assets panel as their own kind", () => {
    expect(assetKind("scripts/Wheel.ts")).toBe("script");
    expect(assetKind("scripts/types.d.ts")).toBe("other");
  });
});
