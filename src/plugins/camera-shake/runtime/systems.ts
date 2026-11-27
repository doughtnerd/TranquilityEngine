/**
 * Camera shake's engine systems (ADR 0436), both in `lateUpdate` after `lateUpdate()` scripts, so follow scripts have
 * placed their cameras and animation has written keyed fields:
 *
 * - `cameraShake.Sources` sends the impulses `ShakeImpulseSource`s' triggers call for (`fire` edges, `onStart`,
 *   `interval`, physics collisions and trigger contacts) into `ShakeImpulses`.
 * - `cameraShake.Listen` moves this frame's `ShakeImpulses` into the World's live impulses (an impulse outlives the
 *   frame's buffer), drops finished ones, sums for each active `CameraShake` the impulses that reach it plus its own
 *   shakes and noise, and adds the result to its node's `CameraViewOffset`.
 *
 * Nothing runs in a scene being edited (ADR 0026).
 */
import type { World } from "../../../engine/core/World";
import { Vector3 } from "../../../engine/core/math";
import type { BuiltinSystem } from "../../../engine/core/systems";
import { Camera } from "../../../engine/render/components";
import { CameraViewOffset } from "../../../engine/render/cameraViewOffset";
import { ShakeImpulses, type ShakeImpulse } from "./buffers";
import { shakePhysics, type ShakePhysics } from "./physics";
import { CameraShake } from "./CameraShake";
import { IMPULSE_SHAPES, NOISE_PROFILES, SHAKE_IMPULSE_PRESETS, type ImpulseShape } from "./presets";
import { ShakeImpulseSource } from "./ShakeImpulseSource";
import { addImpulse, addNoise, strengthAt, zero6 } from "./signal";

/** An impulse still running. */
interface LiveImpulse {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly shape: ImpulseShape;
  readonly duration: number;
  readonly radius: number;
  readonly dissipation: number;
  readonly speed: number;
  readonly channel: string;
  /** When it started on the scaled clock (`time.time`) and the real one (`time.realtimeSinceStartup`). */
  readonly scaledStart: number;
  readonly realStart: number;
  /** How long after its start the last listener it can reach hears its end. */
  readonly lifetime: number;
  readonly seed: number;
}

interface WorldShake {
  live: LiveImpulse[];
  /** Impulses taken so far: each one's noise seed. */
  count: number;
}

const states = new WeakMap<World, WorldShake>();

function stateOf(world: World): WorldShake {
  let s = states.get(world);
  if (!s) states.set(world, (s = { live: [], count: 0 }));
  return s;
}

const num = (v: number | undefined, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function toLive(world: World, s: WorldShake, imp: ShakeImpulse): LiveImpulse | null {
  const preset = imp.preset ?? "bump";
  if (!SHAKE_IMPULSE_PRESETS.includes(preset)) {
    console.warn(`[myco] ShakeImpulses: unknown preset "${String(preset)}" (${SHAKE_IMPULSE_PRESETS.join(", ")}); the impulse is skipped.`);
    return null;
  }
  const shape = IMPULSE_SHAPES[preset];
  const p = Vector3.from(imp.position), v = Vector3.from(imp.velocity);
  const duration = Math.max(0, num(imp.duration, shape.duration));
  const radius = Math.max(0, num(imp.radius, 0));
  const dissipation = Math.max(0, num(imp.dissipationDistance, 100));
  const speed = Math.max(0, num(imp.propagationSpeed, 0));
  const lifetime = duration + (speed > 0 ? (radius + dissipation) / speed : 0);
  return {
    x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z,
    shape, duration, radius, dissipation, speed,
    channel: imp.channel ?? "",
    // Sent during this frame: it started when the frame did, so the frame that hears it already shows it.
    scaledStart: world.time.time - world.time.deltaTime,
    realStart: world.time.realtimeSinceStartup - world.time.unscaledDeltaTime,
    lifetime,
    seed: ++s.count * 9973,
  };
}

/** A node's seed for its noise: its own, or one from its entity. */
const seedOf = (shake: CameraShake): number => (shake.seed !== 0 ? Math.trunc(shake.seed) : shake.node.entity * 2654435761 + 12345) | 0;

/**
 * For each node (and owner) in a collision that started this frame, the other body's velocity now (0 for a collider
 * with no body). A source's impact speed is its own body's velocity before the contact (`_lastVelocity`, kept each
 * frame) less this: by the time systems read the contact the solver has already stopped the body.
 */
function collisionPartners({ CollisionEvents, CollisionEvents2D }: ShakePhysics): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  const note = (self: { node: { entity: number }; owner: { entity: number } }, v: [number, number, number]) => {
    out.set(self.node.entity, v);
    out.set(self.owner.entity, v);
  };
  for (const ev of CollisionEvents.read()) {
    if (!ev.started) continue;
    const va = ev.a.attachedRigidbody?.velocity, vb = ev.b.attachedRigidbody?.velocity;
    note(ev.a, [vb?.x ?? 0, vb?.y ?? 0, vb?.z ?? 0]);
    note(ev.b, [va?.x ?? 0, va?.y ?? 0, va?.z ?? 0]);
  }
  for (const ev of CollisionEvents2D.read()) {
    if (!ev.started) continue;
    const va = ev.a.attachedRigidbody?.velocity, vb = ev.b.attachedRigidbody?.velocity;
    note(ev.a, [vb?.x ?? 0, vb?.y ?? 0, 0]);
    note(ev.b, [va?.x ?? 0, va?.y ?? 0, 0]);
  }
  return out;
}

/** The velocity of the body on a source's node, or 0. */
function bodyVelocity({ RigidBody, RigidBody2D }: ShakePhysics, src: ShakeImpulseSource, out: number[]): void {
  const b3 = src.node.getBehavior(RigidBody);
  if (b3) {
    const v = b3.velocity;
    out[0] = v.x; out[1] = v.y; out[2] = v.z;
    return;
  }
  const b2 = src.node.getBehavior(RigidBody2D);
  const v = b2?.velocity;
  out[0] = v?.x ?? 0; out[1] = v?.y ?? 0; out[2] = 0;
}

/** Nodes (and owners) in trigger contacts that started this frame. */
function triggerNodes({ TriggerEvents, TriggerEvents2D }: ShakePhysics): Set<number> {
  const out = new Set<number>();
  for (const ev of [...TriggerEvents.read(), ...TriggerEvents2D.read()]) {
    if (!ev.started) continue;
    for (const c of [ev.a, ev.b]) {
      out.add(c.node.entity);
      out.add(c.owner.entity);
    }
  }
  return out;
}

export const SOURCES_SYSTEM: BuiltinSystem = {
  name: "cameraShake.Sources",
  phase: "lateUpdate",
  after: ["engine.LateUpdateScripts"],
  run(world, dt) {
    const sources = world._componentsOfType(ShakeImpulseSource);
    if (sources.length === 0) return;
    const out = world._buffer(ShakeImpulses);
    const physics = shakePhysics();
    let partners: Map<number, [number, number, number]> | null = null;
    let triggers: Set<number> | null = null;
    for (const src of sources) {
      if (!src.isActiveAndEnabled || !src.node.transform || world.inEditMode(src.node.entity)) continue;
      if (src.fire && !src._lastFire) out.push(src._impulse());
      src._lastFire = src.fire;
      switch (src.trigger) {
        case "onStart":
          if (!src._startSent) out.push(src._impulse());
          src._startSent = true;
          break;
        case "interval":
          if (src.interval > 0) {
            src._sinceInterval += dt;
            if (src._sinceInterval >= src.interval) {
              src._sinceInterval %= src.interval;
              out.push(src._impulse());
            }
          }
          break;
        case "collision": {
          if (!physics) break;
          partners ??= collisionPartners(physics);
          const other = partners.get(src.node.entity);
          if (other) {
            const v = src._lastVelocity;
            const speed = Math.hypot(v[0]! - other[0], v[1]! - other[1], v[2]! - other[2]);
            if (speed >= src.minImpactSpeed) out.push(src._impulse(Math.min(4, speed / Math.max(1e-3, src.minImpactSpeed))));
          }
          bodyVelocity(physics, src, src._lastVelocity);
          break;
        }
        case "trigger":
          if (!physics) break;
          triggers ??= triggerNodes(physics);
          if (triggers.has(src.node.entity)) out.push(src._impulse());
          break;
        default:
          break;
      }
    }
  },
};

export const LISTEN_SYSTEM: BuiltinSystem = {
  name: "cameraShake.Listen",
  phase: "lateUpdate",
  after: ["engine.LateUpdateScripts", "cameraShake.Sources"],
  run(world) {
    const s = stateOf(world);
    for (const imp of world._buffer(ShakeImpulses)) {
      const live = toLive(world, s, imp);
      if (live) s.live.push(live);
    }
    const { time, realtimeSinceStartup: real } = world.time;
    if (s.live.length) s.live = s.live.filter((l) => time - l.scaledStart <= l.lifetime || real - l.realStart <= l.lifetime);
    const shakes = world._componentsOfType(CameraShake);
    if (shakes.length === 0) return;
    const store = world._dataStore(CameraViewOffset);
    const o6 = zero6();
    for (const shake of shakes) {
      const e = shake.node.entity;
      if (!shake.isActiveAndEnabled || !shake.node.transform || world.inEditMode(e)) {
        shake._offset.fill(0);
        continue;
      }
      const unscaled = shake.timeMode === "unscaled";
      const now = unscaled ? real : time;
      const seed = seedOf(shake);
      const m = world.worldMatrix(e), b = e * 16;
      const cx = m[b + 12]!, cy = m[b + 13]!, cz = m[b + 14]!;
      // The camera's axes (columns of its world matrix), for reading world-space directions in its space.
      const ax = [m[b]!, m[b + 1]!, m[b + 2]!], ay = [m[b + 4]!, m[b + 5]!, m[b + 6]!], az = [m[b + 8]!, m[b + 9]!, m[b + 10]!];
      for (const axis of [ax, ay, az]) {
        const len = Math.hypot(axis[0]!, axis[1]!, axis[2]!) || 1;
        for (let i = 0; i < 3; i++) axis[i]! /= len;
      }
      o6.fill(0);
      const gain = shake.impulseGain;
      if (gain !== 0) {
        const channels = shake.channels;
        for (const l of s.live) {
          if (l.channel !== "" && channels.length > 0 && !channels.includes(l.channel)) continue;
          const dx = l.x - cx, dy = l.y - cy, dz = l.z - cz;
          const dist = shake.use2DDistance ? Math.hypot(dx, dy) : Math.hypot(dx, dy, dz);
          const strength = strengthAt(dist, l.radius, l.dissipation);
          if (strength === 0) continue;
          const t = now - (unscaled ? l.realStart : l.scaledStart) - (l.speed > 0 ? dist / l.speed : 0);
          let vx = l.vx, vy = l.vy, vz = l.vz;
          if (!shake.useCameraSpace) {
            vx = l.vx * ax[0]! + l.vy * ax[1]! + l.vz * ax[2]!;
            vy = l.vx * ay[0]! + l.vy * ay[1]! + l.vz * ay[2]!;
            vz = l.vx * az[0]! + l.vy * az[1]! + l.vz * az[2]!;
          }
          addImpulse(o6, l.shape, t, l.duration, vx, vy, vz, strength * gain, seed ^ l.seed);
        }
        if (shake._local.length) {
          shake._local = shake._local.filter((sh) => now - sh.start <= sh.duration);
          let i = 0;
          for (const sh of shake._local) addImpulse(o6, IMPULSE_SHAPES[sh.preset], now - sh.start, sh.duration, 0, -sh.strength, 0, gain, seed ^ (++i * 31337));
        }
      }
      addNoise(o6, NOISE_PROFILES[shake.noise] ?? [], now, shake.amplitudeGain, shake.frequencyGain, seed);
      const ps = shake.positionScale, rs = shake.rotationScale;
      o6[0] *= ps.x; o6[1] *= ps.y; o6[2] *= ps.z;
      o6[3] *= rs.x; o6[4] *= rs.y; o6[5] *= rs.z;
      // Orthographic views show only movement across the screen and roll as shake (ADR 0436).
      if (shake.node.getBehavior(Camera)?.projection === "orthographic") o6[2] = o6[3] = o6[4] = 0;
      for (let i = 0; i < 6; i++) shake._offset[i] = o6[i]!;
      if (!store.present[e]) store.add(e);
      const a = store.arrays;
      a.px![e]! += o6[0]; a.py![e]! += o6[1]; a.pz![e]! += o6[2];
      a.rx![e]! += o6[3]; a.ry![e]! += o6[4]; a.rz![e]! += o6[5];
    }
  },
};
