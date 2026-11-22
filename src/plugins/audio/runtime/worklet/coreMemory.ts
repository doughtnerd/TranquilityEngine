// The core's init record and the Memory it asks for (ADR 0327, 0328; architecture §5.1). The shell writes the INIT
// record (the wire's kind 13, generated from `audio-wire`'s schema) at the start of the core's inbox; `myco_audio_init`,
// `myco_audio_memory_pages` and `myco_audio_memory_part_bytes` read it there. The core alone knows its layout, so the
// Memory's `maximum` and the debug panel's memory row are its answers, asked of a throwaway instance on a Memory of
// `MEMORY_INITIAL_PAGES` pages that never grows: no region size is mirrored here. (`zoneKernelBlobBytes` sizes a wire blob
// main builds, from the schema's generated constants.)
import type { CoreExports, CorePreset } from "./coreDriver";
import {
  ClipFormat,
  CORE_ABI_MAJOR,
  ErrorCode,
  INIT_FIXED_END,
  Kind,
  MemoryPart,
  QUANTUM_FRAMES,
  SCHEMA_HASH,
  writeEnvelope,
  writeInit,
  ZONE_HEAD_BINS,
  ZONE_KERNEL_HEADER_BYTES,
  ZONE_KERNEL_MAX_HEAD_PARTS,
  ZONE_TAIL_BINS,
  type Init,
} from "../wire.generated";

/** @internal Pages the shell's Memory starts with: the same every time (`native/audio/build.mjs` uses 64), which is what makes init deterministic (A0.1). */
export const MEMORY_INITIAL_PAGES = 64;

/** @internal Why the core couldn't start (the host falls back, architecture §2.1). */
export class CoreLoadError extends Error {
  override readonly name = "CoreLoadError";
}

/** What `instantiateCore` checks the module against; tests pass other values to see the refusals. */
export interface CoreExpectations {
  readonly schemaHash: string;
  readonly abiMajor: number;
}

/** @internal The schema hash and ABI major this build speaks. */
export const EXPECTED: CoreExpectations = { schemaHash: SCHEMA_HASH, abiMajor: CORE_ABI_MAJOR };

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * @internal Instantiates `module` over `memory` and checks its ABI major, then its schema hash (both static, so before
 * anything reads the inbox: a core of another ABI reads another INIT, or none). Throws `CoreLoadError`.
 */
export function openCore(module: WebAssembly.Module, memory: WebAssembly.Memory, expected: CoreExpectations = EXPECTED): CoreExports {
  let exports: CoreExports;
  try {
    exports = new WebAssembly.Instance(module, { env: { memory } }).exports as unknown as CoreExports;
  } catch (error) {
    throw new CoreLoadError(`audio core: instantiating myco_audio.wasm failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const abi = exports.myco_audio_abi_version();
  if (abi >> 8 !== expected.abiMajor) throw new CoreLoadError(`audio core: ABI ${abi >> 8}.${abi & 0xff} where ${expected.abiMajor}.x was expected`);
  const schema = hex(new Uint8Array(memory.buffer, exports.myco_audio_schema_hash(), 16));
  if (schema !== expected.schemaHash) throw new CoreLoadError(`audio core: wire schema ${schema} where ${expected.schemaHash} was expected`);
  return exports;
}

/** @internal The INIT record for a preset at the context's rate: the preset's counts, and its longest zone IR in frames at the rate (0 without zone slots). */
export function initRecord(preset: CorePreset, sampleRate: number): Init {
  return {
    sampleRate,
    maxLogical: preset.maxLogical,
    maxMixed: preset.maxMixed,
    maxBuses: preset.maxBuses,
    arenaInitialBytes: preset.arenaInitialBytes,
    maxBeds: preset.maxBeds,
    maxZoneSlots: preset.maxZoneSlots,
    zoneMaxFrames: preset.maxZoneSlots > 0 ? Math.ceil(preset.zoneMaxSeconds * sampleRate) : 0,
    maxWide: preset.maxWide,
    maxMusicRings: preset.maxMusicRings,
  };
}

/** @internal Writes the INIT message (envelope and record) at the start of the core's inbox, for the exports that read it. */
export function writeInitRecord(exports: CoreExports, memory: WebAssembly.Memory, record: Init): void {
  const view = new DataView(memory.buffer, exports.myco_audio_inbox_ptr(), INIT_FIXED_END);
  writeEnvelope(view, 0, { kind: Kind.INIT, seq: 0, bodyBytes: INIT_FIXED_END - 16 });
  writeInit(view, 0, record);
}

const ERROR_NAMES = new Map<number, string>(Object.entries(ErrorCode).map(([name, code]) => [code, name]));

/**
 * @internal Why a call that read the INIT record refused it, in words: an `INIT_*` code names the field (ADR 0328:
 * `INIT_MAX_MIXED` is `maxMixed`), with the value the record held; any other code by its wire name.
 */
export function initRefusal(code: number, record: Init): string {
  const name = ERROR_NAMES.get(code) ?? "unknown error";
  if (!name.startsWith("INIT_")) return `${name} (code ${code})`;
  const field = name.slice(5).toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof Init;
  return `${field} ${record[field]} (${name}, code ${code})`;
}

/** @internal What the core takes for an INIT record, bytes (ADR 0327): `MemoryPart`'s parts. */
export interface CoreMemoryParts {
  /** The block `myco_audio_init` takes: every fixed region and the arena's initial reserve, whole pages. */
  readonly layout: number;
  /** The `Beds` region: bed slots and the wide streams' private decoders. */
  readonly beds: number;
  /** The `Zones` region. */
  readonly zones: number;
  /** The `Wide` region: 16-channel stream rings. */
  readonly wide: number;
  /** The zone kernel budget in the arena, outside `clipMemoryMB`. */
  readonly zoneKernels: number;
  /** The HRIR table, its HRTF bank and the MagLS filters in the arena, outside `clipMemoryMB`. */
  readonly spatialData: number;
}

/** @internal The core's answer for a preset at a rate: the Memory's `maximum` in pages, and what its parts take. */
export interface CoreMemory {
  readonly maximumPages: number;
  readonly parts: CoreMemoryParts;
}

/** wasm32's limit: 4 GiB. */
const MAX_PAGES = 65_536;

/**
 * @internal Asks a throwaway instance of the core what it needs for `preset` at `sampleRate` (ADR 0327): the Memory's
 * `maximum` (`MEMORY_INITIAL_PAGES` plus `myco_audio_memory_pages` for the clip ceiling) and each `MemoryPart`. The
 * instance's Memory never grows. Throws `CoreLoadError` on a module of another ABI or schema, or when the core refuses
 * the record (naming the field).
 */
export function askCoreMemory(module: WebAssembly.Module, preset: CorePreset, sampleRate: number, expected: CoreExpectations = EXPECTED): CoreMemory {
  const memory = new WebAssembly.Memory({ initial: MEMORY_INITIAL_PAGES, maximum: MEMORY_INITIAL_PAGES });
  const exports = openCore(module, memory, expected);
  const record = initRecord(preset, sampleRate);
  writeInitRecord(exports, memory, record);
  const answer = (n: number): number => {
    if (n < 0) throw new CoreLoadError(`audio core: the INIT record was refused: ${initRefusal(n, record)}`);
    return n;
  };
  const pages = answer(exports.myco_audio_memory_pages(Math.max(0, Math.min(0xffff_ffff, Math.floor(preset.clipCeilingBytes)))));
  const part = (p: number): number => answer(exports.myco_audio_memory_part_bytes(p));
  return {
    maximumPages: Math.min(MAX_PAGES, MEMORY_INITIAL_PAGES + pages),
    parts: {
      layout: part(MemoryPart.Layout),
      beds: part(MemoryPart.Beds),
      zones: part(MemoryPart.Zones),
      wide: part(MemoryPart.Wide),
      zoneKernels: part(MemoryPart.ZoneKernels),
      spatialData: part(MemoryPart.SpatialData),
    },
  };
}

/** @internal Bytes per sample of a CLIP_BEGIN format (0 for a format the shell doesn't know): ADR 0162 C6 adds 3-5, all f32. */
export function clipSampleBytes(format: number): number {
  switch (format) {
    case ClipFormat.F32:
    case ClipFormat.ZoneKernel:
    case ClipFormat.MagLS:
    case ClipFormat.ZoneIrPcm:
      return 4;
    case ClipFormat.I16:
    case ClipFormat.HRIR:
      return 2;
    default:
      return 0;
  }
}

/**
 * @internal Bytes of a format 3 zone kernel blob for an IR of `frames` (`zones::kernel_blob_bytes`): the wire's blob layout
 * (`ZoneKernelHeader`, then the head and tail partitions' packed spectra, ADR 0162 §4.5), from the generated constants.
 * What main prepares and sends; what the core reserves for it is its own answer (`MemoryPart.ZoneKernels`).
 */
export function zoneKernelBlobBytes(frames: number): number {
  const head = Math.min(Math.ceil(frames / QUANTUM_FRAMES), ZONE_KERNEL_MAX_HEAD_PARTS);
  const tail = Math.ceil(Math.max(0, frames - ZONE_KERNEL_MAX_HEAD_PARTS * QUANTUM_FRAMES) / ZONE_TAIL_BINS);
  return ZONE_KERNEL_HEADER_BYTES + 2 * head * ZONE_HEAD_BINS * 8 + 2 * tail * ZONE_TAIL_BINS * 8;
}
