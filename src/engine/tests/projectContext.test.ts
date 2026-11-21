// ADR 0319: an Engine acquires one project context on create and releases it on dispose. Asset sources it was given
// go with it; the storage backend goes back to the one that was in use before it (the editor's, after a headless Play).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, MemoryStorage, Storage } from "../index";

const engines: Engine[] = [];
const create = async (options: Parameters<typeof Engine.create>[0]) => {
  const engine = await Engine.create({ headless: true, ...options });
  engines.push(engine);
  return engine;
};

let base: MemoryStorage;
beforeEach(() => {
  base = new MemoryStorage();
  Storage.use(base);
});
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

describe("an Engine's project context (ADR 0319)", () => {
  it("registers the asset sources it was given while it lives and removes them on dispose", async () => {
    const source = Assets.fromObject({ "context/a.json": { a: 1 } });
    const engine = await create({ assets: source });
    expect(Assets.json("context/a.json")).toEqual({ a: 1 });
    engine.dispose();
    expect(Assets.has("context/a.json")).toBe(false);
  });

  it("removes its asset sources when the bootstrap fails", async () => {
    const source = Assets.fromObject({ "context/b.json": { b: 1 } });
    await expect(Engine.create({ headless: true, assets: source, bootstrap: () => {} })).rejects.toThrow(/no Worlds/);
    expect(Assets.has("context/b.json")).toBe(false);
  });

  it("puts back the storage that was in use before it, once disposed", async () => {
    const own = new MemoryStorage();
    const engine = await create({ storage: own });
    await Storage.save("k", 1);
    expect(await own.load("saves", "k")).toBe(1);
    engine.dispose();
    await Storage.save("k", 2);
    expect(await base.load("saves", "k")).toBe(2);
    expect(await own.load("saves", "k")).toBe(1);
  });

  it("gives the editor's storage back when a nested headless Play Engine is disposed", async () => {
    const editorStorage = new MemoryStorage();
    await create({ kind: "editor", storage: editorStorage });
    const play = await create({}); // headless: a memory store of its own
    await Storage.save("during", true);
    expect(await editorStorage.load("saves", "during")).toBeUndefined();
    play.dispose();
    await Storage.save("after", true);
    expect(await editorStorage.load("saves", "after")).toBe(true);
  });

  it("keeps the most recent live Engine's storage when an earlier one is disposed first", async () => {
    const first = new MemoryStorage();
    const second = new MemoryStorage();
    const a = await create({ storage: first });
    const b = await create({ storage: second });
    a.dispose();
    await Storage.save("x", 1);
    expect(await second.load("saves", "x")).toBe(1);
    b.dispose();
    await Storage.save("y", 1);
    expect(await base.load("saves", "y")).toBe(1);
    expect(await first.load("saves", "y")).toBeUndefined();
  });

  it("releases once: disposing again changes nothing", async () => {
    const outer = new MemoryStorage();
    await create({ storage: outer });
    const inner = await create({ storage: new MemoryStorage() });
    inner.dispose();
    const later = new MemoryStorage();
    await create({ storage: later });
    inner.dispose();
    await Storage.save("z", 1);
    expect(await later.load("saves", "z")).toBe(1);
  });
});
