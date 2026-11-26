/**
 * The tween backend (ADR 0420): one interface over a tween table, whichever module holds it. The animation plugin
 * provides one over its core's table when it's active (`TWEEN_BACKEND_PROVIDER`); without it, the standalone tween
 * module (`native/tween`, committed in `./wasm/`) is loaded the first time one is opened (`./standalone.ts`). Both run
 * `myco-tween` through the same wire records (`./wasm/wire/*.ts`: the `tween` family and the `timeline` family's
 * sequence records), so results are identical either way (`native/tween/tests/parity.rs`).
 *
 * A backend is one host's tweens and sequences (a World id in its module): created, controlled and advanced through it,
 * its outputs read after each `update` until the next `update` of any backend on the page (each module clears its
 * outputs at the start of an update, as the animation core does at each World's evaluate).
 *
 * Internal: not public API. UI animation (0418 wave 4) is its first user.
 */
import type { Curve } from "../core/curve";
import { encodeRecord, type RecordFields, type RecordValues } from "../wasm/wireRecords";
import type { SEQ_CREATE, SEQ_MEMBER, TIMELINE_BLOCK, TIMELINE_CHANGE, TIMELINE_INFO } from "./wasm/wire/sequence";
import { SEQ_CREATE as SEQ_CREATE_LAYOUT, SEQ_MEMBER as SEQ_MEMBER_LAYOUT } from "./wasm/wire/sequence";
import type { TWEEN_CHANGE, TWEEN_CREATE } from "./wasm/wire/tween";

/** @internal A tween to create: `TWEEN_CREATE`'s fields but `world`, which is the backend's. */
export type TweenSpec = Omit<RecordValues<typeof TWEEN_CREATE>, "world">;
/** @internal A sequence's head: `SEQ_CREATE`'s fields but `world` (the backend's) and `members` (counted). */
export type SequenceHead = Omit<RecordValues<typeof SEQ_CREATE>, "world" | "members">;
/** @internal A sequence member: `SEQ_MEMBER`'s fields (its `offset` places it in the sequence). */
export type SequenceMember = RecordValues<typeof SEQ_MEMBER>;
/** @internal A tween state change (`TWEEN_CHANGE`). */
export type TweenChange = RecordFields<typeof TWEEN_CHANGE>;
/** @internal A sequence state change (`TIMELINE_CHANGE`: `CHANGE_MEMBER_DONE`, `CHANGE_FINISHED`…). */
export type SequenceChange = RecordFields<typeof TIMELINE_CHANGE>;
/** @internal Where a sequence's outputs are (`TIMELINE_INFO`). */
export type SequenceInfo = RecordFields<typeof TIMELINE_INFO>;
/** @internal One member's value block (`TIMELINE_BLOCK`). */
export type SequenceBlock = RecordFields<typeof TIMELINE_BLOCK>;

/** @internal This update's tween rows: row `i` is column `columns[i]` and the four floats at `values[4i]`. */
export interface TweenRows {
  readonly count: number;
  readonly columns: Uint32Array;
  readonly values: Float32Array;
}

/** @internal The sequences' value words (as f32 and u32, from the value region's start) and block weights. */
export interface SequenceOutputs {
  readonly f32: Float32Array;
  readonly u32: Uint32Array;
  readonly weights: Float32Array;
}

/** @internal A tween table and its sequences, in whichever module holds them. */
export interface TweenBackend {
  /** Which module: the animation plugin's core, or the standalone tween module. */
  readonly kind: "core" | "standalone";
  /** Why the last call that returns a handle returned 0 (`STATUS_*` of `./wasm/wire/core`). */
  lastStatus(): number;

  /** Loads an engine curve (over 0–1) for curve easing: its handle (a tween's or member's `ease`), or 0. */
  loadCurve(curve: Curve): number;
  /** Frees a curve; tweens still easing through it ease linearly. False for a handle that isn't a live curve. */
  releaseCurve(handle: number): boolean;

  /** Creates a tween; its handle, or 0 (`lastStatus`). It starts at the next `update`. */
  create(spec: TweenSpec): number;
  /** Pauses, resumes, kills or marks destroyed a tween (`OP_*` of `./wasm/wire/tween`); a status. */
  control(handle: number, op: number): number;
  /** Creates a sequence of `members`; its handle, or 0 (`lastStatus`). */
  createSequence(head: SequenceHead, members: readonly SequenceMember[]): number;
  /** Plays, pauses, stops, seeks, sets the speed of, kills or marks destroyed a sequence (`OP_*` of `./wasm/wire/sequence`); a status. */
  controlSequence(handle: number, op: number, value?: number): number;
  /** Where a live sequence's outputs are, or null. */
  sequenceInfo(handle: number): SequenceInfo | null;
  /** A live sequence's member blocks (empty for a stale handle). */
  sequenceBlocks(handle: number): SequenceBlock[];

  /**
   * Advances this backend's tweens, then its sequences, in `pass` (`PASS_*` of `./wasm/wire/core`), after clearing the
   * module's outputs.
   */
  update(pass: number, dtScaled: number, dtUnscaled: number): void;
  /** The tween rows written by the last update (views valid until the next call into the module). */
  rows(): TweenRows;
  /** The tween change records written by the last update. */
  changeCount(): number;
  /** Tween change record `i` (into `out` when given). */
  change(i: number, out?: TweenChange): TweenChange;
  /** The sequences evaluated by the last update (a copy). */
  activeSequences(): Uint32Array;
  /** The sequences' outputs (views valid until the next call into the module). */
  sequenceOutputs(): SequenceOutputs;
  /** The sequence change records written by the last update. */
  sequenceChangeCount(): number;
  /** Sequence change record `i` (into `out` when given). */
  sequenceChange(i: number, out?: SequenceChange): SequenceChange;

  /** Kills what it still holds, frees its curves and closes it; later calls do nothing and create nothing. */
  dispose(): void;
}

/** @internal `SEQ_CREATE` for `world` followed by its `SEQ_MEMBER` records, as both modules take them. */
export function encodeSequence(world: number, head: SequenceHead, members: readonly SequenceMember[]): Uint8Array {
  const out = new Uint8Array(SEQ_CREATE_LAYOUT.stride + members.length * SEQ_MEMBER_LAYOUT.stride);
  out.set(encodeRecord(SEQ_CREATE_LAYOUT, { ...head, world, members: members.length }), 0);
  members.forEach((m, i) => out.set(encodeRecord(SEQ_MEMBER_LAYOUT, m), SEQ_CREATE_LAYOUT.stride + i * SEQ_MEMBER_LAYOUT.stride));
  return out;
}

/** @internal Opens a backend; null when it can't run here (no `simd128`). */
export type TweenBackendProvider = () => Promise<TweenBackend | null>;

/** Installed providers, latest last: the latest is used. */
const providers: TweenBackendProvider[] = [];

/**
 * @internal Where the animation plugin's runtime half installs its provider (its core's table) when it activates, through
 * its context's `contribute`; deactivating it removes the provider again (a contribution point, ADR 0133).
 */
export const TWEEN_BACKEND_PROVIDER = {
  id: "myco.engine.tweenBackend",
  register(next: TweenBackendProvider): () => void {
    providers.push(next);
    return () => {
      const at = providers.lastIndexOf(next);
      if (at >= 0) providers.splice(at, 1);
    };
  },
};

/**
 * @internal Opens a tween backend for one host: the installed provider's (the animation core, when its plugin is active),
 * else the standalone tween module, loaded on the first call. Resolves null when neither can run here (no `simd128`).
 */
export async function openTweenBackend(): Promise<TweenBackend | null> {
  const provider = providers.at(-1);
  if (provider) return provider();
  const { openStandaloneTweenBackend } = await import("./standalone");
  return openStandaloneTweenBackend();
}
