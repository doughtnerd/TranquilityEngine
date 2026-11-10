import { describe, expect, it } from "vitest";
import { MAX_LOCAL_PARAMETERS, emptyAudioEvent, parseAudioEvent, formatAudioEvent, type AudioEventAsset, type LabelledParameter, type NumericParameter, type SwitchNode } from "../../../../engine/audio/eventFormat";
import { newNode } from "./eventTree";
import {
  addParameter,
  auditionValues,
  freeParameterName,
  parameterNameProblem,
  removeParameter,
  renameParameterAt,
  setLabels,
  toggleLabelled,
  updateNumeric,
} from "./eventParameters";

const speed: NumericParameter = { name: "Speed", min: 0, max: 10, default: 2, seekSpeed: 5 };
const surface: LabelledParameter = { name: "Surface", labels: ["Grass", "Stone"], default: "Stone" };

describe("eventParameters", () => {
  it("freeParameterName and addParameter make unique names and stop at the limit", () => {
    expect(freeParameterName(["Parameter", "Parameter 2"])).toBe("Parameter 3");
    let e = emptyAudioEvent();
    e = addParameter(addParameter(e));
    expect(e.parameters.map((p) => p.name)).toEqual(["Parameter", "Parameter 2"]);
    for (let i = 0; i < 20; i++) e = addParameter(e);
    expect(e.parameters).toHaveLength(MAX_LOCAL_PARAMETERS);
    // what it writes reads back unchanged
    expect(parseAudioEvent(JSON.parse(formatAudioEvent(e))).value.parameters).toEqual(e.parameters);
  });

  it("removeParameter and parameterNameProblem", () => {
    const e: AudioEventAsset = { ...emptyAudioEvent(), parameters: [speed, surface] };
    expect(removeParameter(e, 0).parameters).toEqual([surface]);
    expect(parameterNameProblem(e.parameters, 0, " ")).toMatch(/needs a name/);
    expect(parameterNameProblem(e.parameters, 0, "Surface")).toMatch(/another/);
    expect(parameterNameProblem(e.parameters, 0, "Speed")).toBeNull();
  });

  it("renameParameterAt renames uses and refuses a taken name", () => {
    const sw: SwitchNode = { ...(newNode("switch") as SwitchNode), parameter: "Surface" };
    const e: AudioEventAsset = { ...emptyAudioEvent(), parameters: [speed, surface], root: sw };
    const r = renameParameterAt(e, 1, " Ground ");
    expect(r.parameters[1].name).toBe("Ground");
    expect((r.root as SwitchNode).parameter).toBe("Ground");
    expect(renameParameterAt(e, 1, "Speed")).toBe(e);
  });

  it("toggleLabelled converts both ways", () => {
    expect(toggleLabelled(speed)).toEqual({ name: "Speed", labels: ["A", "B"], default: "A" });
    expect(toggleLabelled(surface)).toEqual({ name: "Surface", min: 0, max: 1, default: 1, seekSpeed: 0 });
  });

  it("updateNumeric keeps min <= default <= max and seek >= 0", () => {
    expect(updateNumeric(speed, { min: 20 })).toEqual({ ...speed, min: 20, max: 20, default: 20 });
    expect(updateNumeric(speed, { max: 1 })).toEqual({ ...speed, max: 1, default: 1 });
    expect(updateNumeric(speed, { default: -3, seekSpeed: -1 })).toEqual({ ...speed, default: 0, seekSpeed: 0 });
    expect(updateNumeric(speed, { min: NaN })).toEqual(speed);
  });

  it("setLabels parses, dedupes, keeps or resets the default, ignores empty", () => {
    expect(setLabels(surface, " Grass, Mud ,, Grass")).toEqual({ name: "Surface", labels: ["Grass", "Mud"], default: "Grass" });
    expect(setLabels(surface, "Stone, Ice")).toEqual({ name: "Surface", labels: ["Stone", "Ice"], default: "Stone" });
    expect(setLabels(surface, " , ")).toBe(surface);
  });

  it("auditionValues keeps valid values and falls back to defaults", () => {
    expect(auditionValues([speed, surface], { Speed: 4, Surface: "Grass", Gone: 1 })).toEqual({ Speed: 4, Surface: "Grass" });
    expect(auditionValues([speed, surface], { Speed: 40, Surface: "Mud" })).toEqual({ Speed: 2, Surface: "Stone" });
  });
});
