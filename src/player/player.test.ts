// The player's plugins (ADR 0139, 0144): `main.ts` makes them active with one apply of a plugin set
// (`activateGamePlugins`), and a plugin that fails to activate stops the game with its message, as a
// broken script does. `main.ts` itself only runs in a browser, so this checks the step it calls and that
// it calls it inside `boot()` (whose rejection shows "The game couldn't start").
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PluginManifest } from "../plugins/manifest";
import { activateGamePlugins } from "../plugins/runtime";
import { isRuntimePluginActive, type RuntimePlugin } from "../plugins/runtimeContext";

const manifest = (name: string, deps: string[] = []): PluginManifest => ({ name, version: "1.0.0", dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])) });

describe("the player's plugins", () => {
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

  it("main.ts activates through activateGamePlugins inside boot(), before the Engine is created", () => {
    const src = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const boot = src.slice(src.indexOf("async function boot()"));
    const call = boot.indexOf("activateGamePlugins(thirdParty, { disabled: settings.plugins?.disabled });");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(boot.indexOf("Engine.create("));
    expect(src).not.toMatch(/activateRuntimePlugins|\.apply\(/); // no second path that could ignore problems
  });
});
