// The audio op log (ADR 0171 §6.4, ADR 0172 §1.8, R22): subscribes to `editor.project.onSectionChanged("audio", ...)`,
// turns each valid edit, undo or redo into mix ops and, while Play runs, hands them to `mixer.apply`. Outside Play
// nothing reaches the mixer (the play-state guard): the edit is saved and the next Play starts from it. Previews (a fader
// drag in progress) never enter the history, so they never come through here.
//
// The ops of an edit are the ones it recorded (`recordMixOps`, filled by `audioEdit`), else `diffOps(before, after)`.
// Until Ma1 fills `applyOp`, every op answers `restartRequired`; the log keeps the answer.
import { diffOps, type ApplyResult, type MixOp, type MixOpEntry } from "../../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { editor, type SectionChange } from "../../../../editor/sdk";

/** What the log needs of the mixer: the play Engine's `mixer.apply`. */
export interface MixApplier {
  apply(op: MixOp): ApplyResult;
}

/** One handed-over batch. */
export interface OpLogEntry {
  readonly seq: number;
  readonly cause: SectionChange["cause"];
  /** Whether the ops came from the edit's own record or from a diff of the two sections. */
  readonly source: "recorded" | "diff";
  readonly ops: readonly MixOp[];
  /** `apply`'s answer per op (same order). */
  readonly results: readonly ApplyResult[];
  /** Section keys with no live path, from `diffOps` (the diff source only). */
  readonly restartRequired: readonly string[];
}

/** What the log reads from the editor: injectable, so tests need no editor. */
export interface OpLogHost {
  onSectionChanged(key: string, listener: (change: SectionChange) => void): () => void;
  /** True only while Play runs (`playState === "playing"`). */
  isPlaying(): boolean;
  /** The play Engine's mixer, or null when none is up. */
  mixer(): MixApplier | null;
}

export interface OpLog {
  /** The batches handed to the mixer, oldest first (capped at `OP_LOG_LIMIT`). */
  readonly entries: readonly OpLogEntry[];
  /** Stop listening. */
  dispose(): void;
}

export const OP_LOG_LIMIT = 256;

const recorded = new WeakMap<object, { entry: MixOpEntry; base?: object }>();

/**
 * Tag a section value with the ops that made it and the ops that undo it (§6.4). The undo history preserves the
 * value's identity, so the log finds the entry again on undo and redo. Pass `base`, the value the ops were made from:
 * when an invalid draft sat between, the change's other side isn't `base` and the log diffs instead of trusting the ops.
 */
export function recordMixOps(value: object, entry: MixOpEntry, base?: object): void {
  recorded.set(value, { entry, base });
}

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null;

/** The ops a change stands for: edit and redo, the entry on `after`; undo, the inverse on `before`; else a diff. */
export function opsOf(change: Pick<SectionChange, "before" | "after" | "cause">): { ops: MixOp[]; source: "recorded" | "diff"; restartRequired: string[] } {
  const undo = change.cause === "undo";
  const tagged = undo ? change.before : change.after;
  const tag = isObject(tagged) ? recorded.get(tagged) : undefined;
  const other = undo ? change.after : change.before;
  if (tag && change.cause !== "external" && (tag.base === undefined || tag.base === other)) {
    return { ops: [...(undo ? tag.entry.inverse : tag.entry.ops)], source: "recorded", restartRequired: [] };
  }
  const d = diffOps(parseAudioSettings(change.before).settings, parseAudioSettings(change.after).settings);
  return { ops: d.ops, source: "diff", restartRequired: d.restartRequired };
}

/** Start the log over `host`. */
export function createOpLog(host: OpLogHost): OpLog {
  const entries: OpLogEntry[] = [];
  let seq = 0;
  const off = host.onSectionChanged("audio", (change) => {
    if (!host.isPlaying()) return;
    const mixer = host.mixer();
    if (!mixer) return;
    const { ops, source, restartRequired } = opsOf(change);
    if (ops.length === 0) return;
    const results = ops.map((op) => mixer.apply(op));
    entries.push({ seq: ++seq, cause: change.cause, source, ops, results, restartRequired });
    if (entries.length > OP_LOG_LIMIT) entries.splice(0, entries.length - OP_LOG_LIMIT);
  });
  return { entries, dispose: off };
}

/** The log over the real editor SDK; `mixer` answers the play Engine's mixer (wired by the panels' registration). */
export function startOpLog(mixer: () => MixApplier | null): OpLog {
  return createOpLog({
    onSectionChanged: (key, listener) => editor.project.onSectionChanged(key, listener),
    isPlaying: () => editor.scene.peekPlayState() === "playing",
    mixer,
  });
}
