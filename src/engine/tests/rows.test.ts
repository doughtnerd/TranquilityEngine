import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Replicated, SceneManager, Transform, defineComponent, defineSystem, f32, i32, u8, type BootstrapConfig, type Rows } from "../index";
import { World } from "../core/World";
import { Mat4 } from "../core/math";
import { NO_ROWS } from "../core/rows";
import { clientReplication } from "../net/replication/client";

// ADR 0064: system rows with column access, the buffered query, activeScene and affine matrices.

const Pos = defineComponent("test.rows.Pos", { x: f32, y: f32 });
const Info = defineComponent("test.rows.Info", { count: i32, flag: u8 });
const Other = defineComponent("test.rows.Other", { v: f32 });
const Tag = defineComponent("test.rows.Tag", { n: i32 });
const PBody = defineComponent("test.rows.PBody", { vx: f32 });

type Handler = (rows: Rows, world: World) => void;
const handlers: Record<string, Handler | null> = { full: null, data: null, none: null, pred: null };

defineSystem({
  name: "test.rows.full",
  phase: "update",
  query: [Transform, Pos, Info],
  run: (rows, ctx) => handlers.full?.(rows, ctx.world),
});
defineSystem({
  name: "test.rows.data",
  phase: "update",
  query: [Tag],
  run: (rows, ctx) => handlers.data?.(rows, ctx.world),
});
defineSystem({
  name: "test.rows.none",
  phase: "update",
  run: (rows, ctx) => handlers.none?.(rows, ctx.world),
});
defineSystem({
  name: "test.rows.pred",
  phase: "fixedUpdate",
  predicted: true,
  worlds: ["client"],
  query: [PBody],
  run: (rows, ctx) => handlers.pred?.(rows, ctx.world),
});

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  for (const k of Object.keys(handlers)) handlers[k] = null;
  Assets.clearSources();
});

async function make(config: Record<string, unknown> = {}): Promise<Engine> {
  const engine = await Engine.create({ headless: true, ...config });
  engines.push(engine);
  return engine;
}

/** Run the "full" system once and return what `fn` computed. */
function runFull<T>(engine: Engine, fn: (rows: Rows, world: World) => T): T {
  let out!: T;
  handlers.full = (rows, w) => {
    out = fn(rows, w);
  };
  engine.step(1 / 60);
  handlers.full = null;
  return out;
}

/** The row object is reused, so read each row inside the loop. */
function nodesOf(rows: Rows): GameObject[] {
  const out: GameObject[] = [];
  for (const r of rows) out.push(r.node);
  return out;
}
function pairsOf(rows: Rows): unknown[][] {
  const out: unknown[][] = [];
  for (const r of rows) out.push([r.node, r.transform]);
  return out;
}

/** Identity comparison (deep equality would walk node internals). */
function expectSame(actual: readonly unknown[], expected: readonly unknown[]): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v === expected[i], `item ${i}`).toBe(true));
}

function agent(name: string, x: number, y: number, count: number, parent?: GameObject): GameObject {
  const n = GameObject.create(name, parent ? { parent } : {});
  n.addData(Pos, { x, y });
  n.addData(Info, { count, flag: 1 });
  return n;
}

describe("rows columns (ADR 0064)", () => {
  it("returns typed arrays matching the data, and writes show up in views", async () => {
    const engine = await make();
    const a = agent("a", 1.5, 2.5, 7);
    const b = agent("b", 3.5, 4.5, 9);
    const res = runFull(engine, (rows) => {
      const p = rows.column(Pos);
      const info = rows.column(Info);
      const types = [p.x.constructor, info.count.constructor, info.flag.constructor];
      const seen = Array.from(rows.indices, (i) => [p.x[i], p.y[i], info.count[i], info.flag[i]]);
      for (const i of rows.indices) {
        p.x[i] += 10;
        info.count[i] *= 2;
      }
      return { types, seen, count: rows.count, len: rows.indices.length };
    });
    expect(res.types).toEqual([Float32Array, Int32Array, Uint8Array]);
    expect(res.count).toBe(2);
    expect(res.len).toBe(2);
    expect(res.seen).toEqual([
      [1.5, 2.5, 7, 1],
      [3.5, 4.5, 9, 1],
    ]);
    expect(a.getData(Pos)!.x).toBe(11.5);
    expect(a.getData(Info)!.count).toBe(14);
    expect(b.getData(Pos)!.x).toBe(13.5);
    expect(b.getData(Info)!.count).toBe(18);
  });

  it("only matching nodes appear: missing terms, inactive, destroyed, edit mode, no transform", async () => {
    const engine = await make();
    const good = agent("good", 0, 0, 1);
    const missing = GameObject.create("missing");
    missing.addData(Pos, { x: 0, y: 0 });
    const off = agent("off", 0, 0, 2);
    off.setActive(false);
    const parentOff = GameObject.create("parentOff");
    const underOff = agent("underOff", 0, 0, 3, parentOff);
    parentOff.setActive(false);
    const doomed = agent("doomed", 0, 0, 4);
    GameObject.destroy(doomed);
    const noTransform = GameObject.create("noTransform", { transform: false });
    noTransform.addData(Pos, { x: 0, y: 0 });
    noTransform.addData(Info, { count: 5 });
    const editRoot = GameObject.create("editRoot");
    const editChild = agent("editChild", 0, 0, 6, editRoot);
    engine.world.setEditMode(editRoot.entity, true);
    engine.step(1 / 60); // destroys `doomed` at the end of the frame

    const res = runFull(engine, (rows, w) => ({
      viaIndices: Array.from(rows.indices, (i) => w.handle(i)),
      viaIter: nodesOf(rows),
      viaNode: Array.from(rows.indices, (i) => rows.node(i)),
    }));
    expectSame(res.viaIndices, [good]);
    expectSame(res.viaIter, [good]);
    expectSame(res.viaNode, [good]);
    for (const n of [missing, off, underOff, noTransform, editChild]) expect(res.viaIndices).not.toContain(n);

    // A data-only query has no transform requirement and follows the same rules otherwise.
    for (const n of [good, noTransform, off, editChild]) n.addData(Tag, { n: 1 });
    let seen: GameObject[] = [];
    handlers.data = (rows) => {
      seen = nodesOf(rows);
    };
    engine.step(1 / 60);
    expectSame(seen, [good, noTransform]);
  });

  it("column() of a def outside the query throws; a system with no query gets NO_ROWS", async () => {
    const engine = await make();
    agent("a", 0, 0, 1);
    let threw = false;
    let noneRows: Rows | null = null;
    handlers.full = (rows) => {
      try {
        rows.column(Other);
      } catch {
        threw = true;
      }
    };
    handlers.none = (rows) => {
      noneRows = rows;
    };
    engine.step(1 / 60);
    expect(threw).toBe(true);
    expect(noneRows).toBe(NO_ROWS);
    expect(noneRows!.count).toBe(0);
    expect([...noneRows!]).toEqual([]);
    expect(() => noneRows!.column(Pos)).toThrow();
  });

  it("iterates rows with correct lazy node and transform, reusing the row object", async () => {
    const engine = await make();
    const nodes = [agent("a", 1, 0, 1), agent("b", 2, 0, 2), agent("c", 3, 0, 3)];
    const res = runFull(engine, (rows) => {
      const objs = new Set<unknown>();
      const first: any[] = [];
      for (const row of rows) {
        objs.add(row);
        first.push(row);
      }
      // After the loop, the (single) row object points at the last row.
      const afterLoop = first[0].node;
      const held: { node: GameObject; transform: unknown; x: number }[] = [];
      for (const row of rows) {
        // Read node and transform only after the views are set.
        const x = (row as any).pos.x;
        held.push({ x, node: row.node, transform: row.transform });
      }
      return { distinct: objs.size, held, afterLoop };
    });
    expect(res.distinct).toBe(1);
    expect(res.held.map((h) => h.x)).toEqual([1, 2, 3]);
    expectSame(res.held.map((h) => h.node), nodes);
    expectSame(res.held.map((h) => h.transform), nodes.map((n) => n.transform));
    expect(res.afterLoop).toBe(nodes[2]);
  });

  it("skips a later row whose data the system removed earlier in the same run", async () => {
    const engine = await make();
    const nodes = [agent("a", 1, 0, 1), agent("b", 2, 0, 2), agent("c", 3, 0, 3)];
    const visited: GameObject[] = [];
    handlers.full = (rows, w) => {
      const victim = w.handle(rows.indices[rows.count - 1]);
      for (const row of rows) {
        visited.push(row.node);
        if (row.node !== victim) victim.removeData(Info);
      }
    };
    engine.step(1 / 60);
    expectSame(visited, [nodes[0], nodes[1]]);
  });

  it("reuses its buffer across runs while growing and shrinking", async () => {
    const engine = await make();
    const all: GameObject[] = [];
    const counts: number[] = [];
    handlers.full = (rows) => {
      counts.push(rows.count);
      expect(rows.indices.length).toBe(rows.count);
      expect([...rows].length).toBe(rows.count);
    };
    for (let i = 0; i < 3; i++) all.push(agent("n" + i, i, 0, i));
    engine.step(1 / 60);
    for (let i = 3; i < 60; i++) all.push(agent("n" + i, i, 0, i));
    engine.step(1 / 60);
    for (const n of all.slice(0, 50)) n.removeData(Info);
    engine.step(1 / 60);
    for (let i = 0; i < 4; i++) all[50 + i].setActive(false);
    engine.step(1 / 60);
    expect(counts.slice(0, 4)).toEqual([3, 60, 10, 6]);
  });

  it("rows.node(i) and rows.transform(i) match iteration; transform throws without one", async () => {
    const engine = await make();
    const a = agent("a", 0, 0, 1);
    const b = agent("b", 0, 0, 2);
    const res = runFull(engine, (rows) => ({
      viaIter: pairsOf(rows),
      viaIdx: Array.from(rows.indices, (i) => [rows.node(i), rows.transform(i)]),
    }));
    expectSame(res.viaIdx.flat(), res.viaIter.flat());
    expectSame(res.viaIdx.map((p) => p[0]), [a, b]);

    const nt = GameObject.create("nt", { transform: false });
    nt.addData(Tag, { n: 1 });
    a.addData(Tag, { n: 2 });
    let threw = false;
    let ok: Transform | null = null;
    handlers.data = (rows) => {
      const idx = Array.from(rows.indices);
      try {
        for (const i of idx) if (rows.node(i) === nt) rows.transform(i);
      } catch {
        threw = true;
      }
      ok = rows.transform(idx.find((i) => rows.node(i) === a)!);
    };
    engine.step(1 / 60);
    expect(threw).toBe(true);
    expect(ok).toBe(a.transform);
  });
});

describe("predicted system rows", () => {
  it("sees only the predicted ghost in indices and iteration", async () => {
    Assets.addSource(
      Assets.fromObject({
        "prefabs/rows-player.json": {
          format: "myco.scene@1",
          nodes: [
            {
              id: "player",
              name: "Player",
              components: [
                { type: "net.Replicated", data: { mode: "predicted" } },
                { type: "engine.Transform", data: { position: [0, 0, 0] } },
                { type: "test.rows.PBody", data: { vx: 0 } },
              ],
            },
          ],
        },
      }),
    );
    const bootstrap: BootstrapConfig = {
      worlds: [
        { name: "P1", tags: ["client"] },
        { name: "Server", tags: ["server"] },
      ],
      links: [{ from: "P1", to: "Server", transport: "loopback", options: {} }],
    };
    const engine = await make({ bootstrap });
    const server = engine._world("Server")!;
    const p1 = engine._world("P1")!;
    const session = clientReplication(p1)!.session;
    const step = (n: number) => {
      for (let i = 0; i < n; i++) engine.step(1 / 60);
    };
    for (let i = 0; i < 300 && session.serverPeer?.state !== "open"; i++) step(1);
    const id = session.serverPeer!.id;
    const player = World._runIn(server, () => GameObject.instantiate("prefabs/rows-player.json"));
    World._runIn(server, () => (player.getBehavior(Replicated)!.ownerId = id));
    step(120);
    let ghost: GameObject | null = null;
    for (const g of clientReplication(p1)!.ghosts.values()) if (g.binding) ghost = g.binding.node;
    expect(ghost).not.toBeNull();
    // A plain local node with the same component, which the predicted system must skip.
    const local = World._runIn(p1, () => {
      const n = GameObject.create("local");
      n.addData(PBody, { vx: 1 });
      return n;
    });
    const seen: { indices: number[]; iter: GameObject[] }[] = [];
    handlers.pred = (rows, w) => {
      if (w === p1) seen.push({ indices: Array.from(rows.indices), iter: nodesOf(rows) });
    };
    step(30);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.indices).toEqual([ghost!.entity]);
      expectSame(s.iter, [ghost]);
      expect(s.iter).not.toContain(local);
    }
  });
});

describe("world.activeScene", () => {
  const files = (): Record<string, unknown> => ({
    "scenes/a.json": { format: "myco.scene@1", nodes: [{ id: "a", name: "A" }] },
    "scenes/b.json": { format: "myco.scene@1", nodes: [{ id: "b", name: "B" }] },
  });

  it("is null with no scene, then the last loaded scene node", async () => {
    Assets.addSource(Assets.fromObject(files()));
    const engine = await make();
    expect(engine.world.activeScene).toBeNull();
    const a = await SceneManager.load("scenes/a.json", { additive: true });
    expect(engine.world.activeScene).toBe(a);
    const b = await SceneManager.load("scenes/b.json", { additive: true });
    expect(engine.world.activeScene).toBe(b);
  });

  it("skips a scene pending destroy", async () => {
    Assets.addSource(Assets.fromObject(files()));
    const engine = await make();
    const a = await SceneManager.load("scenes/a.json", { additive: true });
    const b = await SceneManager.load("scenes/b.json", { additive: true });
    GameObject.destroy(b);
    expect(engine.world.activeScene).toBe(a);
    engine.step(1 / 60);
    expect(engine.world.activeScene).toBe(a);
  });

  it("is unaffected by many plain children of the root, and creation goes under it", async () => {
    Assets.addSource(Assets.fromObject(files()));
    const engine = await make();
    expect(GameObject.create("early").parent).toBe(engine.world.root);
    const a = await SceneManager.load("scenes/a.json", { additive: true });
    for (let i = 0; i < 500; i++) GameObject.create("rootKid", { parent: engine.world.root });
    expect(engine.world.activeScene).toBe(a);
    expect(GameObject.create("later").parent).toBe(a);
  });
});

describe("Mat4.multiplyAffine", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const trs = (): Float32Array => {
    const q = new Float32Array([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    for (let i = 0; i < 4; i++) q[i] /= len;
    const p = new Float32Array([rnd() * 20 - 10, rnd() * 20 - 10, rnd() * 20 - 10]);
    const s = new Float32Array([rnd() * 2 + 0.2, rnd() * 2 + 0.2, rnd() * 2 + 0.2]);
    const m = new Float32Array(16);
    Mat4.compose(m, 0, p, 0, q, 0, s, 0);
    return m;
  };
  const close = (a: ArrayLike<number>, b: ArrayLike<number>, ao = 0, bo = 0) => {
    for (let i = 0; i < 16; i++) expect(Math.abs(a[ao + i] - b[bo + i])).toBeLessThan(1e-4);
  };

  it("equals multiply for random TRS matrices", () => {
    for (let n = 0; n < 50; n++) {
      const a = trs();
      const b = trs();
      const full = new Float32Array(16);
      const aff = new Float32Array(16);
      Mat4.multiply(full, 0, a, 0, b, 0);
      Mat4.multiplyAffine(aff, 0, a, 0, b, 0);
      close(aff, full);
    }
  });

  it("works when out aliases a or b at the same offset", () => {
    for (let n = 0; n < 20; n++) {
      const a = trs();
      const b = trs();
      const expected = new Float32Array(16);
      Mat4.multiply(expected, 0, a, 0, b, 0);
      const store = new Float32Array(48);
      store.set(a, 16);
      Mat4.multiplyAffine(store, 16, store, 16, b, 0);
      close(store, expected, 16);
      const store2 = new Float32Array(48);
      store2.set(b, 32);
      Mat4.multiplyAffine(store2, 32, a, 0, store2, 32);
      close(store2, expected, 32);
    }
  });
});

describe("transform propagation", () => {
  it("children follow after moving a leaf and then a parent", async () => {
    const engine = await make();
    const parent = GameObject.create("parent");
    const mid = GameObject.create("mid", { parent });
    const leaf = GameObject.create("leaf", { parent: mid });
    parent.transform!.position.set(1, 0, 0);
    mid.transform!.position.set(0, 2, 0);
    leaf.transform!.position.set(0, 0, 3);
    engine.step(1 / 60);
    const at = (n: GameObject) => {
      const w = n.transform!.worldPosition;
      return [w.x, w.y, w.z];
    };
    expect(at(leaf)).toEqual([1, 2, 3]);

    leaf.transform!.position.set(0, 0, 5); // a leaf
    expect(at(leaf)).toEqual([1, 2, 5]);

    parent.transform!.position.set(10, 0, 0); // a parent with a subtree
    expect(at(leaf)).toEqual([10, 2, 5]);
    expect(at(mid)).toEqual([10, 2, 0]);

    mid.transform!.position.set(0, 4, 0);
    leaf.transform!.position.set(1, 1, 1);
    expect(at(leaf)).toEqual([11, 5, 1]);
  });
});
