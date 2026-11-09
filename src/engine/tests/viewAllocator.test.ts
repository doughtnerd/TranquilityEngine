import { describe, expect, it } from "vitest";
import { ViewAllocator, type ViewWish } from "../core/viewAllocator";
import { World } from "../core/World";
import type { RenderSurface } from "../render/RenderSurface";

// ADR 0159: the view allocator's rules (ADR 0034, 0068) with fake surfaces and a fake input port:
// no DOM, no renderer, no Engine.

interface FakeSurface {
  readonly id: number;
  readonly element: string;
  readonly canvas: { id: number; style: { display: string } };
  disposed: boolean;
  released: boolean;
  variantReport: boolean;
}

function setup(headless = false) {
  const surfaces: FakeSurface[] = [];
  const input: string[] = [];
  const views = new ViewAllocator({
    container: headless ? null : ({ id: "main" } as unknown as HTMLElement),
    createSurface: (element) => {
      const id = surfaces.length;
      const s: FakeSurface = { id, element: (element as unknown as { id: string }).id, canvas: { id, style: { display: "block" } }, disposed: false, released: false, variantReport: false };
      surfaces.push(s);
      return {
        canvas: s.canvas,
        dispose: () => void (s.disposed = true),
        releaseWorld: () => void (s.released = true),
        _setVariantReport: (on: boolean) => void (s.variantReport = on),
      } as unknown as RenderSurface;
    },
    input: {
      attach: (c) => void input.push(`attach ${(c as unknown as { id: number }).id}`),
      retarget: (c) => void input.push(`retarget ${(c as unknown as { id: number }).id}`),
      detach: () => void input.push("detach"),
    },
  });
  const worlds = new Map<string, World>();
  const add = (name: string, wish: Partial<ViewWish> = {}) => {
    const world = new World("runtime", {}, { name, tags: ["client"] });
    worlds.set(name, world);
    views.add(world, { renders: true, input: undefined, ...wish });
    return world;
  };
  const surfaceId = (w: World) => (views.surfaceOf(w)?.canvas as unknown as { id: number } | undefined)?.id ?? null;
  const states = () => Object.fromEntries([...worlds].map(([n, w]) => [n, { ...views.state(w), input: w._takesInput }]));
  return { views, surfaces, input, add, surfaceId, states };
}

const tile = (id: string) => ({ id }) as unknown as HTMLElement;

describe("ViewAllocator", () => {
  it("gives the main view to the first World that wants it, and passes it on when that World goes", () => {
    const { views, surfaces, input, add, surfaceId } = setup();
    const lobby = add("Lobby", { renders: false });
    const menu = add("Menu");
    const match = add("Match");
    expect(views.surfaceOf(lobby)).toBeNull();
    expect(surfaceId(menu)).toBe(0);
    expect(menu.render).toBe(views.surfaceOf(menu));
    expect(views.surfaceOf(match)).toBeNull();
    expect([lobby._takesInput, menu._takesInput, match._takesInput]).toEqual([false, true, false]);
    expect(input).toEqual(["attach 0"]);

    views.retire(menu); // destroyed in its own frame: no longer a candidate, torn down later
    views.release(menu);
    expect(surfaces[0]).toMatchObject({ released: true, disposed: false }); // the canvas stays; the next World claims it
    expect(menu.render).toBeNull();
    expect(surfaceId(match)).toBe(0);
    expect(match._takesInput).toBe(true);
    expect(input).toEqual(["attach 0"]); // the same canvas: input stays attached
  });

  it("keeps a World's config input setting whatever the view does", () => {
    const { add } = setup();
    const a = add("A", { input: false });
    const b = add("B", { input: true });
    expect([a._takesInput, b._takesInput]).toEqual([false, true]);
  });

  it("hands the main view over with input, keeps the old surface hidden, and hands it back", () => {
    const { views, surfaces, input, add, surfaceId, states } = setup();
    const menu = add("Menu");
    const match = add("Match");
    const back = views.handView(match);
    expect(states()).toMatchObject({ Menu: { mainView: false, viewHanded: true, input: false }, Match: { mainView: true, input: true } });
    expect(surfaces[0].canvas.style.display).toBe("none");
    expect(menu.render).toBeNull();
    expect(surfaceId(match)).toBe(1);
    expect(input).toEqual(["attach 0", "retarget 1"]);

    views.focusInput(null); // focusing the main view keeps input with the World given it
    expect(match._takesInput).toBe(true);
    expect(() => views.attachView(menu, tile("t"))).toThrow(/handed its view/);

    back();
    expect(states()).toMatchObject({ Menu: { mainView: true, viewHanded: false, input: true }, Match: { mainView: false, input: false } });
    expect(surfaces[1].disposed).toBe(true);
    expect(surfaces[0].canvas.style.display).toBe("block");
    expect(match.render).toBeNull();
    expect(input.at(-1)).toBe("retarget 0");
    back(); // a no-op now
    expect(views.state(menu).mainView).toBe(true);
  });

  it("nests hand-overs and unwinds the inner ones with an outer one; a tile gives way to the main view", () => {
    const { views, surfaces, add, states } = setup();
    add("Menu");
    const a = add("A");
    const b = add("B");
    add("Lobby", { renders: false });
    views.attachView(a, tile("tile"));
    expect(surfaces[1].element).toBe("tile");

    const backA = views.handView(a);
    expect(surfaces[1].disposed).toBe(true);
    views.handView(b);
    expect(states()).toMatchObject({ Menu: { viewHanded: true }, A: { mainView: false, viewHanded: true }, B: { mainView: true, input: true } });
    expect(views.handView(b)).toBeTypeOf("function"); // already has it

    backA();
    expect(states()).toMatchObject({ Menu: { mainView: true, viewHanded: false, input: true }, A: { mainView: false, viewHanded: false }, B: { mainView: false } });
    expect(surfaces.filter((s) => !s.disposed).map((s) => s.id)).toEqual([0]);
  });

  it("refuses Worlds that don't render", () => {
    const { views, add } = setup();
    add("Menu");
    expect(() => views.handView(add("Lobby", { renders: false }))).toThrow(/doesn't render/);
  });

  it("hands the view back when the World given it is torn down", () => {
    const { views, surfaces, add, states } = setup();
    add("Menu");
    const match = add("Match");
    views.handView(match);
    views.release(match);
    expect(states().Menu).toMatchObject({ mainView: true, viewHanded: false, input: true });
    expect(surfaces[0].canvas.style.display).toBe("block");
    expect(surfaces[1].disposed).toBe(true);
  });

  it("lets the World given the view keep it when the World that gave it up is torn down", () => {
    const { views, surfaces, add, states } = setup();
    const menu = add("Menu");
    const match = add("Match");
    const back = views.handView(match);
    views.release(menu);
    expect(surfaces[0].disposed).toBe(true); // its hidden surface goes with it
    back();
    expect(states().Match).toMatchObject({ mainView: true, viewHanded: false, input: true });
    expect(surfaces[1].disposed).toBe(false);
  });

  it("moves input to a focused tile's canvas and back when the tile goes", () => {
    const { views, surfaces, input, add, surfaceId } = setup();
    const menu = add("Menu");
    const other = add("Other");
    const remove = views.attachView(other, tile("tile"));
    expect(surfaceId(other)).toBe(1);
    expect(() => views.attachView(other, tile("again"))).toThrow(/has a view already/);
    expect(() => views.attachView(menu, tile("again"))).toThrow(/main view already/);
    views.focusInput(other);
    expect([menu._takesInput, other._takesInput]).toEqual([false, true]);
    expect(input).toEqual(["attach 0", "retarget 1"]);

    remove();
    expect(surfaces[1].disposed).toBe(true);
    expect(other.render).toBeNull();
    expect([menu._takesInput, other._takesInput]).toEqual([true, false]);
    expect(input.at(-1)).toBe("attach 0"); // its canvas is gone: listen afresh
    remove(); // a no-op now
  });

  it("disposes a torn-down World's tile, and gives input back to the main view", () => {
    const { views, surfaces, add } = setup();
    const menu = add("Menu");
    const other = add("Other");
    views.attachView(other, tile("tile"));
    views.focusInput(other);
    views.release(other);
    expect(surfaces[1].disposed).toBe(true);
    expect(menu._takesInput).toBe(true);
  });

  it("moves input headless, with no surfaces", () => {
    const { views, surfaces, input, add, states } = setup(true);
    add("Menu");
    const match = add("Match");
    const back = views.handView(match);
    expect(states()).toMatchObject({ Menu: { mainView: false, input: false }, Match: { mainView: true, input: true } });
    back();
    expect(states()).toMatchObject({ Menu: { mainView: true, input: true }, Match: { mainView: false, input: false } });
    expect(surfaces).toHaveLength(0);
    expect(input).toEqual([]);
  });

  it("reports shader variants on every surface, now and later, and disposes hidden ones", () => {
    const { views, surfaces, input, add } = setup();
    add("Menu");
    const match = add("Match");
    views.setVariantReport(true);
    views.handView(match);
    views.attachView(add("Tile"), tile("tile"));
    expect(surfaces.map((s) => s.variantReport)).toEqual([true, true, true]);
    views.dispose();
    expect(surfaces.every((s) => s.disposed)).toBe(true);
    expect(input.at(-1)).toBe("detach");
  });
});
