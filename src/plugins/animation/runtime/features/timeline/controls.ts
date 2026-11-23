// The `control` track actions (ADR 0371; T22t), set on the events feature's dispatch point (`../events/controls.ts`) at
// each activation. A key's `target` is a node path relative to the Animator's or director's node ("" or none: that
// node); its `payload` is an object of options. Each action uses the engine's public API only:
//
// - `particlePlay`: the target's `ParticleSystem` (on the node, else the first below it) `play()`, or `restart()` with
//   `{ "restart": true }`.
// - `particleStop`: its `stop({ clear })`, `{ "clear": true }` removing the particles already out.
// - `cameraCut`: the target's `Camera` is enabled and every other enabled Camera of the World that renders to the
//   screen (no `targetTexture`) is disabled, so it becomes `Camera.main` (a hard cut, as Unity's Timeline cuts between
//   cameras without Cinemachine). Render-texture cameras are left alone.
// - `slotPlay`: the target's `Animator` plays `payload.clip` (required) with `slot`, `fade`, `section`, `speed` and
//   `layer` from the payload (`Animator.play`). Slot plays are T32's: until it lands, a key with a `slot` gets one warning
//   and doesn't play; without `slot` the clip plays on the implicit graph's layer.
//
// A missing target or component gives one warning per clip, action and target.
import type { ControlAction } from "../../../../../engine/animation/tracks";
import { Camera, ParticleSystem } from "../../../../../engine/render/components";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import { Animator } from "../../components/Animator";
import type { AnimatorPlayOptions } from "../../types";
import { setControlHandler, type AnimationControl, type AnimationControlHandler } from "../events/controls";

const warned = new Set<string>();
function warnOnce(c: AnimationControl, what: string): void {
  const key = `${c.clip}\u0000${c.action}\u0000${c.target ?? ""}\u0000${what}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[myco] ${c.node.isValid ? c.node.name : "?"}: the "${c.action}" key of "${c.clip}" ${what}; skipped.`);
}

const options = (payload: unknown): Record<string, unknown> => (typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {});

function targetNode(c: AnimationControl): GameObject | null {
  if (!c.node.isValid) return null;
  const n = c.target ? c.node.find(c.target) : c.node;
  if (!n) warnOnce(c, `names no node "${c.target ?? ""}"`);
  return n;
}

function particles(c: AnimationControl): ParticleSystem | null {
  const n = targetNode(c);
  if (!n) return null;
  const ps = n.getComponent(ParticleSystem) ?? n.getComponentInChildren(ParticleSystem);
  if (!ps) warnOnce(c, `finds no ParticleSystem on "${n.name}"`);
  return ps;
}

const particlePlay: AnimationControlHandler = (c) => {
  const ps = particles(c);
  if (!ps) return;
  if (options(c.payload).restart === true) ps.restart();
  else ps.play();
};

const particleStop: AnimationControlHandler = (c) => {
  particles(c)?.stop({ clear: options(c.payload).clear === true });
};

const cameraCut: AnimationControlHandler = (c) => {
  const n = targetNode(c);
  if (!n) return;
  const cam = n.getComponent(Camera);
  if (!cam) return warnOnce(c, `finds no Camera on "${n.name}"`);
  for (const other of n.world._componentsOfType(Camera)) if (other !== cam && other.enabled && !other.targetTexture) other.enabled = false;
  cam.enabled = true;
};

const slotWarned = new Set<string>();

const slotPlay: AnimationControlHandler = (c) => {
  const n = targetNode(c);
  if (!n) return;
  const anim = n.getComponent(Animator);
  if (!anim) return warnOnce(c, `finds no Animator on "${n.name}"`);
  const o = options(c.payload);
  if (typeof o.clip !== "string" || !o.clip) return warnOnce(c, "has no `clip` in its payload");
  const play: { -readonly [K in keyof AnimatorPlayOptions]: AnimatorPlayOptions[K] } = {};
  if (typeof o.slot === "string") play.slot = o.slot;
  if (typeof o.fade === "number") play.fade = o.fade;
  if (typeof o.section === "string") play.section = o.section;
  if (typeof o.speed === "number") play.speed = o.speed;
  if (typeof o.layer === "number" || typeof o.layer === "string") play.layer = o.layer;
  try {
    void anim.play(o.clip, play);
  } catch (err) {
    // Slot plays throw until T32 builds them (`notBuilt`).
    const key = `${c.clip}\u0000${String(o.slot)}`;
    if (slotWarned.has(key)) return;
    slotWarned.add(key);
    console.warn(`[myco] ${n.name}: the "slotPlay" key of "${c.clip}" can't play yet (${(err as Error).message}); skipped.`);
  }
};

const HANDLERS: Readonly<Record<ControlAction, AnimationControlHandler>> = { particlePlay, particleStop, cameraCut, slotPlay };

/** @internal Sets every control action's handler (each activation). */
export function registerControlHandlers(): void {
  for (const [action, handler] of Object.entries(HANDLERS) as [ControlAction, AnimationControlHandler][]) setControlHandler(action, handler);
}
