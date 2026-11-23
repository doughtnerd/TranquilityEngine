// ADR 0358 §6 (the conservative reading): plugin effect modules run on V8 only unless the project says "all". The
// engine detection over real user agent strings and runtimes, the gate's decision table, the project setting's read,
// and `loadEffectPlugin` on a closed gate: one warning, the effects known but no module registered.
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectSpec, unregisterPluginEffects } from "../../../../engine/audio/effects/catalogue";
import { parsePluginAudio } from "../../../../engine/audio/effects/pluginEffects";
import { offlineEffectHost } from "../../../../engine/audio/sample/offlinePlugins";
import { makeFakeBackend } from "../testing";
import { effectPluginEnginesOf, effectPluginGate, scriptEngineOf, type ScriptEngine } from "./engineGate";
import { loadEffectPlugin, unloadEffectPlugin } from "./load";

const ua = (userAgent: string, brands?: string[]) => ({ navigator: { userAgent, ...(brands && { userAgentData: { brands: brands.map((brand) => ({ brand })) } }) } });

describe("which script engine runs here", () => {
  it.each<[string, Parameters<typeof scriptEngineOf>[0], ScriptEngine]>([
    ["Node", { process: { versions: { node: "22.0.0", v8: "12.4" } } }, "v8"],
    ["Bun", { process: { versions: { bun: "1.1", node: "22.0.0" } } }, "jsc"],
    ["Chrome (client hints)", ua("Mozilla/5.0 (X11; Linux x86_64)", ["Chromium", "Google Chrome"]), "v8"],
    ["Chrome", ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"), "v8"],
    ["Edge / WebView2", ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"), "v8"],
    ["Headless Chrome", ua("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36"), "v8"],
    ["Android WebView", ua("Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36"), "v8"],
    ["Safari", ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"), "jsc"],
    ["macOS Tauri (WKWebView)", ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko)"), "jsc"],
    ["Linux Tauri (WebKitGTK)", ua("Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"), "jsc"],
    ["Chrome on iOS (WebKit)", ua("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1"), "jsc"],
    ["iPad Safari", ua("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"), "jsc"],
    ["Firefox", ua("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"), "spidermonkey"],
    ["Firefox on iOS (WebKit)", ua("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15"), "jsc"],
    ["nothing to go on", {}, "unknown"],
  ])("%s", (_, probe, engine) => {
    expect(scriptEngineOf(probe)).toBe(engine);
  });

  it("this test runner is Node (V8)", () => {
    expect(scriptEngineOf()).toBe("v8");
  });
});

describe("the gate's decision", () => {
  it.each<[ScriptEngine, "chromium" | "all" | undefined, boolean]>([
    ["v8", undefined, true],
    ["v8", "chromium", true],
    ["v8", "all", true],
    ["jsc", undefined, false],
    ["jsc", "all", true],
    ["spidermonkey", "chromium", false],
    ["spidermonkey", "all", true],
    ["unknown", undefined, false],
    ["unknown", "all", true],
  ])("%s with %s: open %s", (engine, engines, open) => {
    const gate = effectPluginGate(engine, engines);
    expect(gate.open).toBe(open);
    if (!gate.open) expect(gate.warning).toContain('"audioEffectEngines": "all"');
  });

  it("says which engine and how to override", () => {
    const gate = effectPluginGate("spidermonkey");
    expect(gate).toEqual({ open: false, warning: expect.stringContaining("SpiderMonkey (Firefox)") });
  });

  it("reads project.json's plugins.audioEffectEngines: \"all\" only when it says so", () => {
    expect(effectPluginEnginesOf(undefined)).toBe("chromium");
    expect(effectPluginEnginesOf({})).toBe("chromium");
    expect(effectPluginEnginesOf({ audioEffectEngines: "all" })).toBe("all");
    expect(effectPluginEnginesOf({ audioEffectEngines: "ALL" })).toBe("chromium");
  });
});

describe("loading a plugin on a closed gate", () => {
  afterEach(() => {
    unloadEffectPlugin("acme.fx", null);
    unregisterPluginEffects("acme.fx");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("warns once, keeps the effects known and registers no module, live or offline; the override opens it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Firefox, as far as the detection can tell: no V8 in `process.versions`, a Firefox user agent.
    vi.stubGlobal("process", { versions: {} });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0" });
    const audio = parsePluginAudio({ modules: { dsp: { wasm: "fx.wasm" } }, effects: [{ type: "acme.fx", module: "dsp", kind: 0, label: "Fx", levels: ["bus"], params: [] }] }, { name: "acme.fx", version: "1.0.0" }, []);
    const read = vi.fn(async () => null);
    const backend = makeFakeBackend();
    const pkg = { plugin: "acme.fx", version: "1.0.0", enabled: true, audio, read };
    const report = await loadEffectPlugin(pkg, backend);
    await loadEffectPlugin(pkg, backend);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("plugin effects are off on SpiderMonkey (Firefox)");
    expect(warn.mock.calls.filter(([m]) => String(m).includes("plugin effects are off"))).toHaveLength(1);
    expect(effectSpec("acme.fx").plugin?.state).toBe("on");
    expect(read).not.toHaveBeenCalled();
    expect(backend.effectPlugins!.registrations).toEqual([]);
    expect(offlineEffectHost()?.identity("acme.fx") ?? null).toBeNull();
    // `plugins.audioEffectEngines: "all"`: the module is read (and, here, found missing).
    await loadEffectPlugin({ ...pkg, engines: "all" }, backend);
    expect(read).toHaveBeenCalledWith("fx.wasm");
  });
});
