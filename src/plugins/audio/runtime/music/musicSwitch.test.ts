/**
 * R2: `musicSwitch` parameter to child, latest wins, return cancels, unknown value keeps the playing child. The
 * transition stubs (R3a) are mocked; the player is a plain object with only the fields `tickSwitch` reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode } from "../../../../engine/audio/musicFormat";
import type { MusicFrame, MusicPlayer } from "./musicSystem";
import type * as SwitchModule from "./musicSwitch";
import type * as TransitionModule from "./transition";
import type { Transition } from "./transition";

vi.mock("./transition", () => ({
  requestTransition: vi.fn(),
  cancelTransition: vi.fn(),
}));

const seg = (id: string, value?: string): Record<string, unknown> => ({
  type: "segment", id, ...(value !== undefined ? { value } : {}), tracks: [{ name: "a", clip: `music/${id}.ogg` }],
});

function music(root: unknown): MusicNode {
  const { value } = parseAudioEvent({ format: "myco.audioevent@1", bus: "Music", root });
  if (!value.musicRoot) throw new Error("not a music root");
  return value.musicRoot;
}

const world = (): MusicNode => music({
  type: "musicSwitch", id: "world", parameter: "State", default: "explore",
  children: [seg("explore", "explore"), seg("combat", "combat"), { type: "playlist", id: "boss", value: "boss", children: [seg("b1"), seg("b2")] }],
});

const frame = { now: 0 } as MusicFrame;

/** A player on `root` with `params` as the instance's parameters and `playing` the playing run's segment id. */
function fixture(root: MusicNode, playing: string | null) {
  const params: Record<string, number | string | undefined> = { State: "explore" };
  const player = {
    state: "playing",
    instance: { getParameter: (n: string) => params[n] },
    run: playing ? { node: { id: playing, type: "segment" } } : null,
    musicSwitch: createSwitchState(root),
  } as unknown as MusicPlayer;
  return { player, params, play: (id: string) => { (player as { run: unknown }).run = { node: { id, type: "segment" } }; } };
}

// The test setup already loaded the real modules, so reset and import fresh ones that see the mock.
let childFor: typeof SwitchModule.childFor, createSwitchState: typeof SwitchModule.createSwitchState, tickSwitch: typeof SwitchModule.tickSwitch;
let requestTransition: typeof TransitionModule.requestTransition, cancelTransition: typeof TransitionModule.cancelTransition;

const asTransition = (id: string): Transition => ({ to: { id, type: "segment" } } as unknown as Transition);

beforeEach(async () => {
  vi.resetModules();
  ({ childFor, createSwitchState, tickSwitch } = await import("./musicSwitch"));
  ({ requestTransition, cancelTransition } = await import("./transition"));
  vi.mocked(requestTransition).mockReset().mockImplementation((_p, to) => asTransition(to.id));
  vi.mocked(cancelTransition).mockReset();
});

describe("createSwitchState and childFor", () => {
  it("is null for a node that is not a musicSwitch", () => {
    expect(createSwitchState({ id: "x", type: "playlist" })).toBeNull();
  });

  it("picks the child by value, the default child for an unknown value, else the first", () => {
    const state = createSwitchState(world())!;
    expect(state.parameter).toBe("State");
    expect(childFor(state, "combat")).toBe("combat");
    expect(childFor(state, "boss")).toBe("boss");
    expect(childFor(state, "nope")).toBe("explore");
    expect(childFor(state, undefined)).toBe("explore");
    const noDefault = createSwitchState(music({ type: "musicSwitch", id: "s", parameter: "P", children: [seg("a", "x"), seg("b", "y")] }))!;
    expect(childFor(noDefault, "zzz")).toBe("a");
    expect(childFor(noDefault, 1)).toBe("a");
  });

  it("matches a numeric value on its text", () => {
    const state = createSwitchState(music({ type: "musicSwitch", id: "s", parameter: "P", children: [seg("a", "1"), seg("b", "2")] }))!;
    expect(childFor(state, 2)).toBe("b");
  });
});

describe("tickSwitch", () => {
  it("does nothing while no run plays, or while the value picks the playing child", () => {
    const f = fixture(world(), null);
    expect(tickSwitch(f.player, frame)).toBeNull();
    f.play("explore");
    expect(tickSwitch(f.player, frame)).toBeNull();
    expect(requestTransition).not.toHaveBeenCalled();
    expect(f.player.musicSwitch!.playing).toBe("explore");
  });

  it("requests a transition to the child the new value picks", () => {
    const f = fixture(world(), "explore");
    f.params.State = "combat";
    const t = tickSwitch(f.player, frame);
    expect(t?.to.id).toBe("combat");
    expect(vi.mocked(requestTransition).mock.calls[0]![1].id).toBe("combat");
    expect(f.player.musicSwitch!.target).toBe("combat");
  });

  it("two changes inside one bar land once: only the latest value's request stands", () => {
    const f = fixture(world(), "explore");
    f.params.State = "combat";
    tickSwitch(f.player, frame);
    tickSwitch(f.player, frame); // an unchanged value asks nothing more
    expect(requestTransition).toHaveBeenCalledTimes(1);
    f.params.State = "boss";
    const t = tickSwitch(f.player, frame); // replaces the pending one (R3a replaces before its cancel point)
    expect(t?.to.id).toBe("boss");
    tickSwitch(f.player, frame);
    expect(requestTransition).toHaveBeenCalledTimes(2);
    expect(cancelTransition).not.toHaveBeenCalled();
    // The transition lands: the run is now under `boss`, the target clears, and nothing more is asked.
    f.play("b1");
    expect(tickSwitch(f.player, frame)).toBeNull();
    expect(requestTransition).toHaveBeenCalledTimes(2);
    expect(f.player.musicSwitch).toMatchObject({ playing: "boss", target: null });
  });

  it("setting the value back to the playing child cancels the change once", () => {
    const f = fixture(world(), "explore");
    f.params.State = "combat";
    tickSwitch(f.player, frame);
    f.params.State = "explore";
    expect(tickSwitch(f.player, frame)).toBeNull();
    expect(cancelTransition).toHaveBeenCalledTimes(1);
    expect(f.player.musicSwitch!.target).toBeNull();
    tickSwitch(f.player, frame);
    expect(cancelTransition).toHaveBeenCalledTimes(1);
  });

  it("a value with no child keeps the playing child and cancels a pending change", () => {
    const f = fixture(world(), "explore");
    f.params.State = "nope";
    expect(tickSwitch(f.player, frame)).toBeNull();
    expect(requestTransition).not.toHaveBeenCalled();
    f.params.State = "combat";
    tickSwitch(f.player, frame);
    f.params.State = "nope";
    tickSwitch(f.player, frame);
    expect(cancelTransition).toHaveBeenCalledTimes(1);
  });

  it("a refused request is not asked again until the value moves", () => {
    vi.mocked(requestTransition).mockReturnValue(null);
    const f = fixture(world(), "explore");
    f.params.State = "combat";
    expect(tickSwitch(f.player, frame)).toBeNull();
    tickSwitch(f.player, frame);
    expect(requestTransition).toHaveBeenCalledTimes(1);
  });

  it("is idle for a player that is stopping and for a non-switch root", () => {
    const f = fixture(world(), "explore");
    f.params.State = "combat";
    (f.player as { state: string }).state = "stopping";
    expect(tickSwitch(f.player, frame)).toBeNull();
    expect(requestTransition).not.toHaveBeenCalled();
    const none = fixture(world(), "explore");
    (none.player as { musicSwitch: unknown }).musicSwitch = null;
    expect(tickSwitch(none.player, frame)).toBeNull();
  });
});
