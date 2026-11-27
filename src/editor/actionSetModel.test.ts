// Action set assets in the editor (ADR 0433): the `*.actions.json` format as the asset kind reads it, the set view's
// edits, and the networking estimate.
import { describe, expect, it } from "vitest";
import { actionSetProblems, type ActionSetFile } from "../engine/input/actionAssets";
import {
  actionUploadBytes,
  addAction,
  defaultKey,
  formatActionSet,
  freeActionName,
  newActionSet,
  parseActionSet,
  removeAction,
  renameAction,
  setActionConsume,
  setActionType,
  setNetworked,
  setPrecision,
  setRedundancy,
  setSetKey,
  sortedActions,
  uploadEstimate,
  whyNotActionName,
  whyNotSetId,
} from "./actionSetModel";

const player: ActionSetFile = {
  id: "game.PlayerActions",
  actions: [
    { name: "move", type: "vec2", consume: true },
    { name: "jump", type: "button" },
  ],
  networked: true,
  encoding: { move: { quantize: 1 / 127 } },
};

describe("the action set format", () => {
  it("reads a file as written, with the engine's problems, and writes it back", () => {
    const { value, problems } = parseActionSet(JSON.parse(formatActionSet(player)), "input/player.actions.json");
    expect(value).toEqual(player);
    expect(problems).toEqual([]);
  });

  it("reports what the boot would reject, at its field", () => {
    const { value, problems } = parseActionSet({ id: "nodots", actions: [{ name: "jump", type: "stick" }, 3] }, "x.actions.json");
    expect(value.actions).toHaveLength(1); // the 3 isn't an action
    expect(problems.map((p) => p.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^id: /), expect.stringMatching(/^actions\.0\.type: /)]));
  });

  it("makes a new set that is valid and has one button", () => {
    expect(actionSetProblems(newActionSet("game.New2"))).toEqual([]);
    expect(newActionSet().actions).toEqual([{ name: "action", type: "button" }]);
  });
});

describe("the set view's edits", () => {
  it("sorts actions by name, A to Z, and finds free names", () => {
    expect(sortedActions(player).map((a) => a.name)).toEqual(["jump", "move"]);
    expect(freeActionName(player, "jump")).toBe("jump2");
    expect(freeActionName(player)).toBe("action");
  });

  it("checks ids and names", () => {
    expect(whyNotSetId("game.Menu", ["game.PlayerActions"])).toBeNull();
    expect(whyNotSetId("Menu", [])).toMatch(/dotted/);
    expect(whyNotSetId("game.PlayerActions", ["game.PlayerActions"])).toMatch(/Another set/);
    expect(whyNotActionName(player, "jump", "jump")).toBeNull();
    expect(whyNotActionName(player, "jump")).toMatch(/already/);
    expect(whyNotActionName(player, "1up")).toMatch(/letters/);
  });

  it("drops the key when it's the default", () => {
    expect(defaultKey("game.PlayerActions")).toBe("playerActions");
    expect(setSetKey(player, "pa").key).toBe("pa");
    expect("key" in setSetKey({ ...player, key: "pa" }, "playerActions")).toBe(false);
    expect("key" in setSetKey({ ...player, key: "pa" }, "")).toBe(false);
  });

  it("carries an action's encoding through a rename and drops it with the action or a change to button", () => {
    const renamed = renameAction(player, "move", "walk");
    expect(renamed.actions.map((a) => a.name)).toEqual(["walk", "jump"]);
    expect(renamed.encoding).toEqual({ walk: { quantize: 1 / 127 } });
    expect("encoding" in removeAction(player, "move")).toBe(false);
    expect("encoding" in setActionType(player, "move", "button")).toBe(false);
    expect(setActionType(player, "move", "axis").encoding).toEqual(player.encoding);
    expect(addAction(player, "dash", "button").actions.at(-1)).toEqual({ name: "dash", type: "button" });
  });

  it("writes consume, networking, resent ticks and precision only when they say something", () => {
    expect("consume" in setActionConsume(player, "move", undefined).actions[0]).toBe(false);
    expect(setActionConsume(player, "jump", false).actions[1].consume).toBe(false);
    expect("networked" in setNetworked(player, false)).toBe(false);
    expect(setRedundancy(player, 5).redundancy).toBe(5);
    expect("redundancy" in setRedundancy({ ...player, redundancy: 5 }, undefined)).toBe(false);
    expect("encoding" in setPrecision(player, "move", undefined)).toBe(false);
    expect(setPrecision(player, "move", 0.01).encoding).toEqual({ move: { quantize: 0.01 } });
  });
});

describe("the upload estimate", () => {
  it("counts each value component and the phase flags, as recordCodec writes a full record", () => {
    // A button: an f32 and a 2-byte phase varint.
    expect(actionUploadBytes("button")).toBe(6);
    // An exact vec2: two f32s; quantized to 1/127, each a zigzag varint of up to 254 (2 bytes); to 1/32767, up to 65534 (3 bytes).
    expect(actionUploadBytes("vec2")).toBe(10);
    expect(actionUploadBytes("vec2", 1 / 127)).toBe(6);
    expect(actionUploadBytes("vec3", 1 / 32767)).toBe(11);
    // A coarse step fits in one byte: round(1 / 0.1) = 10, zigzag 20.
    expect(actionUploadBytes("axis", 0.1)).toBe(3);
    // A button never quantizes.
    expect(actionUploadBytes("button", 0.1)).toBe(6);
  });

  it("totals a set per input and per packet, each packet carrying the newest input and the resent ones", () => {
    const e = uploadEstimate(player);
    expect(e.perAction.get("move")).toBe(6);
    expect(e.perAction.get("jump")).toBe(6);
    expect(e.perInput).toBe(12);
    expect(e.redundancy).toBe(3);
    expect(e.perPacket).toBe(48);
    expect(uploadEstimate({ ...player, redundancy: 0 }).perPacket).toBe(12);
  });
});
