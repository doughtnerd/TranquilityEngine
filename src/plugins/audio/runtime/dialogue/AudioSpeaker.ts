/**
 * `AudioSpeaker` (ADR 0355 §4–§5): marks a node as a speaker (`speaker`: a line table speaker name). A said line with no
 * position or node of its own plays from, and follows, the enabled speaker of its line's speaker nearest the listener;
 * `say(event, options)` says an event from this node (and, when the event has an argument named `speaker`, with this
 * speaker as its value).
 */
import { Component } from "../../../../engine/core/Component";
import { component, field } from "../../../../engine/core/registry";
import { World } from "../../../../engine/core/World";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { listenerPoseIn } from "../AudioListener";
import type { AudioLineHandle } from "../localisation/lines";
// A cycle with `dialogueSystem.ts` (it places said lines with `nearestSpeaker`); each side uses the other only when called.
import { dialogueSystem, eventHasArgument, type SayOptions } from "./dialogueSystem";

@component("engine.AudioSpeaker")
export class AudioSpeaker extends Component {
  @field(String, { description: "The speaker this node voices (a line table's Speaker name): said lines of this speaker play from here." }) speaker = "";

  /** Says a dialogue event from this node (`Audio.say` with `node` set, and the `speaker` argument when the event has one). */
  say(event: string, options: SayOptions = {}): AudioLineHandle {
    const args = { ...(options.args ?? {}) };
    if (this.speaker !== "" && args.speaker === undefined && eventHasArgument(String(event), "speaker")) args.speaker = this.speaker;
    return dialogueSystem().say(String(event), { ...options, node: this.node, args });
  }
}

/** The node of the enabled `AudioSpeaker` voicing `speaker` nearest the listener (the first when there is no listener); null when none. */
export function nearestSpeaker(speaker: string): GameObject | null {
  const world = World.active;
  if (!world) return null;
  const at = listenerPoseIn(world)?.position ?? null; // ADR 0462
  let best: GameObject | null = null;
  let bestD = Infinity;
  for (const s of world._componentsOfType(AudioSpeaker)) {
    if (!s.isActiveAndEnabled || s.speaker !== speaker) continue;
    const p = s.node.transform?.worldPosition;
    const d = at && p ? Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z) : 0;
    if (d < bestD) { best = s.node; bestD = d; }
    if (!at) break;
  }
  return best;
}
