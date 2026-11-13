// The Mixer strip's keyboard control and its ARIA slider (task Mp2b; W7 asked for it): a case per key, per modifier and at both
// ends. Each key press is one committed edit (one undo step); a pointer drag in progress owns the fader. No DOM: the handlers are
// called with plain event objects, as `MixerStrip.test.ts` does.
import type { VNode } from "preact";
import { describe, expect, it } from "vitest";
import type { SettingsDraft } from "../../../../editor/sdk";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { FINE_DRAG_SCALE, UNITY_POSITION, gainToPosition, positionToGain } from "./faderModel";
import { buildStrips, createMixerModel, type MixerHost } from "./mixerModel";
import { KEY_PAGE_STEP, KEY_STEP, MixerStrip, faderHandlers, keyPosition } from "./MixerStrip";

const AUDIO = { buses: [{ name: "master" }, { name: "sfx", parent: "master", volume: 0.5 }, { name: "music", parent: "master" }] };

function rig() {
  let draft: SettingsDraft = { audio: AUDIO } as SettingsDraft;
  const commits: string[] = [];
  const host: MixerHost = {
    draft: () => draft,
    apply: () => ({ ok: true, class: "direct" }),
    flushNow: () => {},
    commit: (label, next) => { commits.push(label); draft = next; },
  };
  const model = createMixerModel(host);
  const volume = (bus: string): number => parseAudioSettings(draft.audio).settings.buses.find((b) => b.name === bus)!.volume;
  const strip = (bus: string) => buildStrips(parseAudioSettings(draft.audio).settings).find((s) => s.name === bus)!;
  /** Press `key` on the fader of `bus`, with a fresh render before it (as the panel re-renders after each edit). */
  const press = (bus: string, key: string, mod: { shiftKey?: boolean; altKey?: boolean } = {}) => {
    let prevented = false;
    let changed = 0;
    faderHandlers({ strip: strip(bus), model, onChange: () => void changed++ }).onKeyDown({ key, ...mod, preventDefault: () => { prevented = true; } } as KeyboardEvent);
    return { prevented, changed };
  };
  return { model, commits, volume, strip, press };
}

describe("keyPosition: the position a key leads to", () => {
  it.each([
    ["ArrowUp", 0.5 + KEY_STEP],
    ["ArrowRight", 0.5 + KEY_STEP],
    ["ArrowDown", 0.5 - KEY_STEP],
    ["ArrowLeft", 0.5 - KEY_STEP],
    ["PageUp", 0.5 + KEY_PAGE_STEP],
    ["PageDown", 0.5 - KEY_PAGE_STEP],
    ["Home", 0],
    ["End", 1],
  ])("%s", (key, expected) => {
    expect(keyPosition(0.5, key, false)).toBeCloseTo(expected, 12);
  });

  it("a modifier makes the arrow and page steps fine", () => {
    expect(keyPosition(0.5, "ArrowUp", true)).toBeCloseTo(0.5 + KEY_STEP * FINE_DRAG_SCALE, 12);
    expect(keyPosition(0.5, "ArrowLeft", true)).toBeCloseTo(0.5 - KEY_STEP * FINE_DRAG_SCALE, 12);
    expect(keyPosition(0.5, "PageUp", true)).toBeCloseTo(0.5 + KEY_PAGE_STEP * FINE_DRAG_SCALE, 12);
    expect(keyPosition(0.5, "PageDown", true)).toBeCloseTo(0.5 - KEY_PAGE_STEP * FINE_DRAG_SCALE, 12);
  });

  it("Home and End ignore the modifier; the position clamps to 0..1; other keys are not the fader's", () => {
    expect(keyPosition(0.5, "Home", true)).toBe(0);
    expect(keyPosition(0.5, "End", true)).toBe(1);
    expect(keyPosition(0.99, "ArrowUp", false)).toBe(1);
    expect(keyPosition(0.01, "ArrowDown", false)).toBe(0);
    for (const k of ["a", "Enter", " ", "Tab", "Escape", "Shift"]) expect(keyPosition(0.5, k, false)).toBeNull();
  });

  it("does not snap to unity: an arrow leaves 0 dB in both directions", () => {
    expect(keyPosition(UNITY_POSITION, "ArrowUp", false)!).toBeGreaterThan(UNITY_POSITION);
    expect(keyPosition(UNITY_POSITION, "ArrowDown", false)!).toBeLessThan(UNITY_POSITION);
  });
});

describe("a key press on the fader is one committed edit", () => {
  it.each(["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "PageUp", "PageDown", "Home", "End"])("%s commits once, to the position's gain, and is handled", (key) => {
    const r = rig();
    const start = gainToPosition(r.volume("sfx"));
    const res = r.press("sfx", key);
    expect(r.commits).toEqual(["Set sfx volume"]);
    expect(res.prevented).toBe(true);
    expect(res.changed).toBe(1);
    expect(r.volume("sfx")).toBeCloseTo(positionToGain(keyPosition(start, key, false)!), 12);
  });

  it("each press is its own commit (one undo step each)", () => {
    const r = rig();
    r.press("sfx", "ArrowUp");
    r.press("sfx", "ArrowUp");
    r.press("sfx", "ArrowDown");
    expect(r.commits).toHaveLength(3);
  });

  it("Shift and Alt move the fader by the fine step; the plain key by the coarse one", () => {
    const coarse = rig();
    coarse.press("sfx", "ArrowUp");
    const shift = rig();
    shift.press("sfx", "ArrowUp", { shiftKey: true });
    const alt = rig();
    alt.press("sfx", "ArrowUp", { altKey: true });
    const start = gainToPosition(0.5);
    expect(gainToPosition(coarse.volume("sfx")) - start).toBeCloseTo(KEY_STEP, 6);
    expect(gainToPosition(shift.volume("sfx")) - start).toBeCloseTo(KEY_STEP * FINE_DRAG_SCALE, 6);
    expect(gainToPosition(alt.volume("sfx")) - start).toBeCloseTo(KEY_STEP * FINE_DRAG_SCALE, 6);
  });

  it("Home sets silence, End sets the top (gain 2)", () => {
    const r = rig();
    r.press("sfx", "Home");
    expect(r.volume("sfx")).toBe(0);
    r.press("sfx", "End");
    expect(r.volume("sfx")).toBe(2);
  });

  it("a key that moves nothing commits nothing: End at the top, Home at the bottom", () => {
    const r = rig();
    r.press("music", "End");
    r.press("music", "End");
    expect(r.commits).toEqual(["Set music volume"]);
    const q = rig();
    q.press("sfx", "Home");
    const before = q.commits.length;
    const res = q.press("sfx", "Home");
    expect(q.commits).toHaveLength(before);
    expect(res.changed).toBe(0);
  });

  it("an unrelated key does nothing and is not swallowed", () => {
    const r = rig();
    const res = r.press("sfx", "Tab");
    expect(r.commits).toEqual([]);
    expect(res.prevented).toBe(false);
  });

  it("a pointer drag in progress owns the fader: keys do nothing until it ends", () => {
    const r = rig();
    expect(r.model.beginDrag("sfx")).toBe(true);
    const res = r.press("sfx", "ArrowUp");
    expect(res.prevented).toBe(false);
    expect(r.commits).toEqual([]);
    r.model.cancelDrag();
    r.press("sfx", "ArrowUp");
    expect(r.commits).toHaveLength(1);
  });
});

describe("the fader's ARIA slider", () => {
  const fader = (volume: number) => {
    const r = rig();
    r.press("sfx", "End"); // sets 2; then set the volume wanted
    r.model.setVolume("sfx", volume);
    const tree = MixerStrip({ strip: r.strip("sfx"), model: r.model }) as VNode;
    const found: Array<VNode<Record<string, unknown>>> = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object" || !("props" in n)) return;
      const v = n as VNode<Record<string, unknown>>;
      if (v.props.role === "slider") found.push(v);
      walk(v.props.children);
    };
    walk(tree);
    expect(found).toHaveLength(1);
    return found[0]!.props;
  };

  it("is a focusable vertical slider named for the bus, with a 0..1 position and the dB as its text", () => {
    const p = fader(1);
    expect(p.role).toBe("slider");
    expect(p.tabIndex).toBe(0);
    expect(p["aria-label"]).toBe("sfx volume");
    expect(p["aria-orientation"]).toBe("vertical");
    expect(p["aria-valuemin"]).toBe(0);
    expect(p["aria-valuemax"]).toBe(1);
    expect(p["aria-valuenow"]).toBe(UNITY_POSITION);
    expect(p["aria-valuetext"]).toBe("0.0 dB");
    expect(typeof p.onKeyDown).toBe("function");
  });

  it("follows the value: silence reads -inf, the top +6.0 dB", () => {
    expect(fader(0)["aria-valuetext"]).toBe("-inf");
    expect(fader(0)["aria-valuenow"]).toBe(0);
    expect(fader(2)["aria-valuetext"]).toBe("+6.0 dB");
    expect(fader(2)["aria-valuenow"]).toBe(1);
  });
});
