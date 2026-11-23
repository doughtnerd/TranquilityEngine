// ADR 0352 §3: a third-party plugin's `audio` section, through the one plan every host runs (`planPluginCode`): a
// DSP-only plugin needs no runtime or editor entry, its effects are read without running code, a bad effect refuses
// the plugin, the module file must exist, and an effect type is unique across the project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planPluginCode, type PluginFiles } from "./thirdParty";

const TREMOLO = readFileSync(new URL("../../samples/fx-tremolo/plugins/tremolo/plugin.json", import.meta.url), "utf8");
const WASM = "plugins/tremolo/dsp/tremolo.wasm";

async function plan(json: Record<string, string>, assets: string[] | undefined = [WASM], disabled: string[] = []) {
  return planPluginCode({ json: new Map(Object.entries(json)), code: new Map(), ...(assets && { assets }), disabled }, { editor: true });
}
const messages = (p: { problems: { message: string }[] }) => p.problems.flatMap((x) => x.message.split("; "));

describe("plugin.json audio section", () => {
  it("loads the tremolo sample: a DSP-only plugin with no JavaScript", async () => {
    const p = await plan({ "plugins/tremolo/plugin.json": TREMOLO });
    expect(p.problems).toEqual([]);
    expect(p.loaded.map((x) => x.manifest.name)).toEqual(["example.tremolo"]);
    expect(p.runtime).toEqual([]); // nothing to activate
    const audio = p.loaded[0]!.manifest.audio!;
    expect(audio.modules).toEqual([{ id: "dsp", wasm: "dsp/tremolo.wasm", memoryMB: 1 }]);
    expect(audio.effects.map((e) => [e.spec.type, e.spec.plugin.title, e.instructionsPerFrame])).toEqual([["example.tremolo", "Tremolo", 300]]);
  });

  it("refuses the plugin for a bad effect, with every problem", async () => {
    const raw = JSON.parse(TREMOLO) as { audio: { effects: Record<string, unknown>[] } };
    Object.assign(raw.audio.effects[0]!, { type: "acme.tremolo", budget: { instructionsPerFrame: 20000 } });
    const p = await plan({ "plugins/tremolo/plugin.json": JSON.stringify(raw) });
    expect(p.loaded).toEqual([]);
    expect(messages(p)).toEqual([
      `audio.effects[0].type: "acme.tremolo" must start with the plugin's name, example.tremolo`,
      "audio.effects[0].budget.instructionsPerFrame: must be a whole number from 1 to 5000",
    ]);
  });

  it("still needs some entry or an audio section", async () => {
    const p = await plan({ "plugins/x/plugin.json": JSON.stringify({ name: "x", version: "1.0.0", sdk: "^1.0.0" }) });
    expect(messages(p)).toEqual([`a plugin needs a "runtime" or an "editor" entry, or an "audio" or "animationNodes" section`]);
  });

  it("refuses a project plugin whose module file is missing (when the host lists files)", async () => {
    const p = await plan({ "plugins/tremolo/plugin.json": TREMOLO }, []);
    expect(messages(p)).toEqual(["its audio module dsp's file plugins/tremolo/dsp/tremolo.wasm doesn't exist"]);
    expect((await plan({ "plugins/tremolo/plugin.json": TREMOLO }, undefined)).problems).toEqual([]); // not checked
  });

  it("checks an npm plugin's module through the package files", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ dependencies: { "acme-trem": "1.0.0" } }),
      "node_modules/acme-trem/package.json": JSON.stringify({ myco: { plugin: "plugin.json" } }),
      "node_modules/acme-trem/plugin.json": TREMOLO,
    };
    const packages: PluginFiles = { read: async (path) => files[path] ?? null };
    const missing = await planPluginCode({ json: new Map(), code: new Map(), packages }, { editor: true });
    expect(messages(missing)).toEqual(["its audio module dsp's file node_modules/acme-trem/dsp/tremolo.wasm doesn't exist"]);
    files["node_modules/acme-trem/dsp/tremolo.wasm"] = "\0asm";
    const ok = await planPluginCode({ json: new Map(), code: new Map(), packages }, { editor: true });
    expect(ok.problems).toEqual([]);
    expect(ok.loaded[0]!.manifest.audio!.effects[0]!.spec.type).toBe("example.tremolo");
  });

  it("refuses a second plugin declaring an effect type another one declares", async () => {
    const raw = JSON.parse(TREMOLO) as { name: string; audio: { effects: Record<string, unknown>[] } };
    raw.name = "example";
    const p = await plan({ "plugins/tremolo/plugin.json": TREMOLO, "plugins/b/plugin.json": JSON.stringify(raw) }, [WASM, "plugins/b/dsp/tremolo.wasm"]);
    // Discovery order (by path): plugins/b/ is found first and keeps the type.
    expect(p.loaded.map((x) => x.manifest.name)).toEqual(["example"]);
    expect(messages(p)).toEqual(["example.tremolo declares the audio effect type example.tremolo, which example declares too"]);
  });

  it("a disabled plugin is still planned (its effects are known) but not loaded", async () => {
    const p = await plan({ "plugins/tremolo/plugin.json": TREMOLO }, [WASM], ["example.tremolo"]);
    expect(p.plugins.map((x) => x.manifest.name)).toEqual(["example.tremolo"]);
    expect(p.loaded).toEqual([]);
  });
});
