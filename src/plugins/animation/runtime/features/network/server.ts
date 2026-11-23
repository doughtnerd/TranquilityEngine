// Servers write each replicated Animator's state into its replicated fields (ADR 0370 "Networking"; T33), from
// `animation.Apply` (`stages/apply/network.ts`), so 0033's replication sends it with the tick's snapshot (its send
// runs after lateUpdate scripts): each layer machine's state and the tick it was entered on, the parameters declared
// `replicate` that code has set (quantised; the tick they last changed), each slot's latest play, and run-time link
// choices. Fixed-mode Animators are written in the fixed pass that evaluated them, the others in lateUpdate. A field is
// assigned only when its string changes.
import type { AnimationFrame } from "../../stages/frame";
import type { Animator } from "../../components/Animator";
import { graphMeta, graphState, writtenParameters, warnOnce } from "../graph/runtime";
import { animatorsOf } from "../instances";
import { roleOf, sessionOf } from "./ghosts";
import { netAnimator, resolveTrack, toNetSlot } from "./state";
import { encodeLinks, encodeParameters, encodeSlots, encodeStates, quantizeParameter, type Encoded, type NetParameterValue, type NetState } from "./wire";

type NetField = "netStates" | "netParameters" | "netSlots" | "netLinks";

function write(animator: Animator, field: NetField, e: Encoded): void {
  if (e.dropped) warnOnce(`net-${field}:${animator.node.name}`, `[myco] ${animator.node.name}: the Animator's replicated ${field} is over 255 bytes; ${e.dropped} entr${e.dropped === 1 ? "y was" : "ies were"} left out.`);
  if (animator[field] !== e.raw) animator[field] = e.raw;
}

/** @internal Servers: the replicated fields of `frame`'s Animators. */
export function writeReplicated(frame: AnimationFrame): void {
  const session = sessionOf(frame.world);
  if (!session?.isServer) return;
  const tick = session.simulatedTick;
  for (const rt of animatorsOf(frame.world)) {
    const a = rt.animator;
    if ((a.updateMode === "fixed") !== frame.fixed || !rt.instance || roleOf(rt, session) !== "server") continue;
    const meta = graphMeta(a);
    if (!meta) continue;
    const na = netAnimator(rt);

    const states: NetState[] = [];
    meta.machines.forEach((m, machine) => {
      if (m.layer === null) return;
      const info = graphState(a, m.layer);
      const state = m.states.indexOf(info.transitioningTo ?? info.name);
      if (state < 0) return;
      let known = na.states.get(machine);
      if (!known || known.state !== state) na.states.set(machine, (known = { state, tick }));
      states.push({ machine, state, tick: known.tick });
    });
    write(a, "netStates", encodeStates(states));

    const values = writtenParameters(a, (i) => meta.paramReplication[i]?.replicate === true).map(([i, v]) => [i, quantizeParameter(v)] as const);
    const key = JSON.stringify(values);
    if (key !== na.paramKey) {
      na.paramKey = key;
      na.paramTick = tick;
    }
    write(a, "netParameters", encodeParameters({ tick: na.paramTick, values: values as (readonly [number, NetParameterValue])[] }));

    const slots = [];
    for (const t of na.slots.values()) if (resolveTrack(t, a)) slots.push(toNetSlot(t));
    write(a, "netSlots", encodeSlots(slots));
    write(a, "netLinks", encodeLinks([...na.links.values()]));
  }
}
