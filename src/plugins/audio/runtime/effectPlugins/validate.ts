/**
 * Internal (ADR 0352 §6, amended by 0358): the checks a plugin effect module passes before the worklet ever sees it,
 * and its instrumentation. Runs on the main thread, once per module content (the host caches by hash).
 *
 * A module is refused when it:
 * - doesn't decode with the meter pass's decoder, which refuses what it doesn't know: threads and atomics included;
 * - imports anything (no network, files, clock or DOM: a DSP module computes and nothing else);
 * - uses relaxed SIMD (results differ across engines, which breaks take replays and goldens) or a shared memory;
 * - has a start function (code that would run at instantiation, before any budget);
 * - lacks its own exported `memory`, or declares more initial memory than the manifest's `memoryMB`;
 * - lacks a `myco_fx_*` export of the DSP ABI 1.0 or exports one with the wrong signature (`myco_fx_tail_frames` is
 *   optional, but checked when present);
 * - reports an ABI whose major isn't 1, or whose minor is above the engine's (`myco_fx_abi`, called under fuel).
 *
 * A module that passes comes back instrumented in fuel mode (`src/engine/wasm/meter.js`): an i32 `__fuel` global the
 * glue sets before each call, decremented per segment and checked branch-free at function entries and loop headers
 * (0358 §2), with the memory's maximum capped at `memoryMB`.
 */
import { FUEL_EXPORT, meter, readModule, type FuelStats, type WasmFunctionType, type WasmModuleInfo } from "../../../../engine/wasm/meter.js";

/** The DSP ABI this engine runs (0352 §2): `myco_fx_abi()` returns `major << 8 | minor`. */
export const EFFECT_ABI = Object.freeze({ major: 1, minor: 0 });
/** `memoryMB` when the manifest gives none, and its largest value (0352 §2). */
export const DEFAULT_PLUGIN_MEMORY_MB = 4;
export const MAX_PLUGIN_MEMORY_MB = 64;
/** Fuel granted to `myco_fx_abi` while validating (it should return a constant). */
const ABI_CALL_FUEL = 100_000;
const PAGES_PER_MB = 16;

type Sig = readonly [params: string, results: string];
/** The ABI's exports and their signatures (params and results as value-type letters). */
const REQUIRED: Readonly<Record<string, Sig>> = {
  myco_fx_abi: ["", "i32"],
  myco_fx_create: ["i32 f32 i32", "i32"],
  myco_fx_destroy: ["i32 i32", ""],
  myco_fx_reset: ["i32 i32", ""],
  myco_fx_io: ["i32 i32", "i32"],
  myco_fx_process: ["i32 i32 i32 i32", "i32"],
};
const OPTIONAL: Readonly<Record<string, Sig>> = { myco_fx_tail_frames: ["i32 i32", "i32"] };

export interface EffectModuleOptions {
  /** The module's memory budget from its manifest (default 4, at most 64). */
  readonly memoryMB?: number;
}

export type EffectModuleValidation =
  | {
      readonly ok: true;
      /** The ABI the module reports. */
      readonly abi: { readonly major: number; readonly minor: number };
      /** The module instrumented in fuel mode, ready to post to the worklet. */
      readonly bytes: Uint8Array<ArrayBuffer>;
      /** Static counts of the instrumentation. */
      readonly stats: FuelStats;
      /** The memory in 64 KiB pages: initial, and the maximum after the cap. */
      readonly memory: { readonly min: number; readonly max: number };
      /** The module exports `myco_fx_tail_frames`. */
      readonly tailFrames: boolean;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

const sigText = (t: WasmFunctionType): Sig => [t.params.join(" "), t.results.join(" ")];
const showSig = ([p, r]: Sig) => `(${p.split(" ").filter(Boolean).join(", ")}) -> ${r || "nothing"}`;

/** The static checks: everything readable without running the module. */
function staticProblems(info: WasmModuleInfo, memoryMB: number): string[] {
  const problems: string[] = [];
  if (info.imports.length > 0) problems.push(`it imports ${info.imports.map((i) => `${i.module}.${i.name}`).join(", ")}; a plugin effect module may import nothing`);
  if (info.relaxedSimd) problems.push("it uses relaxed SIMD, whose results differ between engines; build without +relaxed-simd");
  if (info.start) problems.push("it has a start function, which would run code at load; plugin effect modules may have none");
  const memory = info.memories[0];
  if (info.memories.some((m) => m.shared)) problems.push("it declares a shared memory (threads); plugin effect modules are single-threaded");
  else if (info.memories.some((m) => m.memory64)) problems.push("it declares a 64-bit memory; plugin effect modules use a 32-bit one");
  else if (!memory || memory.imported) problems.push("it has no memory of its own");
  else if (memory.min > memoryMB * PAGES_PER_MB) problems.push(`its initial memory (${memory.min * 64} KiB) is above its budget of ${memoryMB} MB; link with a smaller stack (-zstack-size=65536)`);
  if (info.memories.length > 1) problems.push("it declares more than one memory");
  if (!info.exports.some((e) => e.name === "memory" && e.kind === "memory" && e.index === 0)) problems.push(`it doesn't export its memory as "memory"`);
  const check = (name: string, want: Sig, required: boolean) => {
    const e = info.exports.find((x) => x.name === name);
    if (!e) {
      if (required) problems.push(`it doesn't export ${name}`);
      return;
    }
    const fn = e.kind === "function" ? info.functions[e.index] : undefined;
    if (!fn) return void problems.push(`its export ${name} isn't a function`);
    const got = sigText(fn);
    if (got[0] !== want[0] || got[1] !== want[1]) problems.push(`its ${name} is ${showSig(got)}; the ABI's is ${showSig(want)}`);
  };
  for (const [name, sig] of Object.entries(REQUIRED)) check(name, sig, true);
  for (const [name, sig] of Object.entries(OPTIONAL)) check(name, sig, false);
  return problems;
}

/**
 * Validates and instruments a plugin effect module (`bytes`, as fetched). Never throws: a refusal lists every problem
 * found, in the order a reader would fix them.
 */
export async function validateEffectModule(bytes: Uint8Array, options: EffectModuleOptions = {}): Promise<EffectModuleValidation> {
  const memoryMB = options.memoryMB ?? DEFAULT_PLUGIN_MEMORY_MB;
  if (!Number.isInteger(memoryMB) || memoryMB < 1 || memoryMB > MAX_PLUGIN_MEMORY_MB) {
    return { ok: false, problems: [`memoryMB must be a whole number from 1 to ${MAX_PLUGIN_MEMORY_MB} (got ${memoryMB})`] };
  }
  let info: WasmModuleInfo;
  try {
    info = readModule(bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unsupported opcode 0xfe/.test(message)) return { ok: false, problems: ["it uses threads or atomics (the 0xFE instructions); plugin effect modules are single-threaded"] };
    return { ok: false, problems: [`it isn't a module this engine can check: ${message.replace(/^meter: /, "")}`] };
  }
  const problems = staticProblems(info, memoryMB);
  if (problems.length > 0) return { ok: false, problems };

  let instrumented: { bytes: Uint8Array<ArrayBuffer>; stats: FuelStats };
  try {
    instrumented = meter(bytes, { mode: "fuel", maxPages: memoryMB * PAGES_PER_MB });
  } catch (err) {
    return { ok: false, problems: [`it can't be instrumented: ${(err instanceof Error ? err.message : String(err)).replace(/^meter: /, "")}`] };
  }
  let abi: number;
  try {
    const { instance } = await WebAssembly.instantiate(instrumented.bytes, {});
    (instance.exports[FUEL_EXPORT] as WebAssembly.Global).value = ABI_CALL_FUEL;
    abi = (instance.exports.myco_fx_abi as () => number)() >>> 0;
  } catch (err) {
    return { ok: false, problems: [`myco_fx_abi failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const major = abi >>> 8;
  const minor = abi & 0xff;
  if (abi > 0xffff || major !== EFFECT_ABI.major) return { ok: false, problems: [`it was built for DSP ABI ${major}.${minor} (myco_fx_abi returned 0x${abi.toString(16)}); this engine runs ${EFFECT_ABI.major}.x`] };
  if (minor > EFFECT_ABI.minor) return { ok: false, problems: [`it needs DSP ABI ${major}.${minor}; this engine runs ${EFFECT_ABI.major}.${EFFECT_ABI.minor}: update Myco`] };
  const memory = info.memories[0]!;
  return {
    ok: true,
    abi: { major, minor },
    bytes: instrumented.bytes,
    stats: instrumented.stats,
    memory: { min: memory.min, max: Math.min(memory.max ?? Infinity, memoryMB * PAGES_PER_MB) },
    tailFrames: info.exports.some((e) => e.name === "myco_fx_tail_frames"),
  };
}
