// What the live animation debugger shows of one Animator per frame (ADR 0373 "Live debugger"; T52): the graph's debug
// report (active nodes with weights and phases, machines, candidate transitions with blockers, request lifetimes), its
// parameter values, and the inputs the game gave it that frame. Runtime-side data, so a build's debug-link topic (0376,
// T60) can send the same frames the play World's recorder keeps; the editor turns them into its overlay.
import type { DebugReport } from "./report";

/** @internal A parameter value as the debugger shows it (vectors and quaternions as numbers; `node` parameters aren't shown). */
export type DebugParamValue = number | boolean | readonly number[];

/** @internal One input the game gave the Animator in a frame, named by the graph's tables. */
export type DebugInput =
  | { readonly kind: "param"; readonly name: string; readonly value: DebugParamValue | null }
  | { readonly kind: "request"; readonly name: string; readonly lifetime: number }
  | { readonly kind: "travel" | "jump"; readonly machine: string; readonly state: string }
  | { readonly kind: "slotPlay"; readonly slot: string; readonly clip: string }
  | { readonly kind: "slotStop"; readonly slot: string }
  | { readonly kind: "link"; readonly linked: string }
  | { readonly kind: "layerWeight"; readonly layer: string; readonly weight: number }
  | { readonly kind: "ik" }
  | { readonly kind: "other"; readonly what: string };

/** @internal One evaluated frame of an Animator, as the debugger shows it. */
export interface AnimatorDebugFrame {
  /** The frame's number in its recording (increasing; the first frame recorded is 0). */
  readonly index: number;
  /** Seconds since the recording started (the World's unscaled clock). */
  readonly time: number;
  /** The core's debug report after this frame's evaluate. */
  readonly report: DebugReport;
  /** Parameter index → the value the game last set (null: never set, so the graph's default; or a `node` parameter). */
  readonly parameters: readonly (DebugParamValue | null)[];
  /** What the game asked of the Animator this frame, in the order the core applied it. */
  readonly inputs: readonly DebugInput[];
  /** This frame's root-motion delta: translation xyz, rotation xyzw. */
  readonly root: readonly number[];
}
