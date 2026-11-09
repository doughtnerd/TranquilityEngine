import { afterEach, describe, expect, it, vi } from "vitest";

// `Engine._handView` (ADR 0068's match World taking the screen) through a whole Engine: the main
// view, and input with it, pass to another World and come back, and each World's frame draws to
// the surface it has. The hand-over, tile and input rules themselves: viewAllocator.test.ts (ADR 0159). Surfaces are fakes here (no WebGL in Node): each records
// which World it drew, whether its canvas shows, and whether it was disposed.

interface FakeSurface {
  readonly id: number;
  readonly canvas: { style: { display: string } };
  drew: string[];
  disposed: boolean;
}
const surfaces: FakeSurface[] = [];

vi.mock("../render/babylon/BabylonSurface", async (importOriginal) => {
  const original = await importOriginal<typeof import("../render/babylon/BabylonSurface")>();
  class FakeBabylonSurface {
    readonly id = surfaces.length;
    readonly canvas = { style: { display: "block" } };
    drew: string[] = [];
    disposed = false;
    constructor() {
      surfaces.push(this as unknown as FakeSurface);
      // Anything else the engine asks of a surface is a no-op.
      return new Proxy(this, { get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : () => undefined) });
    }
    sync(): void {}
    render(world: { name: string }): void {
      this.drew.push(world.name);
    }
    releaseWorld(): void {}
    dispose(): void {
      this.disposed = true;
    }
  }
  return { ...original, BabylonSurface: FakeBabylonSurface };
});

const { Engine } = await import("../core/Engine");
const { Input } = await import("../input/Input");

type EngineInstance = import("../core/Engine").Engine;
const engines: EngineInstance[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  surfaces.splice(0);
  vi.restoreAllMocks();
});

async function create(headless = false) {
  // Input listens to the canvas the view has; there's no DOM here.
  vi.spyOn(Input, "attach").mockImplementation(() => {});
  vi.spyOn(Input, "retarget").mockImplementation(() => {});
  const engine = await Engine.create({
    headless,
    container: headless ? undefined : ({} as HTMLElement),
    bootstrap: { worlds: [{ name: "Menu" }, { name: "Lobby", tags: ["server"] }] },
  });
  engines.push(engine);
  return engine;
}

const states = (engine: EngineInstance) =>
  Object.fromEntries(engine._viewStates().map((s) => [s.name, { main: s.mainView, input: s.takesInput, handed: s.viewHanded }]));

describe("Engine._handView", () => {
  it("gives another World the main view and input, keeps the old surface hidden, and hands it back", async () => {
    const engine = await create();
    const [menuSurface] = surfaces;
    engine.createWorld({ name: "Match", tags: ["client"] });
    engine.step(1 / 60);
    expect(menuSurface.drew).toEqual(["Menu"]); // the Match World wants the view, but the Menu has it

    const handBack = engine._handView("Match");
    expect(states(engine)).toMatchObject({
      Menu: { main: false, input: false, handed: true },
      Match: { main: true, input: true, handed: false },
    });
    expect(surfaces).toHaveLength(2);
    const matchSurface = surfaces[1];
    expect(menuSurface.canvas.style.display).toBe("none"); // kept, hidden: the Match surface takes its place
    expect(menuSurface.disposed).toBe(false);
    engine.step(1 / 60);
    expect(menuSurface.drew).toEqual(["Menu"]);
    expect(matchSurface.drew).toEqual(["Match"]);

    // Focusing the main view (the editor does on a click in the game view) keeps input with Match.
    engine._focusInput(null);
    expect(states(engine).Match.input).toBe(true);
    expect(() => engine._attachView("Menu", {} as HTMLElement)).toThrow(/handed its view/);

    handBack();
    expect(states(engine)).toMatchObject({
      Menu: { main: true, input: true, handed: false },
      Match: { main: false, input: false },
    });
    expect(matchSurface.disposed).toBe(true);
    expect(menuSurface.canvas.style.display).toBe("block");
    engine.step(1 / 60);
    expect(menuSurface.drew).toEqual(["Menu", "Menu"]);
    expect(matchSurface.drew).toEqual(["Match"]);
    handBack(); // a no-op now
    expect(states(engine).Menu.main).toBe(true);
  });

  it("hands the view back when the World given it is destroyed, and names unknown Worlds", async () => {
    const engine = await create();
    const match = engine.createWorld({ name: "Match", tags: ["client"] });
    engine._handView("Match");
    match.destroy();
    expect(states(engine).Menu).toEqual({ main: true, input: true, handed: false });
    expect(surfaces[1].disposed).toBe(true);
    expect(() => engine._handView("Nope")).toThrow(/no World/);
  });

  it("disposes hidden surfaces with the Engine", async () => {
    const engine = await create();
    engine.createWorld({ name: "Match", tags: ["client"] });
    engine._handView("Match");
    engine.dispose();
    engines.splice(0);
    expect(surfaces.every((s) => s.disposed)).toBe(true);
  });
});
