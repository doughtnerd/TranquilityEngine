// Live mixing in the Studio (ADR 0330 "Live mixing", ADR 0171/0172): while the Studio's runtime runs, every edit of
// `audio.json` (and every undo and redo) reaches the running mixer as `MixOp`s through `Mixer.apply`, and is kept (the
// file is already saved). The ops are the editor's op log's: `diffOps` over the runtime's view of the mix before and
// after (`toRuntimeSettings`), so whatever the runtime can play follows at once and the rest waits for the next start.
// Compare A/B (0172) swaps the mix the session started from in for the edited one without touching the file (the
// editor's `compareModel`), and solo is a monitor control (the editor's `monitorModel`): never saved, it taints meters.
// Pure apart from the injected host.
import { diffOps, type ApplyResult, type MixOp } from "../../../engine/audio/mixOps";
import { toRuntimeSettings } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { AudioSettings } from "../../../engine/audio/settings";
import { createCompareModel, type CompareModel } from "../../../plugins/audio/editor/mix/compareModel";
import { createMonitorModel, type MonitorModel } from "../../../plugins/audio/editor/mix/monitorModel";

/** The ops that move the running mixer from `before` to `after`, and the keys that wait for the next start. */
export function liveOps(before: AudioProject, after: AudioProject): { ops: MixOp[]; restartRequired: string[] } {
  if (before === after) return { ops: [], restartRequired: [] };
  return diffOps(toRuntimeSettings(before), toRuntimeSettings(after));
}

/** What live mixing calls: the running runtime's mixer and loudness hub. */
export interface LiveMixHost {
  /** The Studio runtime is running (an Engine is up; idle or auditioning). */
  running(): boolean;
  apply(op: MixOp): ApplyResult;
  flushNow?(): void;
  setMonitor?(bus: string, controls: { mute?: boolean; solo?: boolean }): void;
  noteMonitorSolo?(): void;
  noteMonitorMute?(bus: string): void;
  setMonitorActive?(on: boolean): void;
  setCompare?(on: boolean): void;
}

/** One edit's live answer. */
export interface LiveEntry {
  readonly ops: readonly MixOp[];
  readonly results: readonly ApplyResult[];
  readonly restartRequired: readonly string[];
  /** Ops the mixer refused or couldn't apply live. */
  readonly failed: number;
}

export interface LiveMix {
  /** The file moved from `before` to `after` (an edit, undo, redo or an outside change): apply it live. Null when nothing reached the mixer. */
  changed(before: AudioProject, after: AudioProject): LiveEntry | null;
  /** The runtime started (or restarted) on `project`: Compare's A becomes this mix; monitor controls reset. */
  started(project: AudioProject): void;
  /** The runtime stopped: Compare ends, monitor controls drop. */
  stopped(): void;
  readonly compare: CompareModel;
  readonly monitor: MonitorModel;
  /** Edits are refused while Compare plays A (they'd be lost on the way back). */
  readonly locked: boolean;
}

export function createLiveMix(host: LiveMixHost, current: () => AudioProject): LiveMix {
  const compare = createCompareModel({
    host: { apply: (op) => host.apply(op), flushNow: () => host.flushNow?.(), setCompare: (on) => host.setCompare?.(on) },
    current: (): AudioSettings => toRuntimeSettings(current()),
  });
  const monitor = createMonitorModel({
    host: {
      setMonitor: (bus, c) => host.setMonitor?.(bus, c),
      noteMonitorSolo: () => host.noteMonitorSolo?.(),
      noteMonitorMute: (bus) => host.noteMonitorMute?.(bus),
      setMonitorActive: (on) => host.setMonitorActive?.(on),
    },
  });
  const syncTree = (p: AudioProject) => monitor.setBuses(p.buses.map((b) => ({ name: b.name, parent: b.parent })), p.buses.filter((b) => b.meter || b.parent === null).map((b) => b.name));
  syncTree(current());
  return {
    changed(before, after) {
      syncTree(after);
      if (!host.running() || compare.active) return null;
      const { ops, restartRequired } = liveOps(before, after);
      if (ops.length === 0 && restartRequired.length === 0) return null;
      const results = ops.map((op) => host.apply(op));
      if (ops.length > 0) host.flushNow?.();
      return { ops, results, restartRequired, failed: results.filter((r) => !r.ok).length };
    },
    started(project) {
      monitor.clearAll();
      syncTree(project);
      compare.begin(toRuntimeSettings(project));
    },
    stopped() {
      compare.end();
      monitor.clearAll();
    },
    compare,
    monitor,
    get locked() { return compare.locked; },
  };
}

/** The Compare toggle's words (ADR 0172): A is the mix the session started from, B the edited one. */
export function compareText(active: boolean, available: boolean): string {
  if (!available) return "Compare needs the Studio's audio running.";
  return active ? "A: the mix this session started with. Your edits are held, not lost; edits are locked until B." : "B: your edited mix, as saved.";
}
