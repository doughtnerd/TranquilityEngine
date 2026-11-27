// The action picker's folds (ADR 0417): remembered per project across editor restarts, and still kept for the run
// when storage is blocked.
import { afterEach, describe, expect, it, vi } from "vitest";

function fakeStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

/** The module as a fresh editor run loads it. */
const load = async () => {
  vi.resetModules();
  return import("./pickerFolds");
};

afterEach(() => vi.unstubAllGlobals());

describe("the action picker's folds", () => {
  it("are remembered per project across restarts", async () => {
    vi.stubGlobal("localStorage", fakeStorage());
    let folds = await load();
    expect(folds.pickerFolds("/games/a").size).toBe(0);
    folds.setPickerFold("/games/a", "engine.UIActions", false);
    folds.setPickerFold("/games/a", "game.Player", true);
    folds.setPickerFold("/games/b", "game.Player", false);
    folds = await load(); // the editor restarted
    expect(Object.fromEntries(folds.pickerFolds("/games/a"))).toEqual({ "engine.UIActions": false, "game.Player": true });
    expect(Object.fromEntries(folds.pickerFolds("/games/b"))).toEqual({ "game.Player": false });
    expect(folds.pickerFolds("/games/c").size).toBe(0);
  });

  it("ignore what isn't a fold, and last for the run when storage is blocked", async () => {
    const storage = fakeStorage();
    storage.data.set("myco.editor.inputPickerFolds:/g", '{"a":true,"b":"yes"}');
    vi.stubGlobal("localStorage", storage);
    let folds = await load();
    expect(Object.fromEntries(folds.pickerFolds("/g"))).toEqual({ a: true });
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    folds = await load();
    expect(folds.pickerFolds("/g").size).toBe(0);
    folds.setPickerFold("/g", "game.Player", true);
    expect(folds.pickerFolds("/g").get("game.Player")).toBe(true);
  });
});
