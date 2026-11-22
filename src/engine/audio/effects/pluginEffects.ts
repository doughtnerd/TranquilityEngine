/**
 * A plugin's `audio` section (ADR 0338 §3, budgets from 0344 §3): the DSP modules it ships and the effects they hold,
 * read from `plugin.json` without running any plugin code, so the editor, the Studio, the exporter and the player
 * agree before anything loads.
 *
 * ```jsonc
 * "audio": {
 *   "abi": 1,
 *   "modules": { "dsp": { "wasm": "dsp/tremolo.wasm", "memoryMB": 1 } },
 *   "effects": [{
 *     "type": "example.tremolo", "module": "dsp", "kind": 0, "label": "Tremolo", "version": "1.0.0",
 *     "levels": ["sample", "instance", "bus"], "cost": "light",
 *     "budget": { "instructionsPerFrame": 300 }, "maxInstances": 32,
 *     "params": [
 *       { "name": "rate", "label": "Rate", "min": 0.1, "max": 20, "step": 0.01, "unit": "Hz", "default": 5, "scale": "log" },
 *       { "name": "shape", "label": "Shape", "choices": ["Sine", "Triangle", "Square"], "default": 0 }
 *     ]
 *   }]
 * }
 * ```
 *
 * Read like the rest of `plugin.json` (ADR 0139, `src/plugins/thirdParty.ts`): optional keys take their defaults,
 * unknown keys are ignored, and every value that is wrong is one problem line. The caller refuses the plugin when there
 * is any (a bad effect refuses its plugin, as other manifest errors do). The limits are declared here, once.
 *
 * Pure; no plugin, no DOM.
 */
import { isFiniteNumber, isRecord } from "../lenientRead";
import { EFFECT_LEVELS, isPluginEffectType } from "./catalogue";
import type { EffectLevel, EffectParamSpec, EffectPluginInfo, PluginAudio, PluginEffectDecl, PluginEffectModule } from "./types";

/** ADR 0338 §3 and 0344 §3: the `audio` section's limits and defaults. */
export const PLUGIN_AUDIO_LIMITS = Object.freeze({
  /** The DSP ABI major `abi` must name. */
  abi: 1,
  /** Parameters an effect may declare (the core's records carry 16 from ABI 5.0). */
  params: 16,
  memoryMB: Object.freeze({ default: 4, max: 64 }),
  /** 0344 §3: the per-effect maximum lowered from 20,000 to 5,000. */
  instructionsPerFrame: Object.freeze({ default: 1000, max: 5000 }),
  maxInstances: Object.freeze({ default: 16, max: 128 }),
  /** `kind`: an index into one module's effects. */
  kind: Object.freeze({ max: 255 }),
  /** Effects per plugin (the core names registered plugin effects 0..255 across the project). */
  effects: 256,
  /** Labels a `choices` parameter may have. */
  choices: 64,
});

/** Module and parameter names. */
const PARAM_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const COSTS = ["light", "medium", "heavy"] as const;

/** The plugin identity `parsePluginAudio` stamps on each effect's spec. */
export interface PluginIdentity {
  readonly name: string;
  readonly title?: string;
  readonly version: string;
}

/** A path inside the plugin: relative, no `..`, no backslashes. */
const insidePlugin = (path: string) => path !== "" && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");

/**
 * Reads `raw` (a `plugin.json`'s `audio` value) for plugin `plugin`. Problems go into `problems` (each starting with
 * where it is, `audio.effects[0].params[1]`); the result holds what could be read and is meant to be used only when
 * there are none. Never throws.
 */
export function parsePluginAudio(raw: unknown, plugin: PluginIdentity, problems: string[]): PluginAudio {
  const out = { abi: PLUGIN_AUDIO_LIMITS.abi, modules: [] as PluginEffectModule[], effects: [] as PluginEffectDecl[] };
  const bad = (where: string, message: string) => problems.push(`${where}: ${message}`);
  if (!isRecord(raw)) {
    bad("audio", "must be an object");
    return out;
  }
  if (raw.abi !== undefined && raw.abi !== PLUGIN_AUDIO_LIMITS.abi) bad("audio.abi", `this engine runs DSP ABI ${PLUGIN_AUDIO_LIMITS.abi} (got ${JSON.stringify(raw.abi)})`);

  const int = (v: unknown, where: string, def: number, min: number, max: number): number => {
    if (v === undefined) return def;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      bad(where, `must be a whole number from ${min} to ${max}`);
      return def;
    }
    return v;
  };

  // modules
  if (!isRecord(raw.modules) || Object.keys(raw.modules).length === 0) bad("audio.modules", 'must name at least one module, such as { "dsp": { "wasm": "dsp/effect.wasm" } }');
  else {
    for (const [id, m] of Object.entries(raw.modules)) {
      const where = `audio.modules.${id}`;
      if (!PARAM_RE.test(id)) bad(where, "a module id is letters, digits and _");
      if (!isRecord(m)) {
        bad(where, "must be an object");
        continue;
      }
      if (typeof m.wasm !== "string" || !insidePlugin(m.wasm) || !m.wasm.endsWith(".wasm")) {
        bad(`${where}.wasm`, "must be the path of a .wasm file inside the plugin");
        continue;
      }
      const memoryMB = int(m.memoryMB, `${where}.memoryMB`, PLUGIN_AUDIO_LIMITS.memoryMB.default, 1, PLUGIN_AUDIO_LIMITS.memoryMB.max);
      out.modules.push(Object.freeze({ id, wasm: m.wasm.replace(/^\.\//, ""), memoryMB }));
    }
  }

  // effects
  if (!Array.isArray(raw.effects) || raw.effects.length === 0) {
    bad("audio.effects", "must list at least one effect");
    return out;
  }
  if (raw.effects.length > PLUGIN_AUDIO_LIMITS.effects) bad("audio.effects", `at most ${PLUGIN_AUDIO_LIMITS.effects} effects`);
  const types = new Set<string>();
  const slots = new Set<string>();
  const info: EffectPluginInfo = Object.freeze({ name: plugin.name, title: plugin.title ?? plugin.name, version: plugin.version, state: "on" });
  raw.effects.slice(0, PLUGIN_AUDIO_LIMITS.effects).forEach((e: unknown, i) => {
    const where = `audio.effects[${i}]`;
    const before = problems.length;
    if (!isRecord(e)) return void bad(where, "must be an object");
    const type = e.type;
    if (!isPluginEffectType(type)) bad(`${where}.type`, `must be namespaced by the plugin, such as "${plugin.name.includes(".") ? plugin.name : `${plugin.name}.effect`}" (lower case letters, digits, ".", "-", "_", with a dot)`);
    else if (type !== plugin.name && !type.startsWith(`${plugin.name}.`)) bad(`${where}.type`, `"${type}" must start with the plugin's name, ${plugin.name}`);
    else if (types.has(type)) bad(`${where}.type`, `"${type}" is declared twice`);
    if (typeof type === "string") types.add(type);
    const module = typeof e.module === "string" ? out.modules.find((m) => m.id === e.module) : undefined;
    if (!module && !(typeof e.module === "string" && isRecord(raw.modules) && e.module in raw.modules)) bad(`${where}.module`, `must name one of the modules (${out.modules.map((m) => m.id).join(", ") || "none"})`);
    const kind = int(e.kind, `${where}.kind`, 0, 0, PLUGIN_AUDIO_LIMITS.kind.max);
    if (typeof e.module === "string" && slots.has(`${e.module}#${kind}`)) bad(`${where}.kind`, `module ${e.module}'s kind ${kind} is already another effect`);
    slots.add(`${e.module}#${kind}`);
    if (typeof e.label !== "string" || e.label.trim() === "") bad(`${where}.label`, "must be a non-empty string");
    if (e.version !== undefined && (typeof e.version !== "string" || e.version.trim() === "")) bad(`${where}.version`, "must be a non-empty string");
    let levels: EffectLevel[] = [];
    if (!Array.isArray(e.levels) || e.levels.length === 0) bad(`${where}.levels`, `must list where it may run: ${EFFECT_LEVELS.join(", ")}`);
    else {
      for (const l of e.levels) {
        if (!(EFFECT_LEVELS as readonly unknown[]).includes(l)) bad(`${where}.levels`, `${JSON.stringify(l)} isn't a level (${EFFECT_LEVELS.join(", ")})`);
        else if (levels.includes(l as EffectLevel)) bad(`${where}.levels`, `"${l}" is listed twice`);
        else levels.push(l as EffectLevel);
      }
      levels = EFFECT_LEVELS.filter((l) => levels.includes(l));
    }
    let cost: (typeof COSTS)[number] = "medium";
    if (e.cost !== undefined) {
      if ((COSTS as readonly unknown[]).includes(e.cost)) cost = e.cost as (typeof COSTS)[number];
      else bad(`${where}.cost`, `must be ${COSTS.join(", ")}`);
    }
    let instructionsPerFrame: number = PLUGIN_AUDIO_LIMITS.instructionsPerFrame.default;
    if (e.budget !== undefined) {
      if (!isRecord(e.budget)) bad(`${where}.budget`, 'must be an object, such as { "instructionsPerFrame": 1000 }');
      else instructionsPerFrame = int(e.budget.instructionsPerFrame, `${where}.budget.instructionsPerFrame`, PLUGIN_AUDIO_LIMITS.instructionsPerFrame.default, 1, PLUGIN_AUDIO_LIMITS.instructionsPerFrame.max);
    }
    const maxInstances = int(e.maxInstances, `${where}.maxInstances`, PLUGIN_AUDIO_LIMITS.maxInstances.default, 1, PLUGIN_AUDIO_LIMITS.maxInstances.max);
    const params = parseParams(e.params, `${where}.params`, bad);
    if (problems.length > before || !isPluginEffectType(type)) return;
    out.effects.push(
      Object.freeze({
        spec: Object.freeze({
          type,
          label: (e.label as string).trim(),
          version: typeof e.version === "string" ? e.version : plugin.version,
          params: Object.freeze(params),
          levels: Object.freeze(levels),
          cost,
          plugin: info,
        }),
        module: e.module as string,
        kind,
        instructionsPerFrame,
        maxInstances,
      }),
    );
  });
  return out;
}

/** An effect's `params`: the catalogue's `EffectParamSpec` plus `choices` and `smooth` (ADR 0338 §3). */
function parseParams(raw: unknown, where: string, bad: (where: string, message: string) => void): EffectParamSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    bad(where, "must be a list");
    return [];
  }
  if (raw.length > PLUGIN_AUDIO_LIMITS.params) bad(where, `at most ${PLUGIN_AUDIO_LIMITS.params} parameters`);
  const out: EffectParamSpec[] = [];
  const names = new Set<string>();
  raw.slice(0, PLUGIN_AUDIO_LIMITS.params).forEach((p: unknown, i) => {
    const at = `${where}[${i}]`;
    if (!isRecord(p)) return void bad(at, "must be an object");
    let ok = true;
    const fail = (key: string, message: string) => {
      bad(`${at}.${key}`, message);
      ok = false;
    };
    if (typeof p.name !== "string" || !PARAM_RE.test(p.name)) fail("name", "must be letters, digits and _, starting with a letter");
    else if (names.has(p.name)) fail("name", `"${p.name}" is declared twice`);
    else names.add(p.name);
    if (typeof p.label !== "string" || p.label.trim() === "") fail("label", "must be a non-empty string");
    if (p.smooth !== undefined && typeof p.smooth !== "boolean") fail("smooth", "must be true or false");
    if (p.unit !== undefined && typeof p.unit !== "string") fail("unit", "must be a string");
    const base = { name: p.name as string, label: typeof p.label === "string" ? p.label.trim() : "" };
    let spec: EffectParamSpec | null = null;
    if (p.choices !== undefined) {
      const c = p.choices;
      if (!Array.isArray(c) || c.length === 0 || c.length > PLUGIN_AUDIO_LIMITS.choices || !c.every((x) => typeof x === "string" && x.trim() !== "")) fail("choices", `must list 1 to ${PLUGIN_AUDIO_LIMITS.choices} labels`);
      else {
        for (const key of ["min", "max", "step", "scale", "bool"] as const) if (p[key] !== undefined) fail(key, "a choices parameter takes no " + key + " (its value is the choice's index)");
        if (p.smooth === true) fail("smooth", "a choice steps; it can't glide");
        const def = p.default ?? 0;
        if (typeof def !== "number" || !Number.isInteger(def) || def < 0 || def >= c.length) fail("default", `must be a choice's index, 0 to ${c.length - 1}`);
        spec = { ...base, min: 0, max: c.length - 1, step: 1, unit: "", default: typeof def === "number" ? def : 0, scale: "linear", choices: Object.freeze(c.map((x) => (x as string).trim())), smooth: false };
      }
    } else if (p.bool === true) {
      if (p.smooth === true) fail("smooth", "a switch steps; it can't glide");
      const def = p.default ?? 0;
      if (def !== 0 && def !== 1 && def !== true && def !== false) fail("default", "must be 0 or 1");
      spec = { ...base, min: 0, max: 1, step: 1, unit: typeof p.unit === "string" ? p.unit : "", default: def === true || def === 1 ? 1 : 0, scale: "linear", bool: true, smooth: false };
    } else {
      if (p.bool !== undefined && p.bool !== false) fail("bool", "must be true or false");
      const min = p.min;
      const max = p.max;
      if (!isFiniteNumber(min)) fail("min", "must be a number");
      if (!isFiniteNumber(max)) fail("max", "must be a number");
      if (isFiniteNumber(min) && isFiniteNumber(max) && !(min < max)) fail("max", `must be above min (${min})`);
      const scale = p.scale ?? "linear";
      if (scale !== "linear" && scale !== "log") fail("scale", 'must be "linear" or "log"');
      else if (scale === "log" && isFiniteNumber(min) && min <= 0) fail("scale", "a log parameter needs a min above 0");
      const range = isFiniteNumber(min) && isFiniteNumber(max) ? max - min : 1;
      const step = p.step ?? range / 100;
      if (!isFiniteNumber(step) || step <= 0) fail("step", "must be a number above 0");
      const def = p.default ?? min;
      if (!isFiniteNumber(def) || (isFiniteNumber(min) && def < min) || (isFiniteNumber(max) && def > max)) fail("default", `must be a number from min to max`);
      if (ok) spec = { ...base, min: min as number, max: max as number, step: step as number, unit: typeof p.unit === "string" ? p.unit : "", default: def as number, scale: scale as "linear" | "log", ...(p.smooth === false ? { smooth: false } : {}) };
    }
    if (ok && spec) out.push(Object.freeze(spec));
  });
  return out;
}
