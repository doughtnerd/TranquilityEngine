/**
 * ADR 0348: records a plugin adds to a take. A take is the capture framing, whose record types below 0x80 that a reader
 * doesn't know are passed over by length (capture §5.3), so a plugin can write its own records into a take without the
 * audio reader knowing their layout. The range 0x40..0x7e is the plugins' (audio keeps 0x10..0x3f for requests, 0x10..0x20 in use since ADR 0386; 0x7f is
 * the INDEX): the animation plugin writes 0x40..0x44 (`plugins/animation/runtime/features/debug/frameRecord.ts`).
 *
 * A plugin registers a take source (`context.take.source(name, load)`); a take that starts loads each source, hands it a
 * host and stops it with the take. The source writes whole record payloads through the host; the take recorder frames
 * them (head, seq, epoch) as it frames its own records and keeps them in file order with them. On read, the audio take
 * reader collects the records of a take in this range (`openTakeFile`), and the plugin decodes its own.
 *
 * Pure registry: no plugin, no DOM. Like the debug link's topic registry, it holds loaders (`import()` functions), so a
 * game that never records a take loads none of a source's code.
 */
import type { Engine } from "../../core/Engine";

/** The first and last record type a plugin may write into a take. */
export const TAKE_EXTENSION_FIRST = 0x40;
export const TAKE_EXTENSION_LAST = 0x7e;
/** True for a type in the plugins' range. */
export function isTakeExtensionType(type: number): boolean {
  return type >= TAKE_EXTENSION_FIRST && type <= TAKE_EXTENSION_LAST;
}

/** One plugin record of a take file, as read: its type, sequence number and payload (a copy). */
export interface TakeExtensionRecord {
  readonly type: number;
  readonly seq: number;
  readonly payload: Uint8Array;
}

/** What a source gets while a take records. */
export interface TakeSourceHost {
  /** The Engine whose Worlds are recorded. */
  readonly engine: Engine;
  /** Seconds since the take began (its wall clock). */
  readonly seconds: number;
  /**
   * Appends a record of `type` (in the plugins' range) with `payload`. False when it isn't kept: the take stopped, the
   * type is out of range or the payload is past a record's cap.
   */
  write(type: number, payload: Uint8Array): boolean;
}

/** A source's running recording. */
export interface TakeSourceRun {
  /** The take ended (stopped, or the Engine went): stop recording; records written after this are dropped. */
  stop(): void;
}

/** A plugin's contribution to takes. */
export interface TakeSource {
  start(host: TakeSourceHost): TakeSourceRun;
}

/** Loads a source's code (an `import()`). */
export type TakeSourceLoader = () => Promise<TakeSource>;

const loaders = new Map<string, TakeSourceLoader>();

/** @internal Registers take source `name` (the runtime context's `take.source`); returns the undo. A later registration of the name wins. */
export function registerTakeSource(name: string, load: TakeSourceLoader): () => void {
  loaders.set(name, load);
  return () => {
    if (loaders.get(name) === load) loaders.delete(name);
  };
}

/** @internal The registered take sources by name. */
export function takeSources(): ReadonlyMap<string, TakeSourceLoader> {
  return loaders;
}
