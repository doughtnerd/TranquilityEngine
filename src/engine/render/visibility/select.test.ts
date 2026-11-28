// LOD selection (ADR 0459 §2–3): screen-relative heights, bias, first level, forced levels, hysteresis, culling,
// automatic heights, shadow casters and the frustum test, through `selectLevels` and `automaticHeights`.
import { describe, expect, it } from "vitest";
import { AUTOMATIC_CULL_HEIGHT, screenHeightOf, SelectionState, automaticHeights, fadeIn, fadeOut, outgoingOf, selectLevels, type SelectionGroups, type SelectionOut, type SelectionTier } from "./select";
import { LOD_CULLED, type VisibilityView } from "./types";
import { makeView } from "./views";

interface G {
  at?: [number, number, number];
  r?: number;
  size?: number;
  heights: number[];
  force?: number;
}

function groups(list: G[]): SelectionGroups {
  const n = list.length;
  const g = { count: n, sphere: new Float32Array(n * 4), size: new Float32Array(n), heights: new Float32Array(n * 8), heightStart: new Uint32Array(n), heightCount: new Uint8Array(n), forceLevel: new Int16Array(n) };
  list.forEach((x, i) => {
    g.sphere.set([...(x.at ?? [0, 0, 10]), x.r ?? 0.5], i * 4);
    g.size[i] = x.size ?? 1;
    g.heightStart[i] = i * 8;
    g.heightCount[i] = x.heights.length;
    g.heights.set(x.heights, i * 8);
    g.forceLevel[i] = x.force ?? -1;
  });
  return g;
}

const out = (n = 8): SelectionOut => ({ levels: new Uint8Array(n), casterLevels: new Uint8Array(n), hidden: new Uint8Array(n), fade: new Float32Array(n).fill(9) });
const TIER: SelectionTier = { lodBias: 1, lodFirstLevel: 0, shadowDistance: 50 };

/** A view at the origin looking along +Z: 90° vertical field of view (tan = 1, so h = size / (2·d)) or orthographic. */
function view(options: { projection?: "perspective" | "orthographic"; orthoHalfHeight?: number; persistent?: boolean; key?: string } = {}): VisibilityView {
  return makeView({
    key: options.key ?? "cam/camera",
    kind: "camera",
    position: [0, 0, 0],
    right: [1, 0, 0],
    up: [0, 1, 0],
    forward: [0, 0, 1],
    projection: options.projection ?? "perspective",
    fovY: Math.PI / 2,
    orthoHalfHeight: options.orthoHalfHeight ?? 5,
    near: 0.1,
    far: 1000,
    widthPx: 1000,
    heightPx: 1000,
    persistent: options.persistent ?? true,
    occlusion: false,
  });
}

/** The level one group gets at distance `d` straight ahead. */
function levelAt(d: number, g: Omit<G, "at">, tier: SelectionTier = TIER, v = view({ persistent: false })): number {
  const o = out();
  selectLevels(v, groups([{ ...g, at: [0, 0, d] }]), tier, new SelectionState(), o);
  return o.levels[0];
}

const HEIGHTS = [0.5, 0.2, 0.05];

describe("selectLevels", () => {
  it("measures perspective height as size / (2·d·tan(fovY / 2)) and draws the first level it reaches", () => {
    expect(levelAt(0.5, { heights: HEIGHTS })).toBe(0); // h = 1
    expect(levelAt(1, { heights: HEIGHTS })).toBe(0); // h = 0.5: on the threshold draws it
    expect(levelAt(2, { heights: HEIGHTS })).toBe(1); // h = 0.25
    expect(levelAt(2.2, { heights: HEIGHTS })).toBe(1); // h ≈ 0.23
  });

  it("drops a level as the group gets smaller on screen, and culls below the last height", () => {
    expect(levelAt(2.6, { heights: HEIGHTS })).toBe(2); // h ≈ 0.19
    expect(levelAt(9.5, { heights: HEIGHTS })).toBe(2); // h ≈ 0.053
    expect(levelAt(11, { heights: HEIGHTS })).toBe(LOD_CULLED); // h ≈ 0.045
    expect(levelAt(11, { heights: [0.5, 0.2, 0] })).toBe(2); // a last height of 0 never culls
    expect(levelAt(4, { heights: HEIGHTS, size: 3 })).toBe(1); // h = 0.375: size scales h
    expect(levelAt(4, { heights: HEIGHTS, size: 6 })).toBe(0); // h = 0.75
  });

  it("measures orthographic height as size / (2·orthoHalfHeight), whatever the distance", () => {
    const ortho = view({ projection: "orthographic", orthoHalfHeight: 5, persistent: false });
    expect(levelAt(1, { heights: HEIGHTS, size: 3 }, TIER, ortho)).toBe(1); // h = 0.3
    expect(levelAt(500, { heights: HEIGHTS, size: 3 }, TIER, ortho)).toBe(1);
    expect(levelAt(500, { heights: HEIGHTS, size: 10 }, TIER, ortho)).toBe(0); // h = 1
    expect(levelAt(500, { heights: HEIGHTS, size: 0.4 }, TIER, ortho)).toBe(LOD_CULLED); // h = 0.04
  });

  it("multiplies h by the tier's lodBias", () => {
    expect(levelAt(5, { heights: HEIGHTS })).toBe(2); // h = 0.1
    expect(levelAt(5, { heights: HEIGHTS }, { ...TIER, lodBias: 2.5 })).toBe(1); // 0.25
    expect(levelAt(5, { heights: HEIGHTS }, { ...TIER, lodBias: 0.4 })).toBe(LOD_CULLED); // 0.04
  });

  it("never draws a level finer than the tier's lodFirstLevel, clamped to the group's last level", () => {
    const low = { ...TIER, lodFirstLevel: 1 };
    expect(levelAt(0.5, { heights: HEIGHTS }, low)).toBe(1);
    expect(levelAt(5, { heights: HEIGHTS }, low)).toBe(2);
    expect(levelAt(11, { heights: HEIGHTS }, low)).toBe(LOD_CULLED);
    expect(levelAt(0.5, { heights: [0] }, low)).toBe(0); // a group with one level draws it
    expect(levelAt(0.5, { heights: HEIGHTS }, { ...TIER, lodFirstLevel: 7 })).toBe(2);
  });

  it("lets forceLevel win over distance, culling and the first level", () => {
    expect(levelAt(0.5, { heights: HEIGHTS, force: 2 })).toBe(2);
    expect(levelAt(100, { heights: HEIGHTS, force: 1 })).toBe(1);
    expect(levelAt(100, { heights: HEIGHTS, force: 0 }, { ...TIER, lodFirstLevel: 1 })).toBe(0);
  });

  describe("hysteresis (4 %) in persistent views", () => {
    // heights [0.2, 0.05], size 1: h = 1 / (2·d).
    const at = (h: number) => 1 / (2 * h);
    function run(hs: number[], persistent = true): number[] {
      const state = new SelectionState();
      const v = view({ persistent });
      return hs.map((h) => {
        const o = out();
        selectLevels(v, groups([{ at: [0, 0, at(h)], heights: [0.2, 0.05] }]), TIER, state, o);
        return o.levels[0];
      });
    }

    it("keeps a level until h crosses the threshold by 4 %, going coarser", () => {
      expect(run([0.21, 0.195, 0.193, 0.19])).toEqual([0, 0, 0, 1]);
    });

    it("keeps a level until h crosses the threshold by 4 %, going finer", () => {
      expect(run([0.19, 0.205, 0.207, 0.21])).toEqual([1, 1, 1, 0]);
    });

    it("applies to culling too", () => {
      expect(run([0.06, 0.049, 0.0485, 0.047, 0.051, 0.0515, 0.053])).toEqual([1, 1, 1, LOD_CULLED, LOD_CULLED, LOD_CULLED, 1]);
    });

    it("isn't kept for views that don't persist (probe faces, thumbnails)", () => {
      expect(run([0.21, 0.195, 0.205])).toEqual([0, 0, 0]);
      expect(run([0.21, 0.195, 0.205], false)).toEqual([0, 1, 0]);
    });

    it("is kept per view key, and forgotten per group", () => {
      const state = new SelectionState();
      const g = (h: number) => groups([{ at: [0, 0, at(h)], heights: [0.2, 0.05] }]);
      const sel = (key: string, h: number) => {
        const o = out();
        selectLevels(view({ key }), g(h), TIER, state, o);
        return o.levels[0];
      };
      expect(sel("a", 0.21)).toBe(0);
      expect(sel("b", 0.19)).toBe(1);
      expect(sel("a", 0.195)).toBe(0); // a stays at 0
      expect(sel("b", 0.205)).toBe(1); // b stays at 1
      state.forget(0);
      expect(sel("a", 0.195)).toBe(1); // no history: h alone
      state.dropView("b");
      expect(sel("b", 0.205)).toBe(0);
    });
  });

  it("hides groups outside the frustum but still chooses their level (their shadows draw)", () => {
    const o = out();
    const g = groups([
      { at: [0, 0, -5], heights: HEIGHTS }, // behind
      { at: [0, 0, 5], heights: HEIGHTS }, // ahead
      { at: [20, 0, 10], r: 0.5, heights: HEIGHTS }, // far right of a 90° view (aspect 1: x ≤ z)
      { at: [10.3, 0, 10], r: 0.5, heights: HEIGHTS }, // straddles the right side
      { at: [0, 0, 1000.4], r: 0.5, heights: HEIGHTS }, // straddles the far plane
      { at: [0, 0, 1001], r: 0.5, heights: [0] }, // beyond it
    ]);
    selectLevels(view(), g, TIER, new SelectionState(), o);
    expect([...o.hidden.subarray(0, 6)]).toEqual([1, 0, 1, 0, 0, 1]);
    expect(o.levels[0]).toBe(2); // h = 0.1 at 5 m behind
  });

  it("casts LOD-culled groups' shadows at their coarsest level within shadowDistance, and casters draw the view's level", () => {
    const o = out();
    const g = groups([
      { at: [0, 0, 2], heights: HEIGHTS }, // level 1
      { at: [0, 0, 40], r: 1, heights: HEIGHTS }, // culled, 39 m to its surface
      { at: [0, 0, 52], r: 1, heights: HEIGHTS }, // culled, 51 m
      { at: [0, 0, -40], heights: HEIGHTS, size: 50 }, // off-screen, level 0: still casts
    ]);
    selectLevels(view(), g, TIER, new SelectionState(), o);
    expect([...o.levels.subarray(0, 4)]).toEqual([1, LOD_CULLED, LOD_CULLED, 0]);
    expect([...o.casterLevels.subarray(0, 4)]).toEqual([1, 2, LOD_CULLED, 0]);
  });

  it("writes 0 fade values without crossfade", () => {
    const o = out();
    selectLevels(view(), groups([{ heights: HEIGHTS }, { heights: [0] }]), TIER, new SelectionState(), o);
    expect([...o.fade.subarray(0, 2)]).toEqual([0, 0]);
  });

  describe("crossfade (ADR 0459 §4)", () => {
    // heights [0.2, 0.05], size 1, 0.3 s fades: level 0 at h = 0.3, level 1 at h = 0.1, culled at h = 0.02.
    const FADE_TIER: SelectionTier = { ...TIER, lodCrossfade: true };
    const at = (h: number) => 1 / (2 * h);
    interface Step {
      level: number;
      fade: number;
      from: number;
      caster: number;
    }
    /** One group selected at each (time, h); `duration` 0 is `fade: "none"`. */
    function run(steps: [number, number][], options: { duration?: number; tier?: SelectionTier; persistent?: boolean; fadeDuration?: boolean } = {}): Step[] {
      const state = new SelectionState();
      const v = view({ persistent: options.persistent ?? true });
      return steps.map(([time, h]) => {
        const g = groups([{ at: [0, 0, at(h)], heights: [0.2, 0.05] }]);
        const withFade = options.fadeDuration === false ? g : { ...g, fadeDuration: new Float32Array([options.duration ?? 0.3]) };
        const o = { ...out(), fadeFrom: new Uint8Array(8) };
        selectLevels(v, withFade, options.tier ?? FADE_TIER, state, o, time);
        return { level: o.levels[0], fade: o.fade[0], from: o.fadeFrom[0], caster: o.casterLevels[0] };
      });
    }
    const steady = (level: number): Step => ({ level, fade: 0, from: LOD_CULLED, caster: level });

    it("starts a fade on a level change: the incoming level at a tiny negative, the outgoing one named, casters on the old level", () => {
      const [first, start] = run([
        [0, 0.3],
        [1, 0.1],
      ]);
      expect(first).toEqual(steady(0));
      expect(start.level).toBe(1);
      expect(start.from).toBe(0);
      expect(start.fade).toBeLessThan(0); // not -0: the incoming level must draw nothing yet
      expect(Math.round(Math.abs(start.fade) * 16)).toBe(0);
      expect(start.caster).toBe(0);
    });

    it("advances by the engine's clock, switches casters at the midpoint, and ends steady after fadeDuration", () => {
      const steps = run([
        [0, 0.3],
        [1, 0.1],
        [1.075, 0.1], // t = 0.25
        [1.16, 0.1], // t ≈ 0.53: past the midpoint
        [1.225, 0.1], // t = 0.75
        [1.31, 0.1], // past 0.3 s: done
        [1.4, 0.1],
      ]);
      expect(steps[2].fade).toBeCloseTo(-0.25, 5);
      expect(steps[2].caster).toBe(0);
      expect(steps[3].fade).toBeCloseTo(-0.16 / 0.3, 5);
      expect(steps[3].caster).toBe(1);
      expect(steps[4].fade).toBeCloseTo(-0.75, 5);
      expect(steps[4].from).toBe(0);
      expect(steps[5]).toEqual(steady(1));
      expect(steps[6]).toEqual(steady(1));
    });

    it("runs a reversed fade back from its progress", () => {
      const steps = run([
        [0, 0.3],
        [1, 0.1],
        [1.06, 0.3], // t = 0.2, then back to level 0: from 1 at 0.8
        [1.09, 0.3], // 0.9
        [1.2, 0.3],
      ]);
      expect(steps[2].level).toBe(0);
      expect(steps[2].from).toBe(1);
      expect(steps[2].fade).toBeCloseTo(-0.8, 5);
      expect(steps[2].caster).toBe(0); // level 0 shows more
      expect(steps[3].fade).toBeCloseTo(-0.9, 5);
      expect(steps[4]).toEqual(steady(0));
    });

    it("fades to a third level from the one that showed more", () => {
      const groupsAt = (h: number) => ({ ...groups([{ at: [0, 0, at(h)], heights: [0.5, 0.2, 0.05] }]), fadeDuration: new Float32Array([0.3]) });
      const state = new SelectionState();
      const v = view();
      const sel = (time: number, h: number) => {
        const o = { ...out(), fadeFrom: new Uint8Array(8) };
        selectLevels(v, groupsAt(h), FADE_TIER, state, o, time);
        return [o.levels[0], o.fadeFrom[0], o.fade[0]];
      };
      sel(0, 0.6); // level 0
      sel(1, 0.3); // fading 0 → 1
      expect(sel(1.03, 0.1)).toEqual([2, 0, expect.closeTo(-1e-6, 9)]); // t = 0.1: level 0 showed more
      sel(1.2, 0.1); // t ≈ 0.57 into 0 → 2
      expect(sel(1.2, 0.3)).toEqual([1, 2, expect.closeTo(-1e-6, 9)]); // level 2 showed more
    });

    it("fades in from culled and out to culled; a culled side casts by the culled rule", () => {
      const steps = run([
        [0, 0.1],
        [1, 0.02], // to culled: level 1 fades out
        [1.2, 0.02],
        [2, 0.02],
        [3, 0.1], // from culled
      ]);
      expect(steps[1]).toMatchObject({ level: LOD_CULLED, from: 1, caster: 1 });
      expect(steps[2].caster).toBe(1); // culled within shadowDistance: its coarsest level (1)
      expect(steps[3]).toEqual({ level: LOD_CULLED, fade: 0, from: LOD_CULLED, caster: 1 });
      expect(steps[4]).toMatchObject({ level: 1, from: LOD_CULLED });
      expect(steps[4].fade).toBeLessThan(0);
    });

    it("snaps where it can't fade: fade none, the tier's lodCrossfade off, no durations, views that don't persist", () => {
      const change: [number, number][] = [
        [0, 0.3],
        [1, 0.1],
      ];
      expect(run(change, { duration: 0 })[1]).toEqual(steady(1));
      expect(run(change, { tier: TIER })[1]).toEqual(steady(1));
      expect(run(change, { tier: { ...FADE_TIER, lodCrossfade: false } })[1]).toEqual(steady(1));
      expect(run(change, { fadeDuration: false })[1]).toEqual(steady(1));
      expect(run(change, { persistent: false })[1]).toEqual(steady(1));
    });

    it("ends a fade at once when the tier stops crossfading, and keeps fades per view key", () => {
      const state = new SelectionState();
      const sel = (key: string, time: number, h: number, tier = FADE_TIER) => {
        const o = { ...out(), fadeFrom: new Uint8Array(8) };
        selectLevels(view({ key }), { ...groups([{ at: [0, 0, at(h)], heights: [0.2, 0.05] }]), fadeDuration: new Float32Array([0.3]) }, tier, state, o, time);
        return o.fade[0];
      };
      sel("a", 0, 0.3);
      sel("b", 0, 0.1);
      expect(sel("a", 1, 0.1)).toBeLessThan(0); // a fades
      expect(sel("b", 1, 0.1)).toBe(0); // b was at level 1 already
      expect(sel("a", 1.1, 0.1, TIER)).toBe(0);
      state.forget(0);
      expect(sel("b", 1.2, 0.3)).toBe(0); // no history: chosen afresh
    });
  });
});

describe("fade value encoding (ADR 0459 §4)", () => {
  /** What the shader keeps of a 4×4 tile for fade value f: ranks ≥ round(16|f|) for f ≥ 0, below it for f < 0. */
  const kept = (f: number) => {
    const t = Math.floor(Math.abs(f) * 16 + 0.5);
    return Array.from({ length: 16 }, (_, rank) => (f < 0 ? rank < t : rank >= t));
  };

  it("gives the incoming level the complement of the outgoing one, so every pixel is drawn once", () => {
    for (const t of [0, 1 / 16, 0.1, 0.3, 0.5, 0.75, 15 / 16, 1]) {
      const a = kept(fadeOut(t)), b = kept(fadeIn(t));
      expect(a.every((x, i) => x !== b[i])).toBe(true);
      expect(outgoingOf(fadeIn(t))).toBeCloseTo(fadeOut(t), 5);
    }
  });

  it("encodes an incoming level at t = 0 as a tiny negative: -0 isn't below 0 and would draw it whole", () => {
    expect(Object.is(fadeIn(0), -0)).toBe(false);
    expect(fadeIn(0)).toBeLessThan(0);
    expect(kept(fadeIn(0)).some(Boolean)).toBe(false);
    expect(kept(-0).every(Boolean)).toBe(true); // the trap
    expect(kept(fadeOut(0)).every(Boolean)).toBe(true);
    expect(fadeIn(0.25)).toBe(-0.25);
  });
});

describe("automaticHeights", () => {
  const err = (h: number, pixelError = 1) => pixelError / (1080 * h);

  it("derives h = pixelError / (1080 × error) per transition, ending with 0.01 (the rock example)", () => {
    const rock = { levels: [{ error: 0 }, { error: err(0.149) }, { error: err(0.093) }, { error: err(0.056) }], pixelError: 1 };
    const h = automaticHeights([rock]);
    expect(h).toHaveLength(4);
    [0.149, 0.093, 0.056, AUTOMATIC_CULL_HEIGHT].forEach((v, i) => expect(h[i]).toBeCloseTo(v, 6));
  });

  it("scales with pixelError", () => {
    const h = automaticHeights([{ levels: [{ error: 0 }, { error: err(0.1) }], pixelError: 2 }]);
    expect(h[0]).toBeCloseTo(0.2, 6);
  });

  it("draws LOD0 and never culls when no member has levels", () => {
    expect(automaticHeights([])).toEqual([0]);
    expect(automaticHeights([{ levels: [{ error: 0 }], pixelError: 1 }])).toEqual([0]);
  });

  it("takes the smallest height over members, a member past its last level counting with its last error", () => {
    const a = { levels: [{ error: 0 }, { error: err(0.3) }, { error: err(0.1) }, { error: err(0.05) }], pixelError: 1 };
    const b = { levels: [{ error: 0 }, { error: err(0.2) }], pixelError: 1 };
    const h = automaticHeights([a, b]);
    expect(h).toHaveLength(4);
    expect(h[0]).toBeCloseTo(0.2, 6); // b's level 1 is the stricter
    expect(h[1]).toBeCloseTo(0.1, 6); // a's 0.1 against b's last (0.2)
    expect(h[2]).toBeCloseTo(0.05, 6);
    expect(h[3]).toBe(AUTOMATIC_CULL_HEIGHT);
  });

  it("keeps the heights descending", () => {
    const h = automaticHeights([{ levels: [{ error: 0 }, { error: err(0.05) }, { error: err(0.2) }, { error: err(0.001) }], pixelError: 1 }]);
    expect(h[0]).toBeCloseTo(0.05, 6);
    expect(h[1]).toBeCloseTo(0.05, 6);
    expect(h[2]).toBeCloseTo(0.001, 6);
    expect(h[3]).toBeCloseTo(0.001, 6); // the last value never above the one before
  });
});

describe("level preview (the editor's scene view, ADR 0459 §7)", () => {
  const two = groups([{ at: [0, 0, 2], heights: [0.5, 0.2, 0.05] }, { at: [0, 0, 2], heights: [0.5, 0.2, 0.05], force: 2 }]); // h = 0.25: level 1

  it("draws the previewed group at the previewed level and leaves the others alone", () => {
    const o = out();
    selectLevels(view({ persistent: false }), two, TIER, new SelectionState(), o, 0, { group: 0, level: 2 });
    expect([o.levels[0], o.levels[1]]).toEqual([2, 2]);
    selectLevels(view({ persistent: false }), two, TIER, new SelectionState(), o, 0, { group: 1, level: 0 });
    expect([o.levels[0], o.levels[1]]).toEqual([1, 0]); // overrides forceLevel too
  });

  it("level -1 previews the culled state, and no preview changes nothing", () => {
    const o = out();
    selectLevels(view({ persistent: false }), two, TIER, new SelectionState(), o, 0, { group: 0, level: -1 });
    expect(o.levels[0]).toBe(LOD_CULLED);
    selectLevels(view({ persistent: false }), two, TIER, new SelectionState(), o, 0, null);
    expect(o.levels[0]).toBe(1);
  });

  it("screenHeightOf is the height selection compares: size × bias / (2 tan(fov/2) d), distance-free in orthographic", () => {
    expect(screenHeightOf(view(), 1, 2, 1)).toBeCloseTo(0.25, 6);
    expect(screenHeightOf(view(), 1, 2, 2)).toBeCloseTo(0.5, 6);
    expect(screenHeightOf(view({ projection: "orthographic", orthoHalfHeight: 5 }), 1, 99, 1)).toBeCloseTo(0.1, 6);
  });
});
