/**
 * The byte form of a live mix op (ADR 0171 amended by 0172; api-and-models §6.2), the payload the capture format gives
 * its MIXOP record: `u8 op`, `u8 class`, `u16 argc`, then `argc` u32 words (floats as f64 bit patterns, strings as name
 * ids, buses as `busRef`, §6.3). `encodeMixOp` and `decodeMixOp` are exact inverses for every `MixOp`.
 */
import { CURVE_KEY_INTERPS, curveKeyHandles, curveKeyInterpCode, type Curve, type CurveKey } from "../core/curve";
import { CORE_EFFECT_TYPES } from "./busCapability";
import { effectSpec } from "./effects/catalogue";
import { EFFECT_KEYS, MIX_OP_NAMES, OP_CLASSES, OP_CLASS_CODES, isProjectOp, type MixOp, type OpClass } from "./mixOps";
import { isProjectOp as isProjectOpName } from "./projectOps";
import { EFFECT_TYPES, type BusAutomation, type BusEffect, type DuckingRule, type LoudnessTarget } from "./settings";

/** The byte form of one op (the capture's MIXOP record): `u8 op`, `u8 class`, `u16 argc`, `argc` u32 words (§6.2). */
export interface MixOpBytes { op: number; class: number; words: Uint32Array }

/** Resolves names to ids and bus names to `busRef` (`gen << 8 | slot`, §6.3) for the byte form. */
export interface MixOpNameTable {
  nameId(name: string): number;
  busRef(bus: string): number;
}

// --- the byte form (the capture's MIXOP record) ------------------------------------------------------------------------

const SET_BUS_KEYS = ["volume", "mute", "maxVoices", "bed", "bedPriority", "meter"] as const;
const DUCK_MODES = [undefined, "presence", "level"] as const;
const DUCK_DETECTORS = [undefined, "peak", "rms"] as const;
const AUTOMATION_TARGETS = ["volume", "lowpass"] as const;
/** Value tags of a nullable value word. */
const Tag = { Null: 0, False: 1, True: 2, Number: 3, String: 4 } as const;
/** Flag bits of a list op (`setDucking`, `setAutomation`, `setTarget`) and of an optional field. */
const Flag = { Item: 1, HasInsert: 2, Insert: 4 } as const;

const f64 = new DataView(new ArrayBuffer(8));

class Writer {
  readonly words: number[] = [];
  constructor(private readonly names: MixOpNameTable) {}
  u(n: number): void { this.words.push(n >>> 0); }
  f(x: number): void { f64.setFloat64(0, x, true); this.words.push(f64.getUint32(0, true), f64.getUint32(4, true)); }
  s(name: string): void { this.u(this.names.nameId(name)); }
  b(bus: string): void { this.u(this.names.busRef(bus)); }
  code<T>(list: readonly T[], v: T): void { const i = list.indexOf(v); if (i < 0) throw new Error(`encodeMixOp: unknown value ${String(v)}`); this.u(i); }
  value(v: number | boolean | string | null): void {
    if (v === null) this.u(Tag.Null);
    else if (typeof v === "boolean") this.u(v ? Tag.True : Tag.False);
    else if (typeof v === "number") { this.u(Tag.Number); this.f(v); }
    else { this.u(Tag.String); this.s(v); }
  }
  listFlags(item: unknown, insert: boolean | undefined): void {
    this.u((item !== null ? Flag.Item : 0) | (insert !== undefined ? Flag.HasInsert : 0) | (insert ? Flag.Insert : 0));
  }
  effect(e: BusEffect): void {
    this.code(EFFECT_TYPES, e.type);
    if (e.type === "fx") {
      // ADR 0331: the catalogue type, its parameters in the catalogue's order, then the key bus (a nullable name).
      this.code(CORE_EFFECT_TYPES, e.fx);
      for (const q of effectSpec(e.fx).params) this.f(e.params[q.name] ?? q.default);
      this.value(e.key ?? null);
      return;
    }
    for (const k of EFFECT_KEYS[e.type]) this.f((e as unknown as Record<string, number>)[k]);
  }
}

class Reader {
  private at = 0;
  constructor(private readonly words: Uint32Array, private readonly names: { name(id: number): string; bus(ref: number): string }) {}
  u(): number { if (this.at >= this.words.length) throw new Error("decodeMixOp: record too short"); return this.words[this.at++]; }
  f(): number { f64.setUint32(0, this.u(), true); f64.setUint32(4, this.u(), true); return f64.getFloat64(0, true); }
  s(): string { return this.names.name(this.u()); }
  b(): string { return this.names.bus(this.u()); }
  code<T>(list: readonly T[]): T { const i = this.u(); if (i >= list.length) throw new Error(`decodeMixOp: bad code ${i}`); return list[i]; }
  value(): number | boolean | string | null {
    switch (this.u()) {
      case Tag.Null: return null;
      case Tag.False: return false;
      case Tag.True: return true;
      case Tag.Number: return this.f();
      case Tag.String: return this.s();
      default: throw new Error("decodeMixOp: bad value tag");
    }
  }
  listFlags(): { item: boolean; insert?: boolean } {
    const fl = this.u();
    return { item: (fl & Flag.Item) !== 0, ...(fl & Flag.HasInsert ? { insert: (fl & Flag.Insert) !== 0 } : {}) };
  }
  effect(): BusEffect {
    const type = this.code(EFFECT_TYPES);
    if (type === "fx") {
      const fx = this.code(CORE_EFFECT_TYPES);
      const params: Record<string, number> = {};
      for (const q of effectSpec(fx).params) params[q.name] = this.f();
      const key = this.value();
      return { type, fx, params, ...(typeof key === "string" ? { key } : {}) };
    }
    const e: Record<string, unknown> = { type };
    for (const k of EFFECT_KEYS[type]) e[k] = this.f();
    return e as unknown as BusEffect;
  }
  get done(): boolean { return this.at === this.words.length; }
}

/**
 * The byte form of `op`: indices and counts as u32 words, numbers as f64 bit patterns (two words, low word first,
 * exact), strings as `nameId`, existing buses as `busRef` (`addBus.name` and `renameBus.to` are new names: `nameId`),
 * optional and nullable fields behind a flag word, effects and enums as small codes.
 *
 * Layouts (after `u8 op`, `u8 class`, `u16 argc`): setBus bus, key, value(tag[, payload]) · addBus name, parent,
 * hasIndex[, index] · removeBus bus · renameBus from, to · moveBus bus, parent · addEffect bus, index, effect(type,
 * fields) · removeEffect bus, index · moveEffect bus, from, to · setEffect bus, index, key, f64 · add/remove/renameSnapshot
 * index, hasName[, name] · setSnapshot index, bus, key, value · setDucking index, flags[, target, trigger, mode, detector,
 * hasThreshold[, threshold], amount, attack, release] · setAutomation index, flags[, bus, parameter, target, keys, (x, y,
 * interp[, f64 inDx, inDy, outDx, outDy, u32 free when interp is 6, bezier])…] · setTarget index, flags[, name, integrated, tolerance, truePeak] · setOption key, value.
 * The mix model's own ops (ADR 0330: setMute, setReturn, setSend, setVca, setSnapshotDef, setSnapshotLevel,
 * setSnapshotEffect; `projectOps.ts`) are one word: the op as JSON, interned like a name (returns and VCAs have no bus
 * slot, so no `busRef` applies; JSON keeps their nested definitions exact).
 */
export function encodeMixOp(op: MixOp, cls: OpClass, names: MixOpNameTable): MixOpBytes {
  const w = new Writer(names);
  if (isProjectOp(op)) w.s(JSON.stringify(op));
  else switch (op.op) {
    case "setBus": w.b(op.bus); w.code(SET_BUS_KEYS, op.key); w.value(op.value); break;
    case "addBus": w.s(op.name); w.b(op.parent); w.u(op.index !== undefined ? 1 : 0); if (op.index !== undefined) w.u(op.index); break;
    case "removeBus": w.b(op.bus); break;
    case "renameBus": w.b(op.from); w.s(op.to); break;
    case "moveBus": w.b(op.bus); w.b(op.parent); break;
    case "addEffect": w.b(op.bus); w.u(op.index); w.effect(op.effect); break;
    case "removeEffect": w.b(op.bus); w.u(op.index); break;
    case "moveEffect": w.b(op.bus); w.u(op.from); w.u(op.to); break;
    case "setEffect": w.b(op.bus); w.u(op.index); w.s(op.key); w.f(op.value); break;
    case "addSnapshot": case "removeSnapshot": case "renameSnapshot":
      w.u(op.index); w.u(op.name !== undefined ? 1 : 0); if (op.name !== undefined) w.s(op.name); break;
    case "setSnapshot": w.u(op.index); w.b(op.bus); w.code(AUTOMATION_TARGETS, op.key); w.value(op.value); break;
    case "setDucking": {
      w.u(op.index); w.listFlags(op.rule, op.insert);
      const r = op.rule;
      if (r) {
        w.b(r.target); w.b(r.trigger); w.code(DUCK_MODES, r.mode); w.code(DUCK_DETECTORS, r.detector);
        w.u(r.threshold !== undefined ? 1 : 0); if (r.threshold !== undefined) w.f(r.threshold);
        w.f(r.amount); w.f(r.attack); w.f(r.release);
      }
      break;
    }
    case "setAutomation": {
      w.u(op.index); w.listFlags(op.rule, op.insert);
      const r = op.rule;
      if (r) {
        w.b(r.bus); w.s(r.parameter); w.code(AUTOMATION_TARGETS, r.target); w.u(r.curve.length);
        for (const k of r.curve) {
          w.f(k[0]); w.f(k[1]); w.u(k.length > 2 ? curveKeyInterpCode(k) + 1 : 0);
          const h = curveKeyHandles(k);
          if (h) { w.f(h.in[0]); w.f(h.in[1]); w.f(h.out[0]); w.f(h.out[1]); w.u(h.free ? 1 : 0); }
        }
      }
      break;
    }
    case "setTarget": {
      w.u(op.index); w.listFlags(op.target, op.insert);
      const t = op.target;
      if (t) { w.s(t.name); w.f(t.integrated); w.f(t.tolerance); w.f(t.truePeak); }
      break;
    }
    case "setOption": w.u(0); w.u(op.value ? 1 : 0); break;
  }
  if (w.words.length > 0xffff) throw new Error(`encodeMixOp: ${w.words.length} words is over the u16 argc`);
  return { op: MIX_OP_NAMES.indexOf(op.op), class: OP_CLASS_CODES[cls], words: Uint32Array.from(w.words) };
}

/** The op back from its byte form; `name(id)` and `bus(ref)` resolve what `encodeMixOp` interned. */
export function decodeMixOp(bytes: MixOpBytes, names: { name(id: number): string; bus(ref: number): string }): { op: MixOp; class: OpClass } {
  const name = MIX_OP_NAMES[bytes.op];
  const cls = OP_CLASSES[bytes.class];
  if (name === undefined) throw new Error(`decodeMixOp: unknown op ${bytes.op}`);
  if (cls === undefined) throw new Error(`decodeMixOp: unknown class ${bytes.class}`);
  const r = new Reader(bytes.words, names);
  const withInsert = (fl: { insert?: boolean }) => (fl.insert !== undefined ? { insert: fl.insert } : {});
  let op: MixOp;
  if (isProjectOpName({ op: name })) {
    const parsed = JSON.parse(r.s()) as MixOp;
    if (parsed.op !== name) throw new Error(`decodeMixOp: the record says ${name} but holds ${parsed.op}`);
    op = parsed;
  } else switch (name) {
    case "setBus": { const bus = r.b(); const key = r.code(SET_BUS_KEYS); op = { op: name, bus, key, value: r.value() }; break; }
    case "addBus": { const n = r.s(); const parent = r.b(); op = r.u() ? { op: name, name: n, parent, index: r.u() } : { op: name, name: n, parent }; break; }
    case "removeBus": op = { op: name, bus: r.b() }; break;
    case "renameBus": { const from = r.b(); op = { op: name, from, to: r.s() }; break; }
    case "moveBus": { const bus = r.b(); op = { op: name, bus, parent: r.b() }; break; }
    case "addEffect": { const bus = r.b(); const index = r.u(); op = { op: name, bus, index, effect: r.effect() }; break; }
    case "removeEffect": { const bus = r.b(); op = { op: name, bus, index: r.u() }; break; }
    case "moveEffect": { const bus = r.b(); const from = r.u(); op = { op: name, bus, from, to: r.u() }; break; }
    case "setEffect": { const bus = r.b(); const index = r.u(); const key = r.s(); op = { op: name, bus, index, key, value: r.f() }; break; }
    case "addSnapshot": case "removeSnapshot": case "renameSnapshot": {
      const index = r.u();
      op = r.u() ? { op: name, index, name: r.s() } : { op: name, index };
      break;
    }
    case "setSnapshot": { const index = r.u(); const bus = r.b(); const key = r.code(AUTOMATION_TARGETS); op = { op: name, index, bus, key, value: r.value() as number | null }; break; }
    case "setDucking": {
      const index = r.u(), fl = r.listFlags();
      let rule: DuckingRule | null = null;
      if (fl.item) {
        const target = r.b(), trigger = r.b(), mode = r.code(DUCK_MODES), detector = r.code(DUCK_DETECTORS);
        const threshold = r.u() ? r.f() : undefined;
        const amount = r.f(), attack = r.f(), release = r.f();
        rule = { target, trigger, ...(mode ? { mode } : {}), ...(detector ? { detector } : {}), ...(threshold !== undefined ? { threshold } : {}), amount, attack, release };
      }
      op = { op: name, index, rule, ...withInsert(fl) };
      break;
    }
    case "setAutomation": {
      const index = r.u(), fl = r.listFlags();
      let rule: BusAutomation | null = null;
      if (fl.item) {
        const bus = r.b(), parameter = r.s(), target = r.code(AUTOMATION_TARGETS), n = r.u();
        const curve: CurveKey[] = [];
        for (let i = 0; i < n; i++) {
          const x = r.f(), y = r.f(), interp = r.u();
          if (interp > CURVE_KEY_INTERPS.length) throw new Error("decodeMixOp: bad curve interpolation");
          const name = interp ? CURVE_KEY_INTERPS[interp - 1]! : undefined;
          if (name === "bezier") {
            const inH: [number, number] = [r.f(), r.f()], out: [number, number] = [r.f(), r.f()], free = r.u() === 1;
            curve.push([x, y, "bezier", { in: inH, out, ...(free ? { free } : {}) }]);
          } else curve.push(name ? [x, y, name] : [x, y]);
        }
        rule = { bus, parameter, target, curve: curve as Curve };
      }
      op = { op: name, index, rule, ...withInsert(fl) };
      break;
    }
    case "setTarget": {
      const index = r.u(), fl = r.listFlags();
      let target: LoudnessTarget | null = null;
      if (fl.item) { const n = r.s(); const integrated = r.f(), tolerance = r.f(), truePeak = r.f(); target = { name: n, integrated, tolerance, truePeak }; }
      op = { op: name, index, target, ...withInsert(fl) };
      break;
    }
    case "setOption": r.u(); op = { op: name, key: "loudnessResetOnPlay", value: r.u() !== 0 }; break;
    default: throw new Error(`decodeMixOp: unknown op ${name}`);
  }
  if (!r.done) throw new Error("decodeMixOp: trailing words");
  return { op, class: cls };
}
