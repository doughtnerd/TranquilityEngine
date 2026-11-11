/**
 * `musicSwitch` containers (ADR 0166 api-and-models §1.2 `setParameter`, §2.3 `musicSwitch`; architecture §2.1
 * "Pending").
 *
 * Owner: **R2** (W6). Q2 wrote the skeleton.
 *
 * The switch parameter's value picks a child; the latest `setParameter` before the quantised exit wins (two changes
 * inside one bar land once); setting it back to the playing child cancels the change; `continue to play` keeps the
 * position across children where the rule says so. The change itself is a transition (R1's rule, R3a's execution).
 */
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";

/** One switch container's state. R2 may add fields here. */
export interface SwitchState {
  readonly node: MusicNodeRef;
  /** The parameter's name. */
  readonly parameter: string;
  /** The value last read (number or label). */
  value: number | string | undefined;
  /** Id of the playing child; null before the first start. */
  playing: string | null;
  /** Id of the child a pending change goes to, or null. */
  target: string | null;
}

/** R2: the state for a `musicSwitch` node, or null when `node` isn't one. */
export function createSwitchState(node: MusicNodeRef): SwitchState | null {
  void node;
  return null; // STUB(R2)
}

/** R2: the child id the parameter value picks (the default child for an unknown value), or null. */
export function childFor(state: SwitchState, value: number | string | undefined): string | null {
  void state;
  void value;
  return null; // STUB(R2)
}

/** R2, step 9: read the parameter; a new target requests (or replaces, or cancels) the transition. */
export function tickSwitch(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(R2)
}
