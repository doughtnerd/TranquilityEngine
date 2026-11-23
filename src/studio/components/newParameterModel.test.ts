// "+ New parameter…" (UI pass J4.1, J5.1, J6.5) through its model: the option every parameter select ends with, the
// draft the New parameter dialog edits, why Create is off, and the definition it makes (valid as the parse reads it).
import { describe, expect, it } from "vitest";
import { parseParameters } from "../../engine/audio/parameters";
import { isNewParameter, NEW_PARAMETER_LABEL, newDraft, parameterFromDraft, whyNotCreate, withNewParameter } from "./newParameterModel";

describe("+ New parameter…", () => {
  it("ends every parameter select, with a value no parameter can have", () => {
    const options = withNewParameter([{ value: "rpm", label: "rpm" }, { value: "voiceTime", label: "Voice time" }]);
    expect(options.map((o) => o.label)).toEqual(["rpm", "Voice time", NEW_PARAMETER_LABEL]);
    expect(isNewParameter(options.at(-1)!.value)).toBe(true);
    expect(isNewParameter("rpm")).toBe(false);
    expect(withNewParameter([]).map((o) => o.label)).toEqual(["+ New parameter…"]); // a new project's only choice
  });

  it("drafts a free name and checks it before Create", () => {
    const d = newDraft(["Parameter"]);
    expect(d).toMatchObject({ name: "Parameter 2", kind: "numeric", min: 0, max: 1, default: 0 });
    expect(whyNotCreate(d, ["Parameter"])).toBeNull();
    expect(whyNotCreate({ ...d, name: " " }, [])).toBe("A parameter needs a name");
    expect(whyNotCreate({ ...d, name: "rpm" }, ["rpm"])).toBe('There\'s already a parameter named "rpm"');
    expect(whyNotCreate({ ...d, min: 5, max: 5 }, [])).toBe("Max must be above min");
    expect(whyNotCreate({ ...d, max: Number.NaN }, [])).toBe("Min, max and default must be numbers");
    expect(whyNotCreate({ ...d, kind: "labelled", labels: " , " }, [])).toBe("A labelled parameter needs at least one label");
    expect(whyNotCreate(d, ["a", "b"], 2)).toBe("At most 2 parameters");
  });

  it("makes a numeric or labelled definition the parse keeps as it is", () => {
    const rpm = parameterFromDraft({ ...newDraft([]), name: " rpm ", min: 0, max: 8000, default: 9000 });
    expect(rpm).toEqual({ name: "rpm", min: 0, max: 8000, default: 8000, seekSpeed: 0 });
    const surface = parameterFromDraft({ ...newDraft([], "labelled"), name: "Surface", labels: "Wood, Metal, Water, Metal" });
    expect(surface).toEqual({ name: "Surface", labels: ["Wood", "Metal", "Water"], default: "Wood" });
    const problems: string[] = [];
    expect(parseParameters([rpm, surface], "parameters", problems)).toEqual([rpm, surface]);
    expect(problems).toEqual([]);
  });
});
