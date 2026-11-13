// The Mixer strip view (task Mp2a): every element rendered from a strip model, each control driving the model, a case per
// option. The component has no hooks, so the tests call it as a function and walk the VNode tree, as the rotation field's
// tests do; handlers are called with plain event objects. No DOM and no timers: the meter's clock is the `nowMs` passed.
import { readFileSync } from "node:fs";
import type { VNode } from "preact";
import { describe, expect, it } from "vitest";
import type { MixOp } from "../../../../engine/audio/mixOps";
import { EMPTY_BUS_LOUDNESS, type BusLoudness, type LoudnessTargetReading, type LoudnessTargetState } from "../../../../engine/audio/loudnessTypes";
import type { SettingsDraft } from "../../../../editor/sdk";
import { FADER_MAX_DB, UNITY_POSITION, positionToGain } from "./faderModel";
import { createMeter, readMeter, resetClip, tickMeter } from "./meterModel";
import { meterFill } from "../meterFill";
import { METER_FLOOR_DB, meterFill as meterFillFromView } from "../BusMeters";
import { buildStrips, createMixerModel, type BusReading, type MixerHost, type MixerModel, type Strip } from "./mixerModel";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { GAIN_REDUCTION_MAX_DB, MixerStrip, faderHandlers, formatLufs, gainReductionDb, lufsFill, targetMarks, type MixerStripProps } from "./MixerStrip";

// ---- a rig: a real mixer model over an in-memory draft ----

const AUDIO = { buses: [{ name: "master" }, { name: "sfx", parent: "master" }, { name: "music", parent: "master", volume: 0.5, meter: "loudness" }] };

function rig(audio: object = AUDIO) {
  let draft: SettingsDraft = { audio } as SettingsDraft;
  const applied: MixOp[] = [];
  const commits: string[] = [];
  const monitors: Array<[string, { mute?: boolean; solo?: boolean }]> = [];
  let flushes = 0;
  const host: MixerHost = {
    draft: () => draft,
    apply: (op) => (applied.push(op), { ok: true, class: "direct" }),
    flushNow: () => void flushes++,
    commit: (label, next) => { commits.push(label); draft = next; },
    setMonitor: (bus, c) => void monitors.push([bus, c]),
  };
  const model = createMixerModel(host);
  const volume = (bus: string): number => parseAudioSettings(draft.audio).settings.buses.find((b) => b.name === bus)!.volume;
  return { model, applied, commits, monitors, volume, flushes: () => flushes, draft: () => draft };
}

const reading = (over: Partial<BusReading> = {}): BusReading => ({ runtimeVolume: 1, runtimeMute: false, solo: false, peak: 0, effectiveGain: 1, duckGain: 1, activeVoices: 0, loudness: EMPTY_BUS_LOUDNESS, ...over });

const target = (state: LoudnessTargetState, over: Partial<LoudnessTargetReading> = {}): LoudnessTargetReading => ({ name: "console", integrated: -24, tolerance: 2, truePeak: -1, deviation: 0, state, peakOver: false, ...over });
const loud = (over: Partial<BusLoudness> = {}): BusLoudness => ({ ...EMPTY_BUS_LOUDNESS, metered: true, momentary: -20, shortTerm: -22, integrated: -23.04, ...over });

/** The strip for `bus` as the model builds it. */
function stripOf(r: ReturnType<typeof rig>, bus: string, read: BusReading | null = reading(), meter?: { peak: number; hold: number; clipLatched: boolean }): Strip {
  return r.model.strips(() => read, meter ? () => meter : undefined).find((s) => s.name === bus)!;
}

// ---- walking a rendered tree ----

type Node = VNode<Record<string, unknown>>;
function find(node: unknown, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (Array.isArray(node)) { node.forEach((c) => find(c, pred, out)); return out; }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const v = node as Node;
  if (typeof v.type === "function") return find((v.type as (p: unknown) => unknown)(v.props), pred, out); // render components in place
  if (pred(v)) out.push(v);
  return find(v.props.children, pred, out);
}
const byClass = (cls: string) => (n: Node): boolean => typeof n.props.class === "string" && n.props.class.split(" ").includes(cls);
const byLabel = (label: string) => (n: Node): boolean => n.props["aria-label"] === label;
const one = (tree: unknown, pred: (n: Node) => boolean): Node => {
  const f = find(tree, pred);
  expect(f).toHaveLength(1);
  return f[0]!;
};
function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  const v = node as Node;
  if (typeof v.type === "function") return text((v.type as (p: unknown) => unknown)(v.props));
  return text(v.props.children);
}
const render = (props: MixerStripProps): VNode => MixerStrip(props) as VNode;
const fn = <T extends (...a: never[]) => unknown>(n: Node, key: string): T => n.props[key] as T;

// ---- events ----

interface Track { captured: number[]; released: number[]; focused: number }
function pointer(track: Track, clientY: number, over: { shiftKey?: boolean; button?: number; pointerId?: number } = {}) {
  return {
    clientY,
    button: over.button ?? 0,
    shiftKey: over.shiftKey ?? false,
    pointerId: over.pointerId ?? 7,
    currentTarget: {
      getBoundingClientRect: () => ({ height: 100 }),
      setPointerCapture: (id: number) => void track.captured.push(id),
      releasePointerCapture: (id: number) => void track.released.push(id),
      focus: () => void track.focused++,
    },
  } as never;
}
const newTrack = (): Track => ({ captured: [], released: [], focused: 0 });

/** Drive a fader as the browser would: re-render between events, so a stale handler would show. */
function faderOf(r: ReturnType<typeof rig>, bus: string, changes: { n: number }, read: BusReading | null = reading()) {
  const props = (): MixerStripProps => ({ strip: stripOf(r, bus, read), model: r.model, onChange: () => void changes.n++ });
  return () => faderHandlers(props());
}

describe("the strip renders every element from a strip model", () => {
  it("name, fader, authored and effective gain, buttons, peak meter, GR-less, LUFS", () => {
    const r = rig();
    const tree = render({ strip: stripOf(r, "music", reading({ effectiveGain: 0.25, loudness: loud({ target: target("ok") }) })), model: r.model });
    expect(text(one(tree, byClass("mixer-strip-name")))).toBe("music");
    const fader = one(tree, (n) => n.props.role === "slider");
    expect(fader.props["aria-label"]).toBe("music volume");
    expect(fader.props["aria-valuetext"]).toBe("-6.0 dB"); // authored 0.5
    expect(text(one(tree, byClass("mixer-gain-authored")))).toBe("-6.0 dB");
    expect(text(one(tree, byClass("mixer-gain-effective")))).toBe("eff -12.0 dB"); // beside it, from the live gain
    one(tree, byLabel("Mute music"));
    one(tree, byLabel("Solo music"));
    one(tree, byLabel("music level"));
    one(tree, byLabel("music clip"));
    expect(find(tree, byClass("mixer-gr"))).toHaveLength(0);
    expect(find(tree, byClass("mixer-lufs-row")).map((n) => n.props["data-reading"])).toEqual(["momentary", "shortTerm", "integrated"]);
    one(tree, byClass("mixer-target"));
  });

  it("the thumb sits at the taper position: unity at 75%, 0 at the bottom, +6 dB at the top", () => {
    const r = rig({ buses: [{ name: "master" }, { name: "a" }, { name: "b", volume: 0 }, { name: "c", volume: 2 }].map((b, i) => (i ? { ...b, parent: "master" } : b)) });
    const bottom = (bus: string): unknown => (one(render({ strip: stripOf(r, bus), model: r.model }), byClass("mixer-fader-thumb")).props.style as { bottom: string }).bottom;
    expect(bottom("a")).toBe("75%");
    expect(bottom("b")).toBe("0%");
    expect(bottom("c")).toBe("100%");
    expect(one(render({ strip: stripOf(r, "a"), model: r.model }), byClass("mixer-fader-unity")).props.style).toEqual({ bottom: "75%" });
    expect(one(render({ strip: stripOf(r, "c"), model: r.model }), byClass("mixer-gain")).props["data-max-db"]).toBe(Math.round(FADER_MAX_DB * 1000) / 1000);
  });

  it("the root strip is marked, an idle (not playing) strip shows no effective gain", () => {
    const r = rig();
    const root = render({ strip: stripOf(r, "master"), model: r.model });
    expect(byClass("root")(root as Node)).toBe(true);
    const idle = render({ strip: stripOf(r, "sfx", null), model: r.model });
    expect(byClass("idle")(idle as Node)).toBe(true);
    expect(text(one(idle, byClass("mixer-gain-effective")))).toBe("eff -");
    expect(text(one(idle, byClass("mixer-gain-authored")))).toBe("0.0 dB");
  });

  it("effective gain differs from the authored value when a lane up the tree or a duck changes it", () => {
    const r = rig();
    const tree = render({ strip: stripOf(r, "sfx", reading({ effectiveGain: 0.5 * 0.4 })), model: r.model });
    expect(text(one(tree, byClass("mixer-gain-authored")))).toBe("0.0 dB");
    expect(text(one(tree, byClass("mixer-gain-effective")))).toBe("eff -14.0 dB");
  });
});

describe("the fader gesture", () => {
  it("a drag previews every move, commits once on release, and follows the taper", () => {
    const r = rig();
    const changes = { n: 0 };
    const h = faderOf(r, "sfx", changes);
    const t = newTrack();
    h().onPointerDown(pointer(t, 100));
    expect(t.captured).toEqual([7]);
    expect(t.focused).toBe(1);
    expect(r.model.dragging).toEqual({ bus: "sfx", value: 1 });
    // up 10% of the travel from unity (0.75) = position 0.85
    for (const y of [95, 92, 90]) h().onPointerMove(pointer(t, y));
    expect(r.applied).toHaveLength(3);
    expect(r.flushes()).toBe(3);
    expect(r.commits).toEqual([]);
    expect((r.applied.at(-1) as { value: number }).value).toBe(positionToGain(0.85));
    h().onPointerUp(pointer(t, 90));
    expect(r.commits).toEqual(["Set sfx volume"]);
    expect(r.volume("sfx")).toBe(positionToGain(0.85));
    expect(t.released).toEqual([7]);
    expect(r.model.dragging).toBeNull();
    expect(changes.n).toBe(5); // down, three moves, up
  });

  it("the strip shows the previewed value while dragging", () => {
    const r = rig();
    const h = faderOf(r, "sfx", { n: 0 });
    h().onPointerDown(pointer(newTrack(), 100));
    h().onPointerMove(pointer(newTrack(), 50));
    const s = stripOf(r, "sfx");
    expect(s.dragging).toBe(true);
    const tree = render({ strip: s, model: r.model });
    expect(byClass("dragging")(tree as Node)).toBe(true);
    expect((one(tree, byClass("mixer-fader-thumb")).props.style as { bottom: string }).bottom).toBe("100%");
    expect(text(one(tree, byClass("mixer-gain-authored")))).toBe("+6.0 dB"); // pinned at the top
  });

  it("fine drag (shift) moves a tenth as far; a modifier change mid-drag rebases without a jump", () => {
    const r = rig();
    const h = faderOf(r, "sfx", { n: 0 });
    const t = newTrack();
    h().onPointerDown(pointer(t, 100, { shiftKey: true }));
    h().onPointerMove(pointer(t, 50, { shiftKey: true })); // half the travel x 0.1 = +0.05
    expect((r.applied.at(-1) as { value: number }).value).toBe(positionToGain(0.8));
    // release shift: the thumb stays at 0.8 and the next 10% of travel adds 0.1
    h().onPointerMove(pointer(t, 50, { shiftKey: false }));
    expect((r.applied.at(-1) as { value: number }).value).toBe(positionToGain(0.8));
    h().onPointerMove(pointer(t, 40, { shiftKey: false }));
    expect((r.applied.at(-1) as { value: number }).value).toBeCloseTo(positionToGain(0.9), 12);
    h().onPointerUp(pointer(t, 40));
    expect(r.commits).toHaveLength(1);
  });

  it("a normal drag moves the full travel (the same distance as fine is ten times longer)", () => {
    const r = rig();
    const h = faderOf(r, "sfx", { n: 0 });
    const t = newTrack();
    h().onPointerDown(pointer(t, 100));
    h().onPointerMove(pointer(t, 50));
    expect((r.applied.at(-1) as { value: number }).value).toBe(positionToGain(1)); // 0.75 + 0.5 clamps to the top
  });

  it("snaps to exactly unity near it", () => {
    const r = rig();
    const h = faderOf(r, "music", { n: 0 }); // starts at 0.5
    const t = newTrack();
    h().onPointerDown(pointer(t, 100));
    // music is at gain 0.5 = position 0.6747; +0.065 lands at 0.7397, within 0.02 of unity
    h().onPointerMove(pointer(t, 100 - 6.5));
    expect((r.applied.at(-1) as { value: number }).value).toBe(1);
  });

  it("Escape cancels: the start value goes back through the preview and nothing is committed", () => {
    const r = rig();
    const changes = { n: 0 };
    const h = faderOf(r, "music", changes);
    const t = newTrack();
    h().onPointerDown(pointer(t, 100));
    h().onPointerMove(pointer(t, 20));
    expect((r.applied.at(-1) as { value: number }).value).not.toBe(0.5);
    let prevented = 0;
    h().onKeyDown({ key: "Escape", preventDefault: () => void prevented++ } as never);
    expect(r.applied.at(-1)).toEqual({ op: "setBus", bus: "music", key: "volume", value: 0.5 });
    expect(r.commits).toEqual([]);
    expect(r.model.dragging).toBeNull();
    expect(prevented).toBe(1);
    // the late pointerup after the cancel does nothing
    h().onPointerUp(pointer(t, 20));
    expect(r.commits).toEqual([]);
    // another key during a drag is ignored
    h().onPointerDown(pointer(t, 100));
    h().onKeyDown({ key: "a" } as never);
    expect(r.model.dragging).not.toBeNull();
  });

  it("a cancelled pointer (pointercancel) cancels like Escape", () => {
    const r = rig();
    const h = faderOf(r, "sfx", { n: 0 });
    const t = newTrack();
    h().onPointerDown(pointer(t, 100));
    h().onPointerMove(pointer(t, 60));
    h().onPointerCancel(pointer(t, 60));
    expect(r.commits).toEqual([]);
    expect(r.applied.at(-1)).toEqual({ op: "setBus", bus: "sfx", key: "volume", value: 1 });
    expect(t.released).toEqual([7]);
  });

  it("a press and release without a move commits nothing; a secondary button doesn't start a drag; a move with no drag does nothing", () => {
    const r = rig();
    const h = faderOf(r, "sfx", { n: 0 });
    const t = newTrack();
    h().onPointerDown(pointer(t, 100, { button: 2 }));
    expect(r.model.dragging).toBeNull();
    h().onPointerMove(pointer(t, 50));
    expect(r.applied).toEqual([]);
    h().onPointerDown(pointer(t, 100));
    h().onPointerUp(pointer(t, 100));
    expect(r.commits).toEqual([]);
    expect(r.applied).toEqual([]);
  });

  it("double-click sets unity in one commit, and does nothing when already at unity", () => {
    const r = rig();
    const changes = { n: 0 };
    faderOf(r, "music", changes)().onDblClick();
    expect(r.commits).toEqual(["Set music volume"]);
    expect(r.volume("music")).toBe(1);
    expect(changes.n).toBe(1);
    faderOf(r, "music", changes)().onDblClick();
    expect(r.commits).toHaveLength(1);
    expect(changes.n).toBe(1);
  });

  it("the handlers are wired onto the slider element", () => {
    const r = rig();
    const tree = render({ strip: stripOf(r, "sfx"), model: r.model });
    const fader = one(tree, (n) => n.props.role === "slider");
    for (const k of ["onPointerDown", "onPointerMove", "onPointerUp", "onPointerCancel", "onKeyDown", "onDblClick"]) expect(typeof fader.props[k]).toBe("function");
    // through the element's own handlers: a full drag and a release
    const t = newTrack();
    fn<(e: never) => void>(fader, "onPointerDown")(pointer(t, 100));
    fn<(e: never) => void>(fader, "onPointerMove")(pointer(t, 90));
    fn<(e: never) => void>(fader, "onPointerUp")(pointer(t, 90));
    expect(r.commits).toEqual(["Set sfx volume"]);
  });
});

describe("mute and solo", () => {
  it("mute commits the authored value, both ways, and reflects the strip's state", () => {
    const r = rig();
    const changes = { n: 0 };
    const click = (): void => {
      const tree = render({ strip: stripOf(r, "sfx"), model: r.model, onChange: () => void changes.n++ });
      fn<() => void>(one(tree, byLabel("Mute sfx")), "onClick")();
    };
    click();
    expect(r.commits).toEqual(["Mute sfx"]);
    const muted = render({ strip: stripOf(r, "sfx"), model: r.model });
    const btn = one(muted, byLabel("Mute sfx"));
    expect(btn.props["aria-pressed"]).toBe(true);
    expect(byClass("on")(btn)).toBe(true);
    expect(byClass("muted")(muted as Node)).toBe(true);
    click();
    expect(r.commits).toEqual(["Mute sfx", "Unmute sfx"]);
    expect(one(render({ strip: stripOf(r, "sfx"), model: r.model }), byLabel("Mute sfx")).props["aria-pressed"]).toBe(false);
    expect(changes.n).toBe(2);
  });

  it("a script mute is shown apart from the authored one", () => {
    const r = rig();
    const btn = one(render({ strip: stripOf(r, "sfx", reading({ runtimeMute: true })), model: r.model }), byLabel("Mute sfx"));
    expect(btn.props["aria-pressed"]).toBe(false);
    expect(byClass("script")(btn)).toBe(true);
  });

  it("solo goes to the monitor, both ways, and never commits", () => {
    const r = rig();
    const changes = { n: 0 };
    const press = (read: BusReading): void => {
      const tree = render({ strip: stripOf(r, "sfx", read), model: r.model, onChange: () => void changes.n++ });
      fn<() => void>(one(tree, byLabel("Solo sfx")), "onClick")();
    };
    press(reading());
    press(reading({ monitorSolo: true }));
    expect(r.monitors).toEqual([["sfx", { solo: true }], ["sfx", { solo: false }]]);
    expect(r.commits).toEqual([]);
    expect(r.applied).toEqual([]);
    const on = one(render({ strip: stripOf(r, "sfx", reading({ monitorSolo: true })), model: r.model }), byLabel("Solo sfx"));
    expect(on.props["aria-pressed"]).toBe(true);
    expect(byClass("on")(on)).toBe(true);
    expect(changes.n).toBe(2);
  });

  it("a script solo is shown apart from the monitor's", () => {
    const r = rig();
    const btn = one(render({ strip: stripOf(r, "sfx", reading({ solo: true })), model: r.model }), byLabel("Solo sfx"));
    expect(btn.props["aria-pressed"]).toBe(false);
    expect(byClass("script")(btn)).toBe(true);
  });
});

describe("the peak meter", () => {
  const meterTree = (r: ReturnType<typeof rig>, peak: number, hold: number, clipLatched: boolean, onResetClip?: (b: string) => void) =>
    render({ strip: stripOf(r, "sfx", reading({ peak }), { peak, hold, clipLatched }), model: r.model, onResetClip });

  it("draws the bar with BusMeters' scale, elements and hot class", () => {
    expect(meterFillFromView).toBe(meterFill); // the one drawing function
    const r = rig();
    const bar = (peak: number): Node => one(meterTree(r, peak, peak, false), byClass("audio-meter-fill"));
    for (const peak of [0, 0.001, 0.1, 0.5, 0.99]) {
      expect(bar(peak).props.style).toEqual({ transform: `scaleY(${Math.round(meterFill(peak) * 1000) / 1000})` });
      expect(byClass("hot")(bar(peak))).toBe(false);
    }
    expect(bar(1).props.style).toEqual({ transform: "scaleY(1)" });
    expect(byClass("hot")(bar(1))).toBe(true);
    expect(byClass("hot")(bar(3))).toBe(true);
    const track = one(meterTree(r, 0.5, 0.5, false), byClass("audio-meter-track"));
    expect(track.props.role).toBe("meter");
    expect(track.props["aria-valuemin"]).toBe(METER_FLOOR_DB);
    expect(track.props["aria-valuenow"]).toBe(-6);
  });

  it("the hold marker sits at the held peak and hides when nothing is held", () => {
    const r = rig();
    const marker = (hold: number): Node => one(meterTree(r, 0.1, hold, false), byClass("mixer-peak-hold"));
    expect(marker(0.5).props.style).toEqual({ bottom: `${Math.round(meterFill(0.5) * 10000) / 100}%` });
    expect(marker(0.5).props.hidden).toBe(false);
    expect(marker(0).props.hidden).toBe(true);
  });

  it("holds, latches and clears through meterModel's states, which the strip carries", () => {
    const r = rig();
    let m = createMeter();
    m = tickMeter(m, 1.2, 0); // over: latches
    m = tickMeter(m, 0.2, 100);
    const shown = (state: typeof m, peak: number) => {
      const rd = readMeter(state, peak);
      return one(meterTree(r, peak, state.hold, state.clipped), byClass("mixer-peak")) && { rd, lamp: one(meterTree(r, peak, state.hold, state.clipped), byLabel("sfx clip")) };
    };
    const a = shown(m, 0.2);
    expect(a.rd.clipped).toBe(true);
    expect(a.lamp.props["aria-pressed"]).toBe(true);
    expect(byClass("latched")(a.lamp)).toBe(true);
    expect(one(meterTree(r, 0.2, m.hold, m.clipped), byClass("mixer-peak-hold")).props.style).toEqual({ bottom: "100%" }); // the held 1.2
    m = resetClip(m);
    const b = shown(m, 0.2);
    expect(b.lamp.props["aria-pressed"]).toBe(false);
    expect(byClass("latched")(b.lamp)).toBe(false);
    expect(m.hold).toBe(1.2); // the hold survives the latch reset
  });

  it("a click on the lamp or on the meter clears the clip latch of that bus", () => {
    const r = rig();
    const cleared: string[] = [];
    const tree = meterTree(r, 0.2, 1, true, (b) => void cleared.push(b));
    fn<() => void>(one(tree, byLabel("sfx clip")), "onClick")();
    fn<() => void>(one(tree, byLabel("sfx level")), "onClick")();
    expect(cleared).toEqual(["sfx", "sfx"]);
    // no handler given: a click is harmless
    fn<() => void>(one(meterTree(r, 0.2, 1, true), byLabel("sfx clip")), "onClick")();
  });
});

describe("loudness readouts and the target line", () => {
  const strip = (bus: string, l: BusLoudness): Strip => stripOf(rig(), bus, reading({ loudness: l }));
  const rows = (tree: unknown): Record<string, string> => Object.fromEntries(find(tree, byClass("mixer-lufs-row")).map((n) => [n.props["data-reading"] as string, text(n.props.children).slice(1)]));
  const view = (s: Strip): VNode => render({ strip: s, model: rig().model });

  it("momentary, short-term and integrated on a metered bus", () => {
    expect(rows(view(strip("music", loud())))).toEqual({ momentary: "-20.0", shortTerm: "-22.0", integrated: "-23.0" });
  });

  it("integrated and the target are shown only on metered buses; the bus is marked not metered", () => {
    const s = strip("sfx", loud({ metered: false, target: target("ok") }));
    expect(s.metered).toBe(false);
    const tree = view(s);
    expect(Object.keys(rows(tree))).toEqual(["momentary", "shortTerm"]);
    expect(find(tree, byClass("mixer-target"))).toHaveLength(0);
    expect(byClass("unmetered")(one(tree, byClass("mixer-lufs")))).toBe(true);
  });

  it("the root bus is always metered", () => {
    const tree = view(strip("master", loud()));
    expect(Object.keys(rows(tree))).toEqual(["momentary", "shortTerm", "integrated"]);
  });

  it("gated and empty readings read -inf, never NaN", () => {
    expect(rows(view(strip("music", loud({ momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity }))))).toEqual({ momentary: "-inf", shortTerm: "-inf", integrated: "-inf" });
    expect(formatLufs(-Infinity)).toBe("-inf");
    expect(formatLufs(NaN)).toBe("-inf");
    expect(formatLufs(-0.04)).toBe("0.0");
    expect(formatLufs(-23.06)).toBe("-23.1");
  });

  it("no target line without a target, and one per state when there is one", () => {
    expect(find(view(strip("music", loud({ target: null }))), byClass("mixer-target"))).toHaveLength(0);
    for (const state of ["waiting", "ok", "high", "low", "suspended"] as const) {
      const tree = view(strip("music", loud({ target: target(state) })));
      const el = one(tree, byClass("mixer-target"));
      expect(byClass(state)(el)).toBe(true);
      expect(String(el.props.title)).toContain(state);
    }
  });

  it("the target line sits at the goal on the LUFS scale with the tolerance band around it, and the bar follows short-term", () => {
    const tree = view(strip("music", loud({ shortTerm: -30, target: target("low", { integrated: -24, tolerance: 2 }) })));
    const marks = targetMarks(target("ok"));
    expect(marks.line).toBeCloseTo(0.6, 12);
    expect(marks.low).toBeCloseTo(34 / 60, 12);
    expect(marks.high).toBeCloseTo(38 / 60, 12);
    expect(one(tree, byClass("mixer-target-line")).props.style).toEqual({ left: "60%" });
    expect(one(tree, byClass("mixer-target-band")).props.style).toEqual({ left: "56.67%", width: "6.67%" });
    expect(one(tree, byClass("mixer-target-fill")).props.style).toEqual({ transform: "scaleX(0.5)" });
    expect(one(tree, byClass("mixer-target")).props["aria-valuenow"]).toBe(-30);
  });

  it("the LUFS scale clamps", () => {
    expect(lufsFill(-Infinity)).toBe(0);
    expect(lufsFill(-60)).toBe(0);
    expect(lufsFill(-90)).toBe(0);
    expect(lufsFill(-30)).toBe(0.5);
    expect(lufsFill(0)).toBe(1);
    expect(lufsFill(6)).toBe(1);
  });
});

describe("the gain-reduction meter", () => {
  const r = rig();
  const tree = (read: BusReading | null, levelDucked?: boolean): VNode => render({ strip: stripOf(r, "music", read), model: r.model, levelDucked });

  it("is absent on a bus nothing ducks", () => {
    expect(find(tree(reading()), byClass("mixer-gr"))).toHaveLength(0);
    expect(find(tree(null), byClass("mixer-gr"))).toHaveLength(0);
  });

  it("shows on a level-ducked bus even at rest, as 0.0 dB", () => {
    const t = tree(reading(), true);
    expect(text(one(t, byClass("mixer-gr-readout")))).toBe("0.0");
    expect(one(t, byClass("mixer-gr-fill")).props.style).toEqual({ transform: "scaleY(0)" });
  });

  it("reads the duck gain: 0.5 is 6.0 dB of reduction, shown as a share of the scale", () => {
    const t = tree(reading({ duckGain: 0.5 }), true);
    expect(text(one(t, byClass("mixer-gr-readout")))).toBe("-6.0");
    expect(one(t, byLabel("music gain reduction")).props["aria-valuenow"]).toBe(6);
    expect(one(t, byClass("mixer-gr-fill")).props.style).toEqual({ transform: `scaleY(${Math.round((6.0206 / GAIN_REDUCTION_MAX_DB) * 1000) / 1000})` });
  });

  it("appears by itself when the live duck gain is under 1, and saturates", () => {
    expect(find(tree(reading({ duckGain: 0.9 })), byClass("mixer-gr"))).toHaveLength(1);
    expect(one(tree(reading({ duckGain: 0.001 }), true), byClass("mixer-gr-fill")).props.style).toEqual({ transform: "scaleY(1)" });
    expect(gainReductionDb(0)).toBe(99);
    expect(gainReductionDb(1)).toBe(0);
    expect(gainReductionDb(1.5)).toBe(0);
    expect(gainReductionDb(NaN)).toBe(0);
  });
});

describe("theme tokens only", () => {
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\blab\(|\blch\(|\boklch\(|\boklab\(|\bcolor\(/;
  const NAMED = /:\s*(?:white|black|red|green|blue|yellow|orange|gray|grey|cyan|magenta|purple|pink|brown)\b/i;
  for (const file of ["MixerStrip.tsx", "stripStyle.css"]) {
    it(`${file} holds no colour literal and every var() is a theme token`, () => {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(LITERAL);
      expect(code).not.toMatch(NAMED);
      const css = readFileSync(new URL("../../../../editor/ui/editor.css", import.meta.url), "utf8");
      const tokens = new Set([...css.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]));
      for (const m of src.matchAll(/var\((--[\w-]+)/g)) expect(tokens.has(m[1]!), m[1]).toBe(true);
    });
  }
});

describe("the meter model stays pure (W6 follow-up)", () => {
  const imports = (file: string): string[] => [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]!);
  it("meterModel.ts imports meterFill.ts, not the Preact view, and meterFill.ts imports nothing", () => {
    expect(imports("./meterModel.ts")).toEqual(["../meterFill"]);
    expect(imports("../meterFill.ts")).toEqual([]);
  });
  it("BusMeters re-exports the same function and floor", () => {
    expect(meterFillFromView).toBe(meterFill);
    expect(METER_FLOOR_DB).toBe(-60);
  });
});

describe("a model is shared by every strip", () => {
  it("one drag at a time: a second strip's press doesn't start while the first is open", () => {
    const r = rig();
    const t = newTrack();
    const a = faderOf(r, "sfx", { n: 0 });
    const b = faderOf(r, "music", { n: 0 });
    a().onPointerDown(pointer(t, 100));
    b().onPointerDown(pointer(t, 100));
    b().onPointerMove(pointer(t, 50)); // not b's gesture
    expect(r.applied).toEqual([]);
    a().onPointerMove(pointer(t, 90));
    expect(r.applied.map((o) => (o as { bus: string }).bus)).toEqual(["sfx"]);
    a().onPointerUp(pointer(t, 90));
    expect(r.commits).toEqual(["Set sfx volume"]);
  });

  it("the monitor-mute button: labelled apart from Mute, reflects the strip, calls the model and never commits", () => {
    const r = rig();
    const calls: string[] = [];
    const model: MixerStripProps["model"] = { ...r.model, toggleMonitorMute: (bus) => (calls.push(bus), true) };
    const changes = { n: 0 };
    const tree = render({ strip: stripOf(r, "sfx"), model, onChange: () => void changes.n++ });
    const btn = one(tree, byLabel("Monitor mute sfx"));
    expect(btn.props["aria-pressed"]).toBe(false);
    expect(one(tree, byLabel("Mute sfx")).props["aria-pressed"]).toBe(false); // the authored mute is a different button
    fn<() => void>(btn, "onClick")();
    expect(calls).toEqual(["sfx"]);
    expect(changes.n).toBe(1);
    expect(r.commits).toEqual([]);
    const on = render({ strip: stripOf(r, "sfx", { ...reading(), monitorMute: true }), model });
    expect(one(on, byLabel("Monitor mute sfx")).props["aria-pressed"]).toBe(true);
    expect(find(on, byClass("monitor-muted"))).toHaveLength(1);
  });

  it("a refused monitor mute (no Play) does not re-render; without the model method there is no button", () => {
    const r = rig();
    const changes = { n: 0 };
    const refusing: MixerStripProps["model"] = { ...r.model, toggleMonitorMute: () => false };
    fn<() => void>(one(render({ strip: stripOf(r, "sfx"), model: refusing, onChange: () => void changes.n++ }), byLabel("Monitor mute sfx")), "onClick")();
    expect(changes.n).toBe(0);
    expect(find(render({ strip: stripOf(r, "sfx"), model: r.model }), byLabel("Monitor mute sfx"))).toHaveLength(0);
  });

  it("buildStrips and MixerStrip agree for a strip built without the model", () => {
    const { settings } = parseAudioSettings(AUDIO);
    const [root] = buildStrips(settings, () => reading({ effectiveGain: 2 }));
    const model = { beginDrag: () => false, drag() {}, endDrag: () => false, cancelDrag() {}, setVolume: () => false, toggleMute: () => false, toggleSolo() {}, dragging: null } satisfies Pick<MixerModel, "beginDrag" | "drag" | "endDrag" | "cancelDrag" | "setVolume" | "toggleMute" | "toggleSolo" | "dragging">;
    expect(text(one(render({ strip: root!, model }), byClass("mixer-gain-effective")))).toBe("eff +6.0 dB");
  });
});
