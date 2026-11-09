// Feature probes before the core loads (ADR 0157 Platforms; architecture §2.1 fallback rule, §7 "Core fails to
// load", §9 matrix). Contract K8: `service.ts` calls `probeCoreSupport()` before it loads anything, and A0.6 fills this
// file without touching `service.ts`. Features are probed, never versions (§9).
import { noteCoreUnavailable } from "../backend";

/** @internal Whether this engine can run the core; when not, `reason` is the one warning the user sees. */
export type ProbeResult = { readonly supported: true } | { readonly supported: false; readonly reason: string };

/**
 * @internal The slice of the global scope the probes read, so tests can stub an old engine. Every member may be
 * missing, which is exactly what an old engine looks like.
 */
export interface ProbeEnv {
  readonly AudioContext?: { readonly prototype?: object };
  readonly AudioWorkletNode?: unknown;
  readonly WebAssembly?: { validate(bytes: Uint8Array): boolean };
  readonly MessageChannel?: unknown;
}

/**
 * @internal The smallest module that uses a `simd128` instruction (`i8x16.popcnt` on a zero v128); the feature
 * is present when `WebAssembly.validate` accepts it. Same bytes as the wasm-feature-detect library.
 */
export const SIMD_PROBE_MODULE: Uint8Array = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/** @internal Names the required features (ADR 0157 Platforms "Minimum versions") the engine lacks; empty when none. */
export function missingFeatures(env: ProbeEnv): readonly string[] {
  const missing: string[] = [];
  if (env.AudioWorkletNode === undefined) missing.push("AudioWorklet");
  if (!hasSimd(env)) missing.push("WebAssembly simd128");
  if (!hasOutputTimestamp(env)) missing.push("AudioContext.getOutputTimestamp");
  if (env.MessageChannel === undefined) missing.push("transferable ArrayBuffers");
  return missing;
}

/** Whether `WebAssembly.validate` accepts the simd128 probe module; a missing or throwing validator means no. */
function hasSimd(env: ProbeEnv): boolean {
  const wasm = env.WebAssembly;
  if (wasm === undefined) return false;
  try {
    return wasm.validate(SIMD_PROBE_MODULE) === true;
  } catch {
    return false;
  }
}

/** Whether the AudioContext prototype has `getOutputTimestamp` (own or inherited); reads no live context. */
function hasOutputTimestamp(env: ProbeEnv): boolean {
  const ctx = env.AudioContext;
  if (ctx === undefined) return false;
  const proto = ctx.prototype;
  if (proto === undefined) return false;
  return "getOutputTimestamp" in proto;
}

/**
 * @internal The one warning (§7 "Core fails to load"): names the missing features and says the minimum versions
 * (docs/guide/audio-minimum-versions.md), and that sound falls back to the "babylon" backend.
 */
export function refusalMessage(missing: readonly string[]): string {
  const list = missing.join(", ");
  return (
    `Audio core unavailable: this engine lacks ${list}. ` +
    "The core needs AudioWorklet (Chrome/Edge 66, Firefox 76, Safari 14.1), " +
    "WebAssembly simd128 (Chrome/Edge/WebView2 91, Firefox 89, Safari 16.4) and " +
    "AudioContext.getOutputTimestamp (Chrome/Edge 57, Firefox 70). " +
    'Using the "babylon" backend: basic playback, no effects. See docs/guide/audio-minimum-versions.md.'
  );
}

/**
 * @internal K8: the call `service.ts` makes. Probes the engine (`env` defaults to the page's global scope). When a
 * feature is missing, it tells the backend selector through `noteCoreUnavailable`, which logs the single warning
 * the first time sound is needed and switches to "babylon", and returns the refusal. Never throws.
 */
export async function probeCoreSupport(env: ProbeEnv = globalThis as unknown as ProbeEnv): Promise<ProbeResult> {
  const missing = missingFeatures(env);
  if (missing.length === 0) return { supported: true };
  const reason = refusalMessage(missing);
  noteCoreUnavailable(reason);
  return { supported: false, reason };
}
