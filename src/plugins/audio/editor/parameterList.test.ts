// ADR 0304: the one parameter list, its rules run at the local and the global limit, each checked against the parse
// that reads the list back; then that a rename and a remove carry along what the holder says (the Studio's holders: the
// global parameters in `audio.json`, `src/studio/screens/mixer/globalParameters.ts`, and a playlist's own).
import { describe, expect, it } from "vitest";
import { MAX_LOCAL_PARAMETERS, MAX_PARAMETERS, parseParameters, type ParameterDef } from "../../../engine/audio/parameters";
import type { EditResult } from "./editResult";
import { parameterList, type ParameterList } from "./parameterList";

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
/** A holder whose list is the whole value, and whose rename and remove carry along a list of uses (`uses`), as a holder's references would. */
interface Owned { parameters: ParameterDef[]; uses: string[] }
const ownedList = (limit: number): ParameterList<Owned> => parameterList<Owned>({
  read: (h) => h.parameters,
  write: (h, parameters) => ({ ...h, parameters }),
  limit,
  rename: (h, from, to) => ({ parameters: h.parameters.map((p) => (p.name === from ? { ...p, name: to } : p)), uses: h.uses.map((u) => (u === from ? to : u)) }),
  remove: (h, name) => ({ parameters: h.parameters.filter((p) => p.name !== name), uses: h.uses.filter((u) => u !== name) }),
});
const localHolder: Holder<Owned> = { name: "a holder at the local limit", list: ownedList(MAX_LOCAL_PARAMETERS), limit: MAX_LOCAL_PARAMETERS, of: (parameters) => ({ parameters, uses: [] }) };
const globalHolder: Holder<Owned> = { name: "a holder at the global limit", list: ownedList(MAX_PARAMETERS), limit: MAX_PARAMETERS, of: (parameters) => ({ parameters, uses: [] }) };

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

suite(localHolder);
suite(globalHolder);

describe("what a holder carries along", () => {
  it("a rename and a remove go through the holder's own rename and remove", () => {
    const list = ownedList(MAX_PARAMETERS);
    const h: Owned = { parameters: [speed, surface], uses: ["Surface", "Speed"] };
    const renamed = nextOf(list.rename(h, "Surface", "Ground"));
    expect(renamed.parameters[1]!.name).toBe("Ground");
    expect(renamed.uses).toEqual(["Ground", "Speed"]);
    const removed = nextOf(list.remove(h, "Surface"));
    expect(removed.parameters).toEqual([speed]);
    expect(removed.uses).toEqual(["Speed"]);
  });
});
