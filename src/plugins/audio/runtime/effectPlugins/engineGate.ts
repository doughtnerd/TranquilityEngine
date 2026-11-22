/**
 * Internal (ADR 0344 §6, the conservative reading): plugin effect modules run only where the B0 spike measured them,
 * V8 (Chromium-based browsers and webviews, Node), until the spike runs on JavaScriptCore and SpiderMonkey. Elsewhere
 * the `effectPlugins` capability stays off: their effects pass through (data kept) with one warning. A project turns
 * the gate off with `project.json` `plugins.audioEffectEngines: "all"`.
 *
 * **How the engine is told** (`scriptEngineOf`), first match wins:
 * 1. `process.versions.v8` is a string: Node, Electron, Deno's Node layer (V8). `process.versions.bun`: Bun (JSC).
 * 2. `navigator.userAgentData.brands` names "Chromium" (Chrome, Edge, Opera, Brave, WebView2 and Android WebView send
 *    it; only Chromium implements User-Agent Client Hints).
 * 3. The user agent string: any iOS / iPadOS browser (`iPhone`, `iPad`, `iPod`, `CriOS`, `FxiOS`, `EdgiOS`) is WebKit
 *    (JSC) whatever its name, by App Store rule; `Firefox/` (or `Gecko/` without "like Gecko") is SpiderMonkey;
 *    `Chrome/`, `Chromium/`, `HeadlessChrome/` or `Edg/` is V8; `AppleWebKit/` otherwise (Safari, WKWebView in the macOS
 *    Tauri shell, WebKitGTK on Linux) is JSC.
 * 4. Anything else is "unknown", treated like an unmeasured engine (off).
 *
 * An iPad that asks for the desktop site sends a Mac Safari string, which reads (correctly) as JSC.
 */

export type ScriptEngine = "v8" | "jsc" | "spidermonkey" | "unknown";

/** What the detection reads (`globalThis` by default). */
export interface EngineProbe {
  readonly process?: { readonly versions?: Readonly<Record<string, string | undefined>> };
  readonly navigator?: { readonly userAgent?: string; readonly userAgentData?: { readonly brands?: readonly { readonly brand: string }[] } };
}

/** The script engine this code runs on (see the file header). */
export function scriptEngineOf(probe: EngineProbe = globalThis as EngineProbe): ScriptEngine {
  const versions = probe.process?.versions;
  if (versions && typeof versions.bun === "string") return "jsc";
  if (versions && typeof versions.v8 === "string") return "v8";
  const nav = probe.navigator;
  if (nav?.userAgentData?.brands?.some((b) => b.brand === "Chromium")) return "v8";
  const ua = nav?.userAgent ?? "";
  if (/\b(iPhone|iPad|iPod)\b|\b(CriOS|FxiOS|EdgiOS)\//.test(ua)) return "jsc";
  if (/\bFirefox\//.test(ua) || (/\bGecko\//.test(ua) && !/like Gecko/.test(ua))) return "spidermonkey";
  if (/\b(Chrome|Chromium|HeadlessChrome|Edg)\//.test(ua)) return "v8";
  if (/\bAppleWebKit\//.test(ua)) return "jsc";
  return "unknown";
}

/** `project.json` `plugins.audioEffectEngines`: "chromium" (default) runs plugin modules on V8 only; "all" everywhere. */
export type EffectPluginEngines = "chromium" | "all";

/** The gate's answer: whether plugin modules run here, and the one warning when they don't. */
export type EngineGate = { readonly open: true } | { readonly open: false; readonly warning: string };

const ENGINE_NAME: Readonly<Record<Exclude<ScriptEngine, "v8">, string>> = {
  jsc: "JavaScriptCore (Safari, iOS, the macOS and Linux webviews)",
  spidermonkey: "SpiderMonkey (Firefox)",
  unknown: "an engine Myco can't identify",
};

/** The decision (ADR 0344 §6): open on V8, or anywhere with `engines` "all"; closed elsewhere, with why and how to override. */
export function effectPluginGate(engine: ScriptEngine, engines: EffectPluginEngines = "chromium"): EngineGate {
  if (engine === "v8" || engines === "all") return { open: true };
  return {
    open: false,
    warning:
      `audio: plugin effects are off on ${ENGINE_NAME[engine]}: their sandbox has only been measured on Chromium's engine so far ` +
      `(ADR 0344 §6), so they pass audio through here. Set "audioEffectEngines": "all" in project.json's plugins section to run them anyway.`,
  };
}

/** The project's choice from `project.json`'s `plugins` section: "all" only when it says so exactly. */
export function effectPluginEnginesOf(plugins: { readonly audioEffectEngines?: unknown } | undefined): EffectPluginEngines {
  return plugins?.audioEffectEngines === "all" ? "all" : "chromium";
}
