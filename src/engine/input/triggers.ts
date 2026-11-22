/**
 * Input triggers (ADR 0336): when an action triggers, as Unreal's Enhanced Input defines them.
 * Each compiled trigger keeps its own state; a mapping combines its triggers by type:
 *
 * - **explicit** (default): any satisfied explicit trigger can trigger;
 * - **implicit**: every implicit trigger must be satisfied (`chord` is implicit by default);
 * - **blocker**: a satisfied blocker stops the mapping triggering.
 *
 * A mapping with no explicit trigger behaves as if it had `down`: it triggers while actuated.
 */
import type { TriggerSpec, TriggerType } from "./contextTypes";

/** None: nothing is happening. Ongoing: part-way (a hold not long enough yet). Triggered: satisfied. */
export const TriggerState = { none: 0, ongoing: 1, triggered: 2 } as const;
export type TriggerStateValue = 0 | 1 | 2;

/** What a trigger can ask about other actions of its set: their final flags of the last frame. */
export interface TriggerWorld {
  /** Whether `action` was triggered (level) last frame. */
  triggered(action: string): boolean;
  /** Whether `action` performed last frame. */
  performed(action: string): boolean;
}

/** One frame of a trigger: `actuated` is whether the mapping's value is actuated now. `pulse` is set when it fired a pulse. */
export interface CompiledTrigger {
  readonly type: TriggerType;
  /** Actions it reads (chord, combo), for validation. */
  readonly reads: readonly string[];
  update(actuated: boolean, dt: number, others: TriggerWorld): TriggerStateValue;
  /** True if the last update fired a pulse. */
  readonly pulsed: boolean;
}

/** Compile a trigger spec; throws with a readable message for a bad one. */
export function compileTrigger(spec: TriggerSpec): CompiledTrigger {
  let was = false;
  let t = 0;
  const track = (actuated: boolean) => {
    const before = was;
    was = actuated;
    return before;
  };
  const make = (type: TriggerType, update: (actuated: boolean, dt: number, others: TriggerWorld) => TriggerStateValue, reads: string[] = []): CompiledTrigger => {
    return { type, reads, pulsed: false, update };
  };
  const type = (fallback: TriggerType): TriggerType => spec.type ?? fallback;

  if ("down" in spec) return make(type("explicit"), (a) => (track(a), a ? 2 : 0));
  if ("pressed" in spec) return make(type("explicit"), (a) => (!track(a) && a ? 2 : 0));
  if ("released" in spec) {
    return make(type("explicit"), (a) => {
      const before = track(a);
      return a ? 1 : before ? 2 : 0;
    });
  }
  if ("hold" in spec) {
    const { min, oneShot } = spec.hold;
    positive("hold.min", min, true);
    let fired = false;
    return make(type("explicit"), (a, dt) => {
      track(a);
      if (!a) {
        t = 0;
        fired = false;
        return 0;
      }
      t += dt;
      if (t + 1e-9 < min) return 1;
      if (oneShot && fired) return 1;
      fired = true;
      return 2;
    });
  }
  if ("holdAndRelease" in spec) {
    const { min } = spec.holdAndRelease;
    positive("holdAndRelease.min", min, true);
    return make(type("explicit"), (a, dt) => {
      const before = track(a);
      if (a) {
        t += dt;
        return 1;
      }
      const r = before && t + 1e-9 >= min ? 2 : 0;
      t = 0;
      return r;
    });
  }
  if ("tap" in spec) {
    const { max } = spec.tap;
    positive("tap.max", max, false);
    return make(type("explicit"), (a, dt) => {
      const before = track(a);
      if (a) {
        if (before) t += dt;
        else t = 0;
        return t <= max ? 1 : 0;
      }
      const r = before && t <= max ? 2 : 0;
      t = 0;
      return r;
    });
  }
  if ("multiTap" in spec) {
    const { count, spacing, max = 0.2 } = spec.multiTap;
    if (!(Number.isInteger(count) && count >= 1)) throw new Error(`multiTap.count (${count}) must be a whole number of at least 1.`);
    positive("multiTap.spacing", spacing, false);
    let taps = 0;
    let since = 0;
    return make(type("explicit"), (a, dt) => {
      const before = track(a);
      if (a) {
        t = before ? t + dt : 0;
        if (t > max) taps = 0;
        return t <= max ? 1 : 0;
      }
      if (before) {
        if (t <= max) {
          taps++;
          since = 0;
          if (taps >= count) {
            taps = 0;
            return 2;
          }
        } else taps = 0;
      } else if (taps > 0) {
        since += dt;
        if (since > spacing) taps = 0;
      }
      return taps > 0 ? 1 : 0;
    });
  }
  if ("pulse" in spec) {
    const { interval, delay = 0, limit = 0 } = spec.pulse;
    positive("pulse.interval", interval, false);
    let next = 0;
    let fired = 0;
    const trigger = make(type("explicit"), (a, dt) => {
      const before = track(a);
      trigger.pulsed = false;
      if (!a) return 0;
      if (!before) {
        t = 0;
        next = delay;
        fired = 0;
      } else t += dt;
      if (t + 1e-9 >= next && (limit === 0 || fired < limit)) {
        fired++;
        next += interval;
        trigger.pulsed = true;
        return 2;
      }
      return 1;
    }) as CompiledTrigger & { pulsed: boolean };
    return trigger;
  }
  if ("chord" in spec) {
    const action = spec.chord.action;
    return make(type("implicit"), (a, _dt, others) => (track(a), others.triggered(action) ? 2 : 0), [action]);
  }
  if ("combo" in spec) {
    const steps = spec.combo.steps;
    if (!Array.isArray(steps) || steps.length === 0) throw new Error("combo.steps must list at least one action.");
    let step = 0;
    return make(
      type("explicit"),
      (a, dt, others) => {
        track(a);
        if (others.performed(steps[step].action)) {
          step++;
          t = 0;
          if (step === steps.length) {
            step = 0;
            return 2;
          }
          return 1;
        }
        if (step > 0) {
          t += dt;
          if (t > (steps[step].within ?? 0.5)) step = 0;
        }
        return step > 0 ? 1 : 0;
      },
      steps.map((s) => s.action),
    );
  }
  throw new Error(`Unknown trigger ${JSON.stringify(spec)} (down, pressed, released, hold, holdAndRelease, tap, multiTap, pulse, chord or combo).`);
}

function positive(name: string, v: number, allowZero: boolean): void {
  if (!(typeof v === "number" && (allowZero ? v >= 0 : v > 0))) throw new Error(`${name} (${v}) must be a number ${allowZero ? "of at least" : "above"} 0.`);
}

/**
 * A mapping's state from its triggers this frame (see the module comment). `pulse` is true when a
 * satisfied trigger fired a pulse (each pulse performs again).
 */
export function combineTriggers(triggers: readonly CompiledTrigger[], actuated: boolean, dt: number, others: TriggerWorld): { state: TriggerStateValue; pulse: boolean } {
  let explicit = false;
  let explicitTriggered = false;
  let ongoing = false;
  let implicitAll = true;
  let blocked = false;
  let pulse = false;
  for (const tr of triggers) {
    const r = tr.update(actuated, dt, others);
    if (tr.type === "blocker") {
      if (r === 2) blocked = true;
      continue;
    }
    if (r === 1) ongoing = true;
    if (tr.type === "explicit") {
      explicit = true;
      if (r === 2) {
        explicitTriggered = true;
        if (tr.pulsed) pulse = true;
      }
    } else if (r !== 2) implicitAll = false;
  }
  if (!explicit) {
    // No explicit trigger: "down".
    explicitTriggered = actuated;
  }
  if (blocked) return { state: 0, pulse: false };
  if (explicitTriggered && implicitAll) return { state: 2, pulse };
  return { state: ongoing ? 1 : 0, pulse: false };
}
