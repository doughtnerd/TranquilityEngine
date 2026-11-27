import { describe, expect, it } from "vitest";
import { actionSetRow, codeActionSets, unlistedActionSets } from "./actionSetList";

const player = { id: "game.PlayerActions", actions: [{ name: "jump", type: "button" }, { name: "move", type: "vec2" }] };

describe("a listed action set file", () => {
  it("shows its id and action count", () => {
    expect(actionSetRow("input/player.actions.json", true, () => player)).toEqual({ path: "input/player.actions.json", id: "game.PlayerActions", actions: 2, problem: null });
  });

  it("says when the file is missing, isn't JSON or breaks the format", () => {
    expect(actionSetRow("input/gone.actions.json", false, () => player).problem).toMatch(/missing/);
    const broken = actionSetRow("input/bad.actions.json", true, () => {
      throw new Error("Unexpected token");
    });
    expect(broken.problem).toMatch(/isn't valid JSON: Unexpected token/);
    const wrong = actionSetRow("input/wrong.actions.json", true, () => ({ id: "game.Wrong", actions: [{ name: "x", type: "nope" }] }));
    expect(wrong).toMatchObject({ id: "game.Wrong", actions: 1 });
    expect(wrong.problem).toMatch(/^actions\.0\.type:/);
    expect(actionSetRow("input/null.actions.json", true, () => null)).toMatchObject({ id: null, actions: null });
  });
});

describe("the sets scripts define", () => {
  it("leaves out ids a listed file defines", () => {
    const rows = [actionSetRow("input/player.actions.json", true, () => player)];
    const all = [{ id: "game.PlayerActions" }, { id: "game.Menu" }];
    expect(codeActionSets(all, rows)).toEqual([{ id: "game.Menu" }]);
    expect(codeActionSets(all, [])).toEqual(all);
  });
});

describe("the files that could be added", () => {
  it("are the action set files not listed yet", () => {
    const files = ["input/a.actions.json", "input/b.actions.json", "input/default.input.json", "scenes/main.scene.json"];
    expect(unlistedActionSets(files, ["input/a.actions.json"])).toEqual(["input/b.actions.json"]);
  });
});
