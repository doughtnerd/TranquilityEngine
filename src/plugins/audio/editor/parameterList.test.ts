// ADR 0304: the one parameter list, its rules run once per holder (an event's own parameters, the project's global
// ones), each checked against the parse that reads the list back; then what each holder's rename and remove carry along.
import { describe, expect, it } from "vitest";
import {
  MAX_LOCAL_PARAMETERS,
  MAX_PARAMETERS,
  emptyAudioEvent,
  formatAudioEvent,
  parseAudioEvent,
  parseParameters,
  type AudioEventAsset,
  type ParameterDef,
  type SwitchNode,
} from "../../../engine/audio/eventFormat";
import type { SettingsDraft } from "../../../editor/sdk";
import { readDraft } from "../../../editor/testing";
import { audioSettings } from "./audioDraft";
import { globalParameterList } from "./audioSettingsModel";
import type { EditResult } from "./editResult";
import { eventParameterList } from "./event/eventParameters";
import { newNode } from "./event/eventTreeModel";
import type { ParameterList } from "./parameterList";

const nextOf = <T,>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};

const speed: ParameterDef = { name: "Speed", min: 0, max: 10, default: 2, seekSpeed: 5 };
const surface: ParameterDef = { name: "Surface", labels: ["Grass", "Stone"], default: "Stone" };

interface Holder<H> {
  name: string;
  list: ParameterList<H>;
  limit: number;
  of(parameters: ParameterDef[]): H;
}
const eventHolder: Holder<AudioEventAsset> = { name: "an event's own parameters", list: eventParameterList, limit: MAX_LOCAL_PARAMETERS, of: (parameters) => ({ ...emptyAudioEvent(), parameters }) };
const globalHolder: Holder<SettingsDraft> = { name: "the global parameters", list: globalParameterList, limit: MAX_PARAMETERS, of: (parameters) => readDraft({ audio: { parameters } }) };

function suite<H>(h: Holder<H>) {
  const { list } = h;
  const params = (x: H) => list.parameters(x);
  /** The list reads back through the parse unchanged and without problems. */
  const expectParsed = (x: H) => {
    const problems: string[] = [];
    expect(parseParameters(JSON.parse(JSON.stringify(params(x))), "parameters", problems, h.limit)).toEqual(params(x));
    expect(problems).toEqual([]);
  };

  describe(h.name, () => {
    it("adds numeric and labelled parameters with unique names, refused at the limit", () => {
      let x = nextOf(list.add(h.of([])));
      x = nextOf(list.add(x));
      x = nextOf(list.add(x, "labelled"));
      expect(params(x)).toEqual([
        { name: "Parameter", min: 0, max: 1, default: 0, seekSpeed: 0 },
        { name: "Parameter 2", min: 0, max: 1, default: 0, seekSpeed: 0 },
        { name: "Parameter 3", labels: ["State 1", "State 2"], default: "State 1" },
      ]);
      expectParsed(x);
      let full = h.of([]);
      for (let i = 0; i < h.limit; i++) full = nextOf(list.add(full));
      expect(list.full(full)).toBe(true);
      expect(list.add(full)).toEqual({ refused: `at most ${h.limit} parameters` });
      expect(list.add(full, "labelled")).toEqual({ refused: `at most ${h.limit} parameters` });
    });

    it("renames (trimmed); an empty, taken or unknown name is refused, the same name is no change", () => {
      const x = h.of([speed, surface]);
      expect(params(nextOf(list.rename(x, "Speed", "  Pace ")))).toEqual([{ ...speed, name: "Pace" }, surface]);
      expect(list.rename(x, "Speed", "  ")).toEqual({ refused: "a parameter needs a name" });
      expect(list.rename(x, "Speed", "Surface")).toEqual({ refused: 'another parameter is named "Surface"' });
      expect(list.rename(x, "Nope", "X")).toEqual({ refused: 'no parameter named "Nope"' });
      expect(list.rename(x, "Speed", " Speed")).toEqual({ next: x });
    });

    it("removes by name; an unknown name is refused", () => {
      const x = h.of([speed, surface]);
      expect(params(nextOf(list.remove(x, "Speed")))).toEqual([surface]);
      expect(list.remove(x, "Nope")).toHaveProperty("refused");
    });

    it("switches kind, keeping name and place: State 1/State 2, or 0..labels-1 at the default's index", () => {
      const x = h.of([speed, { name: "Area", labels: ["Outdoor", "Cave", "Hall"], default: "Hall" }]);
      const a = nextOf(list.setKind(x, "Speed", "labelled"));
      expect(params(a)[0]).toEqual({ name: "Speed", labels: ["State 1", "State 2"], default: "State 1" });
      const b = nextOf(list.setKind(x, "Area", "numeric"));
      expect(params(b)[1]).toEqual({ name: "Area", min: 0, max: 2, default: 2, seekSpeed: 0 });
      expect(params(nextOf(list.setKind(h.of([surface]), "Surface", "numeric")))[0]).toEqual({ name: "Surface", min: 0, max: 1, default: 1, seekSpeed: 0 });
      expect(list.setKind(x, "Speed", "numeric")).toEqual({ next: x });
      expect(list.setKind(x, "Nope", "numeric")).toHaveProperty("refused");
      expectParsed(b);
    });

    it("sets a range as the parse reads it: min above max swaps, the default is clamped in, seek speed >= 0, non-finite ignored", () => {
      let x = h.of([{ name: "I", min: 0, max: 1, default: 0.5, seekSpeed: 0 }, surface]);
      x = nextOf(list.setRange(x, "I", { min: 2, max: -1 }));
      expect(params(x)[0]).toEqual({ name: "I", min: -1, max: 2, default: 0.5, seekSpeed: 0 });
      x = nextOf(list.setRange(x, "I", { default: 10, seekSpeed: -3 }));
      expect(params(x)[0]).toEqual({ name: "I", min: -1, max: 2, default: 2, seekSpeed: 0 });
      const same = list.setRange(x, "I", { min: NaN, max: Infinity });
      expect(same).toEqual({ next: x });
      x = nextOf(list.setRange(x, "I", { min: 5 })); // above max: the two swap, as the parse does
      expect(params(x)[0]).toEqual({ name: "I", min: 2, max: 5, default: 2, seekSpeed: 0 });
      expectParsed(x);
      expect(list.setRange(x, "Surface", { min: 0 })).toHaveProperty("refused");
      expect(list.setRange(x, "Nope", { min: 0 })).toHaveProperty("refused");
    });

    it("sets labels from text (trimmed, repeats and empties dropped), keeps or resets the default; none left is refused", () => {
      let x = h.of([surface, speed]);
      x = nextOf(list.setLabels(x, "Surface", " Grass, Mud ,, Grass, Stone"));
      expect(params(x)[0]).toEqual({ name: "Surface", labels: ["Grass", "Mud", "Stone"], default: "Stone" });
      x = nextOf(list.setLabels(x, "Surface", "Ice, Mud"));
      expect(params(x)[0]).toEqual({ name: "Surface", labels: ["Ice", "Mud"], default: "Ice" });
      expectParsed(x);
      expect(list.setLabels(x, "Surface", " , ")).toEqual({ refused: "a labelled parameter needs at least one label" });
      expect(list.setLabels(x, "Speed", "a")).toHaveProperty("refused");
    });

    it("sets a labelled default only to one of its labels", () => {
      const x = h.of([surface, speed]);
      expect(params(nextOf(list.setDefaultLabel(x, "Surface", "Grass")))[0]).toMatchObject({ default: "Grass" });
      expect(list.setDefaultLabel(x, "Surface", "Mud")).toHaveProperty("refused");
      expect(list.setDefaultLabel(x, "Speed", "Grass")).toHaveProperty("refused");
    });
  });
}

suite(eventHolder);
suite(globalHolder);

describe("what each holder carries along", () => {
  it("an event: a rename follows every use; a remove keeps the uses (they read a global parameter)", () => {
    const sw: SwitchNode = { ...(newNode("switch") as SwitchNode), parameter: "Surface" };
    const e: AudioEventAsset = { ...emptyAudioEvent(), parameters: [speed, surface], root: sw };
    const renamed = nextOf(eventParameterList.rename(e, "Surface", "Ground"));
    expect(renamed.parameters[1]!.name).toBe("Ground");
    expect((renamed.root as SwitchNode).parameter).toBe("Ground");
    const removed = nextOf(eventParameterList.remove(e, "Surface"));
    expect(removed.parameters).toEqual([speed]);
    expect((removed.root as SwitchNode).parameter).toBe("Surface");
    // What it writes reads back unchanged.
    expect(parseAudioEvent(JSON.parse(formatAudioEvent(renamed))).value.parameters).toEqual(renamed.parameters);
  });

  it("the settings: a rename renames the automation that reads it; a remove drops that automation", () => {
    const d = readDraft({ audio: {
      parameters: [{ name: "A", min: 0, max: 1, default: 0, seekSpeed: 0 }, { name: "B", labels: ["x", "y"], default: "x" }],
      automation: [
        { bus: "Music", parameter: "A", target: "volume", curve: [[0, 1], [1, 0]] },
        { bus: "SFX", parameter: "B", target: "lowpass", curve: [[0, 24000], [1, 800]] },
      ],
    } });
    const renamed = audioSettings.read(nextOf(globalParameterList.rename(d, "A", "Intensity")));
    expect(renamed.parameters.map((p) => p.name)).toEqual(["Intensity", "B"]);
    expect(renamed.automation.map((r) => r.parameter)).toEqual(["Intensity", "B"]);
    const removed = audioSettings.read(nextOf(globalParameterList.remove(d, "A")));
    expect(removed.parameters.map((p) => p.name)).toEqual(["B"]);
    expect(removed.automation.map((r) => r.parameter)).toEqual(["B"]);
  });
});
