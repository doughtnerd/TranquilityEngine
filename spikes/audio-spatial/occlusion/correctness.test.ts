import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Assets, BoxCollider, Engine, GameObject, Physics, SceneManager } from "../../../src/myco";
import { analyticHit, buildLevel, freeListener, LAYERS, OCCLUDER, placeSources, type Level } from "./scene";
import { Occlusion } from "./occlusion";

describe("occlusion spike correctness", () => {
  it("a source behind a wall is occluded, one in line of sight is not; the group filter skips non-occluders", async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "3d" }, nodes: [] } }));
    const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, -9.81, 0] as [number, number, number], layers: LAYERS } } });
    await SceneManager.load("s.json");
    const box = (name: string, p: [number, number, number], s: [number, number, number], layer: string) => {
      const go = GameObject.create(name);
      go.transform!.position.set(...p);
      const c = go.addBehavior(BoxCollider); c.size.set(...s); c.layer = layer;
    };
    box("wall", [5, 2, 0], [0.3, 4, 10], "Occluder");   // between listener (0) and source A (10) on +x
    box("crate", [0, 1.5, 8], [1, 3, 1], "Default");     // between listener and source C on +z
    for (let i = 0; i < 3; i++) engine.step(1 / 60); // pushes colliders (may start physics lazily)
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 3; i++) engine.step(1 / 60);
    const L = { x: 0, y: 1.5, z: 0 };
    const cast = (to: { x: number; y: number; z: number }, layers?: string[]) => {
      const dx = to.x - L.x, dy = to.y - L.y, dz = to.z - L.z, d = Math.hypot(dx, dy, dz);
      return Physics.raycast(L, { x: dx / d, y: dy / d, z: dz / d }, d - 0.05, layers);
    };
    const A = { x: 10, y: 1.5, z: 0 }, B = { x: 0, y: 1.5, z: -10 }, C = { x: 0, y: 1.5, z: 16 };
    expect(cast(A)?.collider.node.name).toBe("wall");              // behind the wall: occluded
    expect(cast(A, OCCLUDER)?.collider.node.name).toBe("wall");
    expect(cast(B)).toBeNull();                                    // line of sight
    expect(cast(B, OCCLUDER)).toBeNull();
    expect(cast(C)?.collider.node.name).toBe("crate");             // unfiltered: the crate blocks
    expect(cast(C, OCCLUDER)).toBeNull();                          // filtered to Occluder: the crate is ignored
    expect(cast(A, ["Default"])).toBeNull();                       // the other group: the wall is ignored
    engine.dispose();
  });

  describe("large level vs analytic ray-box tests", () => {
    let level: Level;
    beforeAll(async () => { level = await buildLevel(1); });
    afterAll(() => level.engine.dispose());

    for (const filtered of [false, true]) {
      it(`engine first-hit equals the analytic first hit for 2,000 sources (${filtered ? "Occluder group" : "all colliders"})`, () => {
        const L = freeListener(level, 7);
        const { pos } = placeSources(level, 2000, 3);
        let mismatch = 0, occluded = 0, firstHitDistOff = 0;
        for (let i = 0; i < 2000; i++) {
          const sx = pos[i * 3], sy = pos[i * 3 + 1], sz = pos[i * 3 + 2];
          const dx = L.x - sx, dy = L.y - sy, dz = L.z - sz, dist = Math.hypot(dx, dy, dz);
          const ux = dx / dist, uy = dy / dist, uz = dz / dist, max = dist - 0.05;
          const hit = Physics.raycast({ x: sx, y: sy, z: sz }, { x: ux, y: uy, z: uz }, max, filtered ? OCCLUDER : undefined);
          const t = analyticHit(level.boxes, sx, sy, sz, ux, uy, uz, max, filtered);
          if ((hit !== null) !== (t >= 0)) mismatch++;
          else if (hit) { occluded++; if (Math.abs(hit.distance - t) > 1e-3) firstHitDistOff++; }
        }
        console.log(`[correctness] filtered=${filtered}: mismatches=${mismatch}/2000, occluded=${occluded}, hit-distance disagreements=${firstHitDistOff}`);
        expect(mismatch).toBeLessThanOrEqual(2); // grazing edge cases only
        expect(occluded).toBeGreaterThan(200);   // the scene really occludes ...
        expect(occluded).toBeLessThan(1900);     // ... and really has sight lines
        expect(firstHitDistOff).toBeLessThanOrEqual(2);
      });
    }

    it("the Occluder filter excludes non-occluder colliders (hit counts: filtered <= unfiltered, and no Default hit)", () => {
      const L = freeListener(level, 9);
      const { pos } = placeSources(level, 1000, 5);
      let all = 0, filt = 0, defaultInFiltered = 0, propOnly = 0;
      for (let i = 0; i < 1000; i++) {
        const sx = pos[i * 3], sy = pos[i * 3 + 1], sz = pos[i * 3 + 2];
        const dx = L.x - sx, dy = L.y - sy, dz = L.z - sz, dist = Math.hypot(dx, dy, dz);
        const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
        const a = Physics.raycast({ x: sx, y: sy, z: sz }, dir, dist - 0.05);
        const f = Physics.raycast({ x: sx, y: sy, z: sz }, dir, dist - 0.05, OCCLUDER);
        if (a) all++;
        if (f) { filt++; if ((f.collider as BoxCollider).layer !== "Occluder") defaultInFiltered++; }
        if (a && !f && (a.collider as BoxCollider).layer === "Default") propOnly++;
      }
      console.log(`[correctness] unfiltered hits=${all}, filtered hits=${filt}, rays blocked only by a non-occluder=${propOnly}`);
      expect(defaultInFiltered).toBe(0);
      expect(filt).toBeLessThanOrEqual(all);
      expect(propOnly).toBeGreaterThan(0);
    });

    it("the time-sliced scheduler visits every source within ceil(S / (b - tier share)) frames (count budgets)", () => {
      const L = freeListener(level, 11);
      for (const S of [64, 256, 1024]) {
        for (const b of [1, 2, 8, 20, 64]) {
          const { pos, loud } = placeSources(level, S, 100 + S + b);
          const occ = new Occlusion(level, pos, loud, L, { R: 1, layers: OCCLUDER, tier: 16, tierShare: 0.5, roundRobin: true, budgetCasts: b, tau: 0.1 });
          const tierCasts = Math.min(16, Math.floor(b * 0.5), S);
          const bound = Math.ceil(S / (b - tierCasts));
          let done = -1;
          for (let f = 0; f < bound + 2; f++) {
            const casts = occ.frame(f, 1 / 60);
            expect(casts).toBe(b); // spends exactly its budget
            if (done < 0 && occ.stamp.every((s) => s >= 0)) done = f + 1;
          }
          expect(done).toBeGreaterThan(0);
          expect(done).toBeLessThanOrEqual(bound);
          // Steady state: nobody is ever staler than `bound` frames.
          let worst = 0;
          for (let f = bound + 2; f < bound + 2 + 3 * bound; f++) {
            occ.frame(f, 1 / 60);
            for (let i = 0; i < S; i++) worst = Math.max(worst, f - occ.stamp[i]);
          }
          expect(worst).toBeLessThanOrEqual(bound);
        }
      }
    });

    it("time-sliced budgets converge: cached occluded state equals the truth once everything is refreshed (static)", () => {
      const L = freeListener(level, 13);
      const { pos, loud } = placeSources(level, 256, 17);
      const occ = new Occlusion(level, pos, loud, L, { R: 1, layers: OCCLUDER, tier: 16, tierShare: 0.5, roundRobin: true, budgetMs: 0.25, tau: 0.1 });
      for (let f = 0; f < 400; f++) occ.frame(f, 1 / 60);
      let wrong = 0, occluded = 0;
      for (let i = 0; i < 256; i++) {
        const dx = L.x - pos[i * 3], dy = L.y - pos[i * 3 + 1], dz = L.z - pos[i * 3 + 2], dist = Math.hypot(dx, dy, dz);
        const t = analyticHit(level.boxes, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], dx / dist, dy / dist, dz / dist, dist - 0.05, true);
        if ((t >= 0) !== (occ.centerHit[i] === 1)) wrong++;
        if (t >= 0) occluded++;
        // The smoothed gain is below 1 only for occluded sources (after 400 frames it has settled).
        if (t >= 0) expect(occ.outGain[i]).toBeLessThan(0.99); else expect(occ.outGain[i]).toBeCloseTo(1, 3);
      }
      console.log(`[correctness] scheduler static convergence: wrong=${wrong}/256, occluded=${occluded}`);
      expect(wrong).toBeLessThanOrEqual(1);
    });
  });
});
