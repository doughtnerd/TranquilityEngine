/**
 * The offline render of a sample (ADR 0342 "Baked effects are rendered offline", "Flatten"): the audio a flattened
 * sample plays (`sample.source`), from its source PCM and its edits. **The render keeps the source file's timeline**:
 * the same start and length, plus any effect tail appended after the end, so the runtime still applies the trim and
 * loops and every loop and marker keeps its source seconds (the runtime's reading of `sample.source`). It bakes:
 *
 * 1. **The baked chain** (ADR 0345 level "sample"), each enabled effect in order, by the same Rust kernels the buses and
 *    submixes run (`myco_audio_offline.wasm`), with its automation lanes (`fx:<id>:<param>` over source seconds, read
 *    as the engine's curves are) and the tails a delay or reverb leaves (run until they fall below −90 dBFS, at most
 *    `TAIL_CAP_SECONDS` past the end). Fades and noise reduction are offline-only kinds; fades and `envelope` (a voice
 *    effect, rendered as an ADSR whose release ends at the end) shape the whole file. Every type the chain holds
 *    renders, even one the catalogue doesn't list at the sample level (the Studio flags it): baked, it costs nothing.
 *    **Reverse is left out** (with a warning): it would move every source second, and loops, markers and the trim are
 *    in source seconds.
 * 2. **Normalisation** (`normalize.gainDb`, after the effects, as ADR 0342 says); the runtime skips it for a render.
 *
 * Not baked (the runtime applies them, or they wait for core work): trim, razor cuts, deleted snippets, closed gaps.
 *
 * **Plugin effects** (ADR 0352 §7) render through the plugin glue the audio plugin installs as the offline host
 * (`offlinePlugins.ts`), the same calls and the same instrumented modules as live. A plugin effect with no host or
 * module here passes through with a warning, and such a render isn't cached (`renderCache.ts`).
 *
 * Works in the browser and in Node (the wasm loads on first use). It loads a module but reads nothing else: no plugin,
 * no DOM.
 */
import { dbToGain } from "../decibels";
import { effectSpec, isPluginEffectType } from "../effects/catalogue";
import { EFFECT_TYPES, type EffectParamSpec } from "../effects/types";
import { curveKeyHandles, curveKeyInterpCode } from "../../core/curve";
import { renderOffline } from "./offlineWasm";
import { OFFLINE_PLUGIN_BASE, offlineEffectHost, type OfflineEffectHost, type OfflinePluginSession } from "./offlinePlugins";
import type { SampleEdits } from "./types";

/** Interleaved PCM: int16 (scaled by 1/32768) or float. */
export interface SamplePcm {
  readonly pcm: Int16Array | Float32Array;
  readonly channels: number;
  readonly rate: number;
}

export interface RenderedSample {
  /** Interleaved float PCM, `frames × channels`. */
  readonly pcm: Float32Array;
  readonly channels: number;
  readonly rate: number;
  readonly frames: number;
  /** One line per thing the render couldn't do as asked. */
  readonly warnings: readonly string[];
}

/**
 * True when `e` holds something a render bakes: an enabled effect (reverse aside, which a render leaves out) or a
 * normalize gain. Edits without any play their source as it is; nothing needs rendering.
 */
export function hasRenderableEdits(e: Pick<SampleEdits, "effects" | "normalize">): boolean {
  return e.effects.some((f) => f.on && f.type !== "reverse") || (e.normalize.mode !== "off" && e.normalize.gainDb !== 0);
}

/** True when `e` has effects only a render plays: an enabled effect other than reverse (normalize the runtime applies live). */
export function needsRender(e: Pick<SampleEdits, "effects">): boolean {
  return e.effects.some((f) => f.on && f.type !== "reverse");
}

/** The longest tail a render keeps past the sample's end, seconds. */
export const TAIL_CAP_SECONDS = 10;

/** The kernels' parameters per effect (`audio_dsp::fx::PARAMS`, 16 since ABI 5.0: a plugin effect's most). */
const PARAMS = 16;
/** The spec's version (`spec.rs`): 2 since ADR 0352 B5 (16 parameters, plugin effects). */
const SPEC_VERSION = 2;

/**
 * The words a warning carries when a plugin effect passed through for want of its module where the render ran: the
 * render isn't what its cache key names, so `cachedRender` doesn't keep it.
 */
export const PLUGIN_NOT_RENDERED = "its plugin's module isn't loaded where the render ran";

/** The source PCM as float. */
function toFloat(input: SamplePcm): Float32Array {
  if (input.pcm instanceof Float32Array) return input.pcm;
  const out = new Float32Array(input.pcm.length);
  for (let i = 0; i < out.length; i++) out[i] = input.pcm[i] / 32768;
  return out;
}

/** The render spec (`native/audio/crates/audio-offline/src/spec.rs`) for `edits`' chain and lanes. */
function specOf(edits: SampleEdits, warnings: string[], plugins: OfflinePluginSession | null): Float64Array {
  const effects: number[] = [];
  const told = new Set<string>();
  // A plugin effect's parameter slots are its plugin's declared order, from the session (the catalogue may not know it).
  const paramsOf = (type: SampleEdits["effects"][number]["type"]): readonly EffectParamSpec[] => plugins?.paramsOf(type) ?? effectSpec(type).params;
  edits.effects.forEach((f) => {
    const p = new Array<number>(PARAMS).fill(0);
    paramsOf(f.type).slice(0, PARAMS).forEach((q, i) => {
      const v = f.params[q.name];
      p[i] = typeof v === "number" && Number.isFinite(v) ? v : q.default;
    });
    const on = f.on && f.type !== "reverse";
    if (f.on && f.type === "reverse") warnings.push("Reverse isn't baked into a render: loops, markers and the trim are in source seconds, which it would move. It was left out.");
    let type = (EFFECT_TYPES as readonly string[]).indexOf(f.type);
    if (isPluginEffectType(f.type)) {
      // ADR 0352 §7: plugin effect `e` of this render's session; -1 (passed through) when it has none.
      const e = plugins ? plugins.indexOf(f.type) : -1;
      type = e >= 0 ? OFFLINE_PLUGIN_BASE + e : -1;
      if (e < 0 && on && !told.has(f.type)) {
        told.add(f.type);
        warnings.push(`The plugin effect ${f.type} passed through: ${PLUGIN_NOT_RENDERED}.`);
      }
    }
    effects.push(type, on ? 1 : 0, ...p);
  });
  const lanes: number[] = [];
  let laneCount = 0;
  for (const lane of edits.automation) {
    if (lane.bypass) continue;
    const [, id, name] = lane.target.split(":");
    const index = edits.effects.findIndex((f) => f.id === id);
    const effect = edits.effects[index];
    const param = effect ? paramsOf(effect.type).findIndex((q) => q.name === name) : -1;
    if (!effect || param < 0 || param >= PARAMS) {
      warnings.push(`Automation ${lane.target}: no such effect parameter in the chain; not rendered.`);
      continue;
    }
    const q = paramsOf(effect.type)[param]!;
    lanes.push(index, param, q.min, q.max, lane.curve.length);
    for (const k of lane.curve) {
      const h = curveKeyHandles(k);
      lanes.push(k[0], k[1], curveKeyInterpCode(k), h ? h.in[0] : 0, h ? h.in[1] : 0, h ? h.out[0] : 0, h ? h.out[1] : 0);
    }
    laneCount++;
  }
  return new Float64Array([SPEC_VERSION, edits.effects.length, laneCount, 0, TAIL_CAP_SECONDS].concat(effects, lanes));
}

/** The render's warning bits (`render::warn` in the crate) as lines. */
function warningLines(bits: number, edits: SampleEdits): string[] {
  const out: string[] = [];
  // A plugin effect that couldn't run is said by its own line; the bit would only repeat it.
  const unknownBuiltin = edits.effects.some((f) => f.on && !isPluginEffectType(f.type) && !(EFFECT_TYPES as readonly string[]).includes(f.type));
  if (bits & 1 && unknownBuiltin) out.push("An effect type this build doesn't know was left out of the render.");
  if (bits & 2) out.push(`A tail was still sounding ${TAIL_CAP_SECONDS} s after the end and was cut there.`);
  if (bits & 4) out.push("Noise reduction needs at least a few hundredths of a second of audio; the sample is too short, so it was left as it was.");
  if (bits & 8) out.push("A plugin effect passed some of the audio through dry (it faulted, ran past its instruction budget or had no free instance).");
  return out;
}

export interface RenderSampleOptions {
  /** Where plugin effects run (default: the host the audio plugin installed, `offlineEffectHost()`; null: nowhere). */
  readonly plugins?: OfflineEffectHost | null;
}

/** What `edits` make of `input` (see the file header). */
export async function renderSample(input: SamplePcm, edits: SampleEdits, options: RenderSampleOptions = {}): Promise<RenderedSample> {
  const channels = Math.max(1, input.channels);
  const pcm = toFloat(input);
  const warnings: string[] = [];
  const types = [...new Set(edits.effects.filter((f) => f.on && isPluginEffectType(f.type)).map((f) => f.type))];
  const host = options.plugins === undefined ? offlineEffectHost() : options.plugins;
  const session = types.length > 0 && host ? await host.open(types, input.rate) : null;
  if (session) warnings.push(...session.problems);
  const spec = specOf(edits, warnings, session);
  const raw = await renderOffline(pcm, channels, input.rate, spec, session ?? undefined);
  warnings.push(...warningLines(raw.warnings, edits));
  const gain = edits.normalize.mode === "off" ? 1 : dbToGain(edits.normalize.gainDb);
  if (gain !== 1) for (let i = 0; i < raw.pcm.length; i++) raw.pcm[i] *= gain;
  return { pcm: raw.pcm, channels, rate: input.rate, frames: raw.frames, warnings };
}
