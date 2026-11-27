/**
 * Input context assets (ADR 0336): the data form of bindings. A context (`*.input.json`, or
 * `defineInputContext` in code) maps control paths to actions, with composites, modifiers and
 * triggers. These are its types; `contexts.ts` loads them and `evaluate.ts` runs them.
 */

/** Modifiers change a value, in order. On a mapping, or on the action (after every mapping's). */
export type ModifierSpec =
  /** Values under `min` read 0; the rest rescale to 0..1 up to `max` (default 1). `radial` (default for vectors) uses the length. */
  | { readonly deadzone: { readonly min?: number; readonly max?: number; readonly shape?: "axial" | "radial" } }
  /** Flip components: `{ negate: { y: true } }`; `true` flips all. */
  | { readonly negate: true | { readonly x?: boolean; readonly y?: boolean; readonly z?: boolean } }
  /** Reorder components: `"yx"` (a 1D control into Y), `"zyx"`… */
  | { readonly swizzle: string }
  /** Multiply: one factor, or per component. */
  | { readonly scale: number | { readonly x?: number; readonly y?: number; readonly z?: number } }
  /** Response curve: each component's magnitude to the power `exponent`, sign kept. */
  | { readonly curve: { readonly exponent: number } }
  /** Exponential smoothing toward the input, `rate` per second (higher follows faster). */
  | { readonly smooth: { readonly rate: number } };

/** Explicit (default): any satisfied explicit trigger triggers. Implicit: all must be satisfied. Blocker: blocks while satisfied. */
export type TriggerType = "explicit" | "implicit" | "blocker";

interface TriggerBase {
  readonly type?: TriggerType;
}

/** Triggers decide when an action triggers. With none, an action triggers while actuated ("down"). */
export type TriggerSpec =
  | ({ readonly down: true } & TriggerBase)
  | ({ readonly pressed: true } & TriggerBase)
  | ({ readonly released: true } & TriggerBase)
  /** Triggered once held `min` seconds (every frame after, unless `oneShot`). */
  | ({ readonly hold: { readonly min: number; readonly oneShot?: boolean } } & TriggerBase)
  /** Triggered on release after holding at least `min` seconds. */
  | ({ readonly holdAndRelease: { readonly min: number } } & TriggerBase)
  /** Triggered on release within `max` seconds of the press. */
  | ({ readonly tap: { readonly max: number } } & TriggerBase)
  /** `count` taps, each within `spacing` seconds of the last (`max` per tap, default 0.2). */
  | ({ readonly multiTap: { readonly count: number; readonly spacing: number; readonly max?: number } } & TriggerBase)
  /** While actuated: triggered every `interval` seconds (first at once unless `delay`), up to `limit` times (0: no limit). */
  | ({ readonly pulse: { readonly interval: number; readonly delay?: number; readonly limit?: number } } & TriggerBase)
  /** Satisfied while another action of the same set is triggered. Implicit by default. */
  | ({ readonly chord: { readonly action: string } } & TriggerBase)
  /** Satisfied when other actions performed in order, each within `within` seconds of the one before; Ongoing part-way. */
  | ({ readonly combo: { readonly steps: readonly { readonly action: string; readonly within?: number }[] } } & TriggerBase)
  | CustomTriggerSpec;

/** A trigger registered with `defineTrigger`, named by its namespaced name: `{ "game.doubleHold": { "min": 0.3 } }`. */
export type CustomTriggerSpec = { readonly [name: `${string}.${string}`]: unknown } & TriggerBase;

/** One mapping: controls to an action. */
export interface MappingSpec {
  /** The action's name; `"set.Id:action"` when two sets have an action of that name. */
  readonly action: string;
  /** A control path (`<Gamepad>/leftStick`). For `composite: "modifier"`, the main control. */
  readonly control?: string;
  readonly composite?: "dpad" | "axis" | "modifier";
  /** `dpad` parts. */
  readonly up?: string;
  readonly down?: string;
  readonly left?: string;
  readonly right?: string;
  /** `axis` parts. */
  readonly negative?: string;
  readonly positive?: string;
  /** `modifier`: the control(s) that must be held, as Shift in Shift+B. */
  readonly modifier?: string | readonly string[];
  readonly modifiers?: readonly ModifierSpec[];
  readonly triggers?: readonly TriggerSpec[];
  /** Override the action's consume setting for this mapping. */
  readonly consume?: boolean;
  /**
   * A note for whoever edits the context (ADR 0417): why the mapping is there. Editor-only: the Input dialog shows and
   * writes it, and the evaluator ignores it.
   */
  readonly note?: string;
}

/** A context: a named list of mappings (`*.input.json`). */
export interface InputContextSpec {
  readonly name: string;
  readonly mappings: readonly MappingSpec[];
}
