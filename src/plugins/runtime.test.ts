// The game hosts' plugin step (ADR 0139, 0144): the player and the dedicated server pass
// `activateGamePlugins` to the launch (ADR 0155) as its plugin port, and a plugin that fails to activate
// stops the game with its message, as a broken script does (the launch's own failure handling is tested
// in `src/engine/tests/launch.test.ts`).
import { describe, expect, it } from "vitest";
import type { PluginManifest } from "./manifest";
import { activateGamePlugins } from "./runtime";
import { isRuntimePluginActive, type RuntimePlugin } from "./runtimeContext";

const manifest = (name: string, deps: string[] = []): PluginManifest => ({ name, version: "1.0.0", dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])) });

describe("activateGamePlugins", () => {
  it("stops on a third-party plugin that fails to activate, rolling it back and skipping what needs it", () => {
    let registered = false;
    const broken: RuntimePlugin = {
      manifest: manifest("acme.broken"),
      activate(context) {
        context.registerSystems([{ name: "acme.BrokenSystem", phase: "update", run: () => {} }]);
        registered = true;
        throw new Error("boom");
      },
    };
    const dependent: RuntimePlugin = { manifest: manifest("acme.dependent", ["acme.broken"]), activate: () => {} };
    expect(() => activateGamePlugins([broken, dependent], { disabled: [] })).toThrow("acme.broken failed to activate: boom");
    expect(registered).toBe(true);
    expect(isRuntimePluginActive("acme.broken")).toBe(false);
    expect(isRuntimePluginActive("acme.dependent")).toBe(false);
    expect(isRuntimePluginActive("myco.sky")).toBe(true); // first-party halves are untouched
  });
});
