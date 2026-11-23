// Notifies and keyed tracks to the ECS each frame (ADR 0372, "Notifies call methods"; `animation.Apply`'s events
// sub-step, last): the core's per-frame records in each Animator's track region, read after evaluate.
//
// - `EVENT` (a notify crossed) and `NOTIFY_STATE` (a notify state's begin, tick and end) become `AnimationEvent`s:
//   the method and args from the clip's string table (args JSON: an array is the arguments, any other value one
//   argument; objects inside are passed as their JSON text), phase `instant`/`begin`/`tick`/`end`, the clip's asset
//   reference and the key's time. Each is delivered through the World's behaviour messages (0303,
//   `World._sendMessage(nodes, NamedMessage, e)`) to the behaviours of the Animator's node that define the method, and
//   pushed to `AnimationEvents`. A method named like a lifecycle hook or a base-class member (`update`, `enabled`) is
//   never called, with one warning per clip and name; its record still goes to the buffer.
// - `AUDIO` keys play through the audio plugin's public API when it is active (`audio.ts`).
// - `CONTROL` keys go to their action's handler (`controls.ts`, T22t's).
// - `MARKER` records aren't notifies (0371: sync, exit, hit and cue points that graphs, sync groups, warps and seeks
//   read), so they call nothing; `ACTIVATION_EDGE` (the activation column already holds the level) and `SUBCLIP_STATE`
//   (timelines, T22t) are skipped here.
//
// Every Animator's records are decoded first and delivered after, so a behaviour that calls into the animation core
// (a play, a new Animator) can't move the memory under the reader.
import type { ControlAction } from "../../../../../engine/animation/tracks";
import { CONTROL_ACTIONS } from "../../../../../engine/animation/tracks";
import { NamedMessage } from "../../../../../engine/core/Component";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import { AnimationEvents, type AnimationEvent, type AnimationEventPhase } from "../../buffers";
import { getRecord, recordOpcode } from "../../core/records";
import type { AnimationFrame } from "../../stages/frame";
import { inPass } from "../../stages/gather/playback";
import { TRACK_HEADER, TRACK_RECORDS } from "../../wasm/wire/core";
import { ACTIVATION_EDGE, AUDIO, CONTROL, EVENT, MARKER, NOTIFY_STATE, OUTPUT_HEADER, PHASE_BEGIN, PHASE_TICK, SUBCLIP_STATE } from "../../wasm/wire/tracks";
import { animatorsOf, type AnimatorRuntime } from "../instances";
import { clipData, type ClipData } from "../properties/clipData";
import { clipPathOf } from "../properties/scatter";
import { trackRow } from "../properties/trackRegion";
import { playAudioKey } from "./audio";
import { dispatchControl, type AnimationControl } from "./controls";

type Arg = string | number | boolean | null;

/** One decoded record, ready to deliver. */
type Pending =
  | { readonly kind: "event"; readonly event: AnimationEvent; readonly message: NamedMessage | null }
  | { readonly kind: "audio"; readonly asset: string; readonly params: unknown; readonly weight: number; readonly node: GameObject }
  | { readonly kind: "control"; readonly control: AnimationControl };

const STRIDES = new Map<number, number>([EVENT, NOTIFY_STATE, ACTIVATION_EDGE, CONTROL, AUDIO, MARKER, SUBCLIP_STATE].map((l) => [l.opcode, l.stride]));
const PHASES: readonly AnimationEventPhase[] = ["begin", "tick", "end"];

/** Warned (clip, text) pairs: reserved method names and unreadable args, once each. */
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

function argsOf(data: ClipData, id: number, clip: string, node: GameObject): readonly Arg[] {
  const { value, bad } = data.json(id);
  if (bad) warnOnce(`args\u0000${clip}\u0000${id}`, `[myco] ${node.name}: a notify's args in the clip "${clip}" aren't JSON; it gets none.`);
  if (value === undefined) return [];
  const list = Array.isArray(value) ? (value as unknown[]) : [value];
  return list.map((v) => (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v)));
}

/** The node a keyed track names below the Animator's node (the Animator's node when it names none or it's missing). */
function trackNode(data: ClipData, track: number, root: GameObject): GameObject {
  const path = data.tracks?.tracks[track]?.nodePath;
  return (path && root.find(path)) || root;
}

function decode(frame: AnimationFrame, rt: AnimatorRuntime, out: Pending[]): void {
  const core = frame.core.core;
  const view = core.views().tracks;
  const row = trackRow(rt.instance);
  const head = row + TRACK_HEADER;
  const count = view.getUint32(head + OUTPUT_HEADER.fields.recordCount.offset, true);
  if (count === 0) return;
  const bytes = view.getUint32(head + OUTPUT_HEADER.fields.recordBytes.offset, true);
  const node = rt.animator.node;
  const animator = rt.animator;
  let at = row + TRACK_RECORDS;
  const end = at + bytes;
  for (let i = 0; i < count && at < end; i++) {
    const opcode = recordOpcode(view, at);
    const stride = STRIDES.get(opcode);
    if (stride === undefined) return; // not this build's layout: stop rather than misread
    if (opcode === EVENT.opcode || opcode === NOTIFY_STATE.opcode) {
      const state = opcode === NOTIFY_STATE.opcode;
      const r = state ? getRecord(view, at, NOTIFY_STATE) : getRecord(view, at, EVENT);
      const data = clipData(core, r.clip);
      const clip = clipPathOf(rt, r.clip);
      const method = data.tracks?.string(r.method) ?? "";
      const phase: AnimationEventPhase = "phase" in r ? PHASES[r.phase === PHASE_BEGIN ? 0 : r.phase === PHASE_TICK ? 1 : 2]! : "instant";
      const event: AnimationEvent = { node, animator, method, phase, args: argsOf(data, r.args, clip, node), clip, time: r.time };
      const message = NamedMessage.of(method);
      if (!message) warnOnce(`method\u0000${clip}\u0000${method}`, `[myco] ${node.name}: the clip "${clip}" names the notify method "${method}", which is reserved (a lifecycle hook or a built-in member); it isn't called.`);
      out.push({ kind: "event", event, message });
    } else if (opcode === AUDIO.opcode) {
      const r = getRecord(view, at, AUDIO);
      const data = clipData(core, r.clip);
      out.push({ kind: "audio", asset: data.tracks?.string(r.asset) ?? "", params: data.json(r.params).value, weight: r.weight, node: trackNode(data, r.track, node) });
    } else if (opcode === CONTROL.opcode) {
      const r = getRecord(view, at, CONTROL);
      const action: ControlAction | undefined = CONTROL_ACTIONS[r.control];
      if (action) {
        const data = clipData(core, r.clip);
        const control: AnimationControl = {
          animator,
          node,
          action,
          target: data.tracks?.string(r.target) ?? null,
          payload: data.json(r.payload).value,
          clip: clipPathOf(rt, r.clip),
          time: r.time,
          duration: r.duration,
          weight: r.weight,
        };
        out.push({ kind: "control", control });
      }
    }
    at += stride;
  }
}

/** @internal Decodes every Animator's records of the pass, then delivers them (see the file header). */
export function deliverEvents(frame: AnimationFrame): void {
  let pending: Pending[] | null = null;
  for (const rt of animatorsOf(frame.world)) {
    if (!inPass(frame, rt)) continue;
    decode(frame, rt, (pending ??= []));
  }
  if (!pending?.length) return;
  for (const p of pending) {
    if (p.kind === "event") {
      if (!p.event.node.isValid) continue;
      if (p.message) frame.world._sendMessage([p.event.node], p.message, p.event);
      AnimationEvents.push(p.event);
    } else if (p.kind === "audio") playAudioKey(p.asset, p.params, p.weight, p.node);
    else dispatchControl(p.control);
  }
}
