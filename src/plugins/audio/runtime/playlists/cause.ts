// ADR 0435: what in the game asked for a playlist instance, for the capture's `eventStart` (the profiler's "Why it
// played" game step). The request names itself (`trigger`, and the node a component plays for); the engine says which
// behaviour hook and defined system are running (`runningScript`). Built only while a recorder runs.
import type { GameObject } from "../../../../engine/scene/GameObject";
import { getComponentId, type ComponentClass } from "../../../../engine/core/registry";
import { runningScript } from "../../../../engine/core/runningScript";
import type { ProfileCause } from "../mix/profileSink";

/** A node's path of names from the World root ("/Player/Bike"). */
function nodePath(node: GameObject): string {
  const names: string[] = [];
  for (let n: GameObject | null = node; n?.parent; n = n.parent) names.unshift(n.name);
  return `/${names.join("/")}`;
}

/**
 * The cause of a play asked by `trigger` ("Audio.play", "AudioSource"…) for `node` (a component's node, a line's), or,
 * without one, for the node of the behaviour whose hook is running.
 */
export function playCause(trigger: string, node: GameObject | null | undefined): ProfileCause {
  const running = runningScript();
  const b = running?.behaviour ?? null;
  const at = node && node.isValid ? node : b && b.node.isValid ? b.owner : null;
  // The registered id ("flappy.Bird") survives minification; an unregistered class goes by its name.
  const type = b ? getComponentId(b.constructor as ComponentClass) ?? (b.constructor.name || "Behaviour") : null;
  return { trigger, node: at ? nodePath(at) : null, behaviour: type ? `${type}.${running!.hook}` : null, system: running?.system ?? null };
}
