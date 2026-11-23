// The Mixer's automation in the shared curve editor, through its model: the dialog a bus or return opens (one lane per
// automatable property, each driven by a game parameter; log for Hz) and its result written back as one edit.
import { describe, expect, it } from "vitest";
import { createDraft, draftResult, withLane, type CurveEditorResult } from "../../../editor/ui/curves/curveEditorModel";
import { setBy, setByMode, writeLayer } from "../../../editor/ui/curves/andByModel";
import { audioProjectToJson, parseAudioProject } from "../../../engine/audio/project/format";
import type { AudioProject } from "../../../engine/audio/project/types";
import { setParameterHistogramSource } from "../curveInputs";
import { applyAutomationResult, automationDialog, type AutomationDialog } from "./automationCurves";
import type { EditResult } from "./busTree";
import { emptyMix, mixerFixture } from "./mixerFixture";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const refused = <T>(r: EditResult<T>): string => ("refused" in r ? r.refused : "accepted");
/** What Apply returns when nothing in the dialog was touched. */
const untouched = (d: AutomationDialog): CurveEditorResult => draftResult(d.spec, createDraft(d.spec));
const valid = (p: AudioProject) => expect(parseAudioProject(audioProjectToJson(p)).problems).toEqual([]);

describe("Mixer automation in the curve editor", () => {
  it("opens a parameter dialog with every automatable lane of the bus, the asked-for one selected", () => {
    const p = mixerFixture();
    const d = ok(automationDialog(p, "Ambience", "fx:fx1", { depth: 12 }));
    expect(d.spec.kind).toBe("parameter");
    expect(d.title).toBe("Bus curves");
    expect(d.spec.lanes.map((l) => l.name)).toEqual(["Level", "Send to Reverb", "Low-pass cutoff", "Low-pass resonance", "Low-pass drive"]);
    expect(d.initialLane).toBe("fx:fx1:cutoff");
    const cutoff = d.spec.lanes.find((l) => l.id === "fx:fx1:cutoff")!;
    expect(cutoff).toMatchObject({ unit: "Hz", scale: "log", input: "param:depth", base: 20000 });
    // Each lane has its own driver; unautomated lanes start on the first parameter.
    expect(d.spec.lanes.find((l) => l.id === "volume")!.input).toBe("param:threat");
    expect(d.spec.lanes.find((l) => l.id === "send:Reverb")!.input).toBeUndefined();
    expect(d.spec.inputs!.find((i) => i.id === "param:depth")).toMatchObject({ min: 0, max: 30, now: 12 });
    expect(d.spec.inputs!.find((i) => i.id === "param:combat")).toMatchObject({ name: "combat (labels)", min: 0, max: 1 });
    expect(ok(automationDialog(p, "Reverb", "volume")).title).toBe("Return curves");
  });

  it("is refused without game parameters, or on a name that isn't a bus or return", () => {
    expect(refused(automationDialog(emptyMix(), "Master", "volume"))).toMatch(/no game parameters/);
    expect(refused(automationDialog(mixerFixture(), "Gameplay SFX", undefined))).toMatch(/isn't a bus or return/);
  });

  it("tells twin effects apart by id", () => {
    const p = mixerFixture();
    const twin = { ...p, buses: p.buses.map((b) => (b.name === "Music" ? { ...b, effects: [{ id: "fx1", type: "lowpass" as const, on: true, params: {} }, { id: "fx2", type: "lowpass" as const, on: true, params: {} }] } : b)) };
    expect(ok(automationDialog(twin, "Music", undefined)).spec.lanes.map((l) => l.name).slice(1, 2)).toEqual(["Low-pass (fx1) cutoff"]);
  });

  it("an untouched Apply changes nothing", () => {
    const p = mixerFixture();
    const d = ok(automationDialog(p, "Ambience", undefined));
    expect(ok(applyAutomationResult(p, d, untouched(d)))).toBeNull();
  });

  it("writes only the lanes that changed, as one edit labelled by the lane", () => {
    const p = mixerFixture();
    const d = ok(automationDialog(p, "Music", "volume"));
    const draft = createDraft(d.spec);
    const edited = withLane(draft, "volume", { curve: [[0, 0], [0.5, -2, "smooth"], [1, -6]] });
    const r = ok(applyAutomationResult(p, d, draftResult(d.spec, edited)))!;
    expect(r.label).toBe("Automate Level · Music");
    expect(r.project.automation.find((a) => a.on === "Music" && a.target === "volume")!.curve).toEqual([[0, 0], [0.5, -2, "smooth"], [1, -6]]);
    expect(r.project.automation.length).toBe(p.automation.length);
    valid(r.project);
  });

  it("adds a lane driven by its own parameter, and labels a many-lane Apply by the bus", () => {
    const p = mixerFixture();
    const d = ok(automationDialog(p, "Ambience", undefined));
    let draft = createDraft(d.spec);
    draft = withLane(draft, "send:Reverb", { input: "param:health", curve: [[0, -20], [100, 0]] });
    draft = withLane(draft, "fx:fx1:cutoff", { bypass: true });
    const r = ok(applyAutomationResult(p, d, draftResult(d.spec, draft)))!;
    expect(r.label).toBe("Edit Ambience curves");
    expect(r.project.automation.find((a) => a.target === "send:Reverb")).toMatchObject({ on: "Ambience", parameter: "health", bypass: false });
    expect(r.project.automation.find((a) => a.target === "fx:fx1:cutoff")!.bypass).toBe(true);
    valid(r.project);
  });

  it("a flat lane that isn't bypassed removes the automation", () => {
    const p = mixerFixture();
    const d = ok(automationDialog(p, "Music", "volume"));
    const draft = withLane(createDraft(d.spec), "volume", { curve: [[0, -3], [1, -3]] });
    const r = ok(applyAutomationResult(p, d, draftResult(d.spec, draft)))!;
    expect(r.label).toBe("Automate Level · Music");
    expect(r.project.automation.some((a) => a.on === "Music")).toBe(false);
  });

  it("refuses a lane driven by something that isn't a game parameter", () => {
    const p = mixerFixture();
    const d = ok(automationDialog(p, "Music", "volume"));
    const result = draftResult(d.spec, createDraft(d.spec));
    const bad: CurveEditorResult = { ...result, lanes: result.lanes.map((l) => (l.id === "volume" ? { ...l, input: "time", curve: [[0, 0], [1, -6]] } : l)) };
    expect(refused(applyAutomationResult(p, d, bad))).toMatch(/must be driven by a game parameter/);
  });

  it("passes the histogram of the first lane's parameter only while a take provides one", () => {
    const p = mixerFixture();
    expect(ok(automationDialog(p, "Music", "volume")).histogram).toBeUndefined();
    const stop = setParameterHistogramSource((name, range) => (name === "threat" ? [range[0], 1, 2, range[1]] : null));
    try {
      expect(ok(automationDialog(p, "Music", "volume")).histogram).toEqual([0, 1, 2, 1]);
      expect(ok(automationDialog(p, "Ambience", "fx:fx1")).histogram).toBeUndefined();
    } finally {
      stop();
    }
    expect(ok(automationDialog(p, "Music", "volume")).histogram).toBeUndefined();
  });
});

describe("And by: a lane's second global parameter (ADR 0362 §5)", () => {
  it("offers the global parameters as second inputs, labelled ones with their labels", () => {
    const d = ok(automationDialog(mixerFixture(), "Music", "volume", { health: 40 }));
    const seconds = d.spec.secondInputs!;
    expect(seconds.map((s) => s.id)).toContain("param:health");
    expect(seconds.find((s) => s.id === "param:health")).toMatchObject({ min: 0, max: 100, now: 40 });
    expect(seconds.find((s) => s.id === "param:gameState")!.labels).toEqual(["Playing", "Paused", "Cutscene", "Loading"]);
  });

  it("Apply writes the lane's second input as one edit; it reopens with it and an untouched Apply changes nothing", () => {
    const p = mixerFixture();
    const d = ok(automationDialog(p, "Music", "volume"));
    let draft = setBy(d.spec, createDraft(d.spec), "volume", "param:gameState");
    draft = writeLayer(draft, "volume", "label:Paused", [[0, -20], [1, -20]]);
    const r = ok(applyAutomationResult(p, d, draftResult(d.spec, draft)))!;
    expect(r.label).toBe("Automate Level · Music");
    const lane = r.project.automation.find((a) => a.on === "Music" && a.target === "volume")!;
    expect(lane).toMatchObject({ parameter: "threat", curve: [[0, 0], [1, -3, "easeOut"]], by: { input: "gameState", mode: "labels", labels: { Paused: [[0, -20], [1, -20]] } } });
    valid(r.project);
    const again = ok(automationDialog(r.project, "Music", "volume"));
    expect(again.spec.lanes.find((l) => l.id === "volume")!.by).toEqual({ input: "param:gameState", mode: "labels", labels: { Paused: [[0, -20], [1, -20]] } });
    expect(ok(applyAutomationResult(r.project, again, untouched(again)))).toBeNull();
    // "Nothing" takes it off again.
    const off = setBy(again.spec, createDraft(again.spec), "volume", null);
    expect(ok(applyAutomationResult(r.project, again, draftResult(again.spec, off)))!.project.automation.find((a) => a.on === "Music")!.by).toBeUndefined();
  });

  it("a flat lane that follows a second parameter is kept (its High curve isn't flat)", () => {
    const p = mixerFixture();
    const d = ok(automationDialog(p, "Music", "volume"));
    let draft = withLane(createDraft(d.spec), "volume", { curve: [[0, -3], [1, -3]] });
    draft = setByMode(d.spec, setBy(d.spec, draft, "volume", "param:health"), "volume", "morph");
    draft = writeLayer(draft, "volume", "high", [[0, -12], [1, 0]]);
    const r = ok(applyAutomationResult(p, d, draftResult(d.spec, draft)))!;
    expect(r.project.automation.find((a) => a.on === "Music")).toMatchObject({ curve: [[0, -3], [1, -3]], by: { input: "health", mode: "morph", curve: [[0, -12], [1, 0]] } });
    valid(r.project);
  });
});
