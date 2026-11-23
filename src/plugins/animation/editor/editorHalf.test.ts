// The Animation plugin's editor half (ADR 0133, 0373, 0374; T01): it activates through the editor's plugin activation with
// and without its optional dependencies, and deactivates cleanly. Its tools' seams are empty until their tasks.
import { afterEach, describe, expect, it } from "vitest";
import { activatePlugin, deactivatePlugin, isPluginActive } from "../../../editor/sdk/plugins";
import { EDITOR_PLUGINS } from "../../editor";
import { animationEditorPlugin } from ".";

afterEach(() => deactivatePlugin("myco.animation"));

describe("the Animation plugin's editor half", () => {
  it("is a first-party editor half", () => {
    expect(EDITOR_PLUGINS).toContain(animationEditorPlugin);
    expect(animationEditorPlugin.manifest.name).toBe("myco.animation");
  });

  it.each([
    ["physics and audio", ["myco.physics", "myco.audio"]],
    ["physics only", ["myco.physics"]],
    ["audio only", ["myco.audio"]],
    ["neither", []],
  ])("activates with %s, reading its optional dependencies, and deactivates", (_label, on) => {
    const asked: string[] = [];
    activatePlugin(animationEditorPlugin, {
      isActive: (name) => {
        asked.push(name);
        return on.includes(name);
      },
    });
    expect(isPluginActive("myco.animation")).toBe(true);
    expect(asked.sort()).toEqual(["myco.audio", "myco.physics"]);
    deactivatePlugin("myco.animation");
    expect(isPluginActive("myco.animation")).toBe(false);
  });
});
