/**
 * `musicSwitch` containers (ADR 0166 api-and-models §1.2 `setParameter`, §2.3 `musicSwitch`; architecture §2.1
 * "Pending").
 *
 * Owner: **R2** (W6). Q2 wrote the skeleton.
 *
 * The switch parameter's value picks a child; the latest `setParameter` before the quantised exit wins (two changes
 * inside one bar land once); setting it back to the playing child cancels the change; `continue to play` keeps the
 * position across children where the rule says so. The change itself is a transition (R1's rule, R3a's execution).
 *
 * R2's readings: children are matched on `String(value)` (a numeric parameter picks the child whose `value` is that
 * number's text); a value with no child keeps the playing child (and so cancels a pending change), while the default
 * child (the `default` label, else the first child) is for the first start only (`childFor`). The playing child is
 * read from the playing run's segment, so a nested segment counts as its direct child of the switch.
 */
import { isMusicContainer, type MusicNode, type MusicSwitchNode } from "../../../../engine/audio/musicFormat";
import type { MusicFrame, MusicNodeRef, MusicPlayer } from "./musicSystem";
import { cancelTransition, requestTransition, type Transition } from "./transition";

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

const asSwitch = (node: MusicNodeRef): MusicSwitchNode | null =>
  node.type === "musicSwitch" ? (node as MusicSwitchNode) : null;

/** R2: the state for a `musicSwitch` node, or null when `node` isn't one. */
export function createSwitchState(node: MusicNodeRef): SwitchState | null {
  const sw = asSwitch(node);
  if (!sw) return null;
  return { node, parameter: sw.parameter, value: undefined, playing: null, target: null };
}

/** The direct child whose `value` is `value`'s text, or null. The first child with a value wins (as the format says). */
function exactChild(sw: MusicSwitchNode, value: number | string | undefined): string | null {
  if (value === undefined) return null;
  const text = String(value);
  for (const c of sw.children) if (c.value === text) return c.id;
  return null;
}

/** R2: the child id the parameter value picks (the default child for an unknown value), or null. */
export function childFor(state: SwitchState, value: number | string | undefined): string | null {
  const sw = asSwitch(state.node);
  if (!sw || sw.children.length === 0) return null;
  const exact = exactChild(sw, value);
  if (exact !== null) return exact;
  if (sw.default !== undefined) {
    const d = exactChild(sw, sw.default);
    if (d !== null) return d;
  }
  return sw.children[0]!.id;
}

/** Each node id below a switch to the id of the direct child holding it (itself for a direct child). */
const holders = new WeakMap<object, Map<string, string>>();

function holderOf(sw: MusicSwitchNode, id: string): string | null {
  let map = holders.get(sw);
  if (!map) {
    const built = new Map<string, string>();
    const walk = (node: MusicNode, top: string): void => {
      if (!built.has(node.id)) built.set(node.id, top);
      if (isMusicContainer(node)) for (const c of node.children) walk(c, top);
    };
    for (const c of sw.children) walk(c, c.id);
    holders.set(sw, built);
    map = built;
  }
  return map.get(id) ?? null;
}

/**
 * R2, step 9: read the parameter; a new target requests (or replaces, or cancels) the transition. Returns the
 * transition requested this tick (null: none asked, or R3a refused), so a test can watch it. The latest value wins
 * (R3a replaces an unstarted transition), and a value that picks the playing child again cancels the pending one.
 */
export function tickSwitch(player: MusicPlayer, f: MusicFrame): Transition | null {
  const state = player.musicSwitch;
  const sw = state ? asSwitch(state.node) : null;
  if (!state || !sw) return null;
  if (player.state === "stopping" || player.state === "stopped" || player.state === "refused") return null;

  const value = player.instance.getParameter(state.parameter);
  state.value = value;
  // The first child is started by P1 (from `childFor`); until a run plays there is nothing to change from.
  const playing = player.run ? holderOf(sw, player.run.node.id) : null;
  if (playing === null) return null;
  state.playing = playing;
  if (state.target === playing) state.target = null; // the change landed

  const wanted = exactChild(sw, value) ?? playing; // no child for this value: the playing child plays on
  if (wanted === playing) {
    if (state.target !== null) {
      state.target = null;
      cancelTransition(player, f);
    }
    return null;
  }
  if (wanted === state.target) return null; // already asked (or refused: not asked again until the value moves)
  const child = sw.children.find((c) => c.id === wanted);
  if (!child) return null;
  state.target = wanted;
  return requestTransition(player, child, f);
}
