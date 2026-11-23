// The graph editor's live debugging state (ADR 0373 "Live debugger"; T52): which running Animator it shows, its newest
// (or scrubbed) frame, the overlay the canvases draw, the live parameter rows and the recording. Reads the installed
// source (`source.ts`) once per animation frame while the game runs; scrubbing to a past frame shows that frame's graph,
// and, while the game is paused, its re-evaluated pose on the character.
import { useEffect, useMemo, useState } from "preact/hooks";
import type { AnimGraph } from "../../../../engine/animation/animGraph";
import type { AnimatorDebugFrame, DebugParamValue } from "../../runtime/features/debug/frame";
import { editValue, liveParameterRows, type LiveParameterRow } from "./liveParameterLogic";
import { overlayModel, type GraphOverlay } from "./overlayLogic";
import { liveDebugSource, type AnimationDebugSource, type DebugRecording, type DebugTarget } from "./source";
import { debugStatus, pickTarget } from "./targetLogic";

const NO_NOTES: readonly string[] = [];

/** @internal What the graph editor shows of a running Animator. */
export interface LiveDebug {
  readonly source: AnimationDebugSource | null;
  /** The game runs (the debugger bar shows). */
  readonly live: boolean;
  readonly status: string;
  readonly targets: readonly DebugTarget[];
  readonly target: DebugTarget | null;
  /** The target picked in the menu (null: follow the Hierarchy's selection). */
  readonly chosen: string | null;
  choose(id: string | null): void;
  /** The frame shown: the scrubbed one, else the newest. */
  readonly frame: AnimatorDebugFrame | null;
  readonly overlay: GraphOverlay | null;
  readonly rows: readonly LiveParameterRow[];
  readonly recording: DebugRecording | null;
  /** The scrubbed frame's index (null: live). */
  readonly scrub: number | null;
  setScrub(index: number | null): void;
  /** Whether the scrubbed frame's pose shows on the character. */
  readonly poseShown: boolean;
  /** The source can't be written to (a take): parameter edits are off. */
  readonly readOnly: boolean;
  /** What to tell about the shown Animator (T73: the project changed since a take recorded it), one sentence each. */
  readonly notes: readonly string[];
  /** Sends a parameter edit (`Animator.set`); returns why it was refused, or null. */
  set(name: string, input: string | boolean | readonly number[]): string | null;
}

/** @internal Live debugging of `graph` (the asset at `path`) from the installed source. */
export function useLiveDebug(path: string, graph: AnimGraph): LiveDebug {
  const source = liveDebugSource.value;
  const live = source?.live ?? false;
  const [, setTick] = useState(0);
  const [chosen, choose] = useState<string | null>(null);
  const [scrub, setScrubState] = useState<number | null>(null);
  const [poseShown, setPoseShown] = useState(false);

  useEffect(() => {
    if (!live) return;
    let id = 0;
    const loop = () => {
      setTick((t) => (t + 1) & 0xffff);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [live, source]);

  const targets = live && source ? source.targets(path) : [];
  const target = pickTarget(targets, chosen, source?.selected() ?? null);
  const recording = target && source ? source.recording(target.id) : null;
  const newest = target && source ? source.frame(target.id) : null;
  const scrubbed = scrub !== null ? (recording?.frames.find((f) => f.index === scrub) ?? null) : null;
  const frame = scrubbed ?? newest;
  const shownScrub = scrubbed ? scrub : null;

  // A scrubbed frame that dropped out of the ring, or a different target, goes back to live.
  useEffect(() => {
    if (scrub !== null && !scrubbed) setScrubState(null);
  }, [scrub, scrubbed]);
  useEffect(() => () => {
    recording?.show(null);
  }, [target?.id]);

  const overlay = useMemo(() => (target && frame ? overlayModel(graph, target.tables, frame.report) : null), [graph, target?.tables, frame]);
  const rows = useMemo(() => (target ? liveParameterRows(graph, target.tables, frame) : []), [graph, target?.tables, frame]);

  const setScrub = (index: number | null) => {
    setScrubState(index);
    if (!recording || !source) return;
    const shown = index !== null && source.paused ? recording.show(index) : (recording.show(null), false);
    setPoseShown(shown);
    source.redraw();
  };

  return {
    source,
    live,
    status: debugStatus(live, targets, target),
    targets,
    target,
    chosen,
    choose,
    frame,
    overlay,
    rows,
    recording,
    scrub: shownScrub,
    setScrub,
    poseShown: poseShown && shownScrub !== null && recording?.showing === shownScrub,
    readOnly: source?.readOnly ?? false,
    notes: (target && source?.notes?.(target.id)) || NO_NOTES,
    set(name, input) {
      if (!source || !target) return "the game isn't running";
      if (source.readOnly) return "a take can't be edited";
      const row = rows.find((r) => r.name === name);
      if (!row) return `there's no parameter named "${name}"`;
      const r = editValue(row.type, input);
      if ("refused" in r) return r.refused;
      return source.set(target.id, name, r.value as DebugParamValue) ? null : "the Animator is gone";
    },
  };
}
