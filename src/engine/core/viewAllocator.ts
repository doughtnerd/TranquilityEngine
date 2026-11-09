import type { RenderSurface } from "../render/RenderSurface";
import type { World } from "./World";

/** Where local input listens (ADR 0034): the Engine passes `Input`; tests pass a fake. */
export interface ViewInputPort {
  /** Listen to `canvas` from scratch. */
  attach(canvas: HTMLCanvasElement): void;
  /** Move to another canvas, keeping what's held: it's the same keyboard and mouse. */
  retarget(canvas: HTMLCanvasElement): void;
  detach(): void;
}

export interface ViewAllocatorOptions {
  /** The Engine's container: the main view's surface goes in it. Null: headless, no surfaces (input still moves). */
  container: HTMLElement | null;
  /** A drawing surface for `world` in `element` (`createRenderSurface`). */
  createSurface(element: HTMLElement, world: World): RenderSurface;
  input: ViewInputPort;
}

/** What a World asked for when it was created (`WorldConfig.renders`, `WorldConfig.input`). */
export interface ViewWish {
  renders: boolean;
  /** Undefined: input follows the view. */
  input: boolean | undefined;
}

/** One World's place among the views (`Engine._viewStates`). */
export interface ViewState {
  readonly renders: boolean;
  readonly mainView: boolean;
  readonly extraView: boolean;
  readonly viewHanded: boolean;
}

/** One `handView`: the World that gave the main view up (null once destroyed), its hidden surface, and the World given it. */
interface HandOver {
  from: World | null;
  surface: RenderSurface | null;
  readonly to: World;
}

/**
 * Which surface and which input target each of an Engine's Worlds has (ADR 0034, 0068, 0159).
 *
 * - One **main view**: the canvas in the Engine's container, held by the first World that wants it;
 *   when that World goes, the next one that wants it takes it.
 * - **Tiles** (`attachView`, the editor's tiled game view): extra surfaces; a tiled World taking the
 *   main view gives its tile up.
 * - **Hand-overs** (`handView`, a lobby's match World): the main view passes to another World as if it
 *   had always had it; the old surface is kept hidden until it's handed back. They nest, and unwind
 *   innermost first; destroying the World given the view hands it back; destroying the World that gave
 *   it up lets the other keep it.
 * - **Input** goes to the World `focusInput` picked while it lives, else the main view's, except
 *   Worlds whose config sets `input`; it listens to that World's canvas.
 *
 * It sets `world.render` (the surface components release into) and `world._takesInput`.
 */
export class ViewAllocator {
  /** Candidates for the view and input, in creation order. */
  private readonly worlds: World[] = [];
  private readonly wishes = new Map<World, ViewWish>();
  private mainWorld: World | null = null;
  private main: RenderSurface | null = null;
  private readonly tiles = new Map<World, RenderSurface>();
  /** Innermost last. */
  private readonly handOvers: HandOver[] = [];
  private inputWorld: World | null = null;
  private inputCanvas: HTMLCanvasElement | null = null;
  private variantReport = false;

  constructor(private readonly options: ViewAllocatorOptions) {}

  /** A World was created: it may take the main view, if no World has it. */
  add(world: World, wish: ViewWish): void {
    this.worlds.push(world);
    this.wishes.set(world, wish);
    this.assign();
  }

  /** A World was destroyed: it's no longer a candidate for the view or input. Its surfaces stay until `release`. */
  retire(world: World): void {
    const i = this.worlds.indexOf(world);
    if (i >= 0) this.worlds.splice(i, 1);
  }

  /**
   * A destroyed World is torn down (its objects already released): its tile and the hidden surface it
   * left go, hand-overs given to it unwind, and the main view passes on if it had it.
   */
  release(world: World): void {
    this.retire(world);
    this.wishes.delete(world);
    this.tiles.get(world)?.dispose();
    this.tiles.delete(world);
    if (world === this.inputWorld) this.inputWorld = null;
    for (const h of this.handOvers) {
      if (h.from !== world) continue;
      h.surface?.dispose();
      h.surface = null;
      h.from = null;
    }
    const given = this.handOvers.findIndex((h) => h.to === world);
    if (given >= 0) this.unwind(given);
    if (world === this.mainWorld) {
      world.render = null;
      this.main?.releaseWorld();
      this.mainWorld = null;
    }
    this.assign();
  }

  /** The surface `world` draws to: the main view or its tile; null if it's on no screen. */
  surfaceOf(world: World): RenderSurface | null {
    return world === this.mainWorld ? this.main : (this.tiles.get(world) ?? null);
  }

  /** Whether `world` asked to render. */
  renders(world: World): boolean {
    return this.wishes.get(world)?.renders ?? false;
  }

  state(world: World): ViewState {
    return {
      renders: this.renders(world),
      mainView: world === this.mainWorld,
      extraView: this.tiles.has(world),
      viewHanded: this.handOvers.some((h) => h.from === world),
    };
  }

  /**
   * Give the main view, and input with it, to `world` (ADR 0068). Returns a function that hands it back
   * (a no-op once done); handing back an outer hand-over hands back the ones over it too.
   */
  handView(world: World): () => void {
    if (!this.renders(world)) throw new Error(`World "${world.name}" doesn't render, so it can't take the view.`);
    if (world === this.mainWorld) return () => {};
    if (this.handOvers.some((h) => h.from === world)) throw new Error(`World "${world.name}" handed its view to another World; hand that one back first.`);
    this.dropTile(world); // Input moves off its canvas below, keeping what's held
    const from = this.mainWorld;
    let surface: RenderSurface | null = null;
    if (from) {
      from.render = null;
      surface = this.main;
      if (surface) surface.canvas.style.display = "none";
      this.main = null;
    }
    const handOver: HandOver = { from, surface, to: world };
    this.handOvers.push(handOver);
    this.mainWorld = world;
    this.claimMain(world);
    this.inputWorld = null; // input follows the view
    this.applyInput();
    return () => {
      const at = this.handOvers.indexOf(handOver);
      if (at >= 0) this.unwind(at);
    };
  }

  /**
   * Draw `world` to a surface of its own in `element` (an editor tile). Returns a function that removes
   * it; it also goes when the World is destroyed or takes the main view, or on `dispose`.
   */
  attachView(world: World, element: HTMLElement): () => void {
    if (world === this.mainWorld) throw new Error(`World "${world.name}" has the main view already.`);
    if (this.handOvers.some((h) => h.from === world)) throw new Error(`World "${world.name}" handed its view to another World.`);
    if (this.tiles.has(world)) throw new Error(`World "${world.name}" has a view already.`);
    const surface = this.newSurface(element, world);
    this.tiles.set(world, surface);
    world.render = surface;
    this.applyInput(); // if it has input, Input listens to its canvas now
    return () => {
      if (this.tiles.get(world) !== surface) return; // gone with its World, or replaced
      this.tiles.delete(world);
      // Its renderer objects live in this surface and go with it; the World runs on without one.
      world.render = null;
      surface.dispose();
      if (this.inputCanvas === surface.canvas) this.inputCanvas = null;
      if (this.inputWorld === world) this.inputWorld = null; // no surface to point at: input goes back to the main view
      this.applyInput();
    };
  }

  /** Give local input to `world` (null: back to the main view's World), except Worlds whose config sets `input`. */
  focusInput(world: World | null): void {
    this.inputWorld = world;
    this.applyInput();
  }

  /** ADR 0080: every surface, now and later, logs shader variants compiled after loading. */
  setVariantReport(on: boolean): void {
    this.variantReport = on;
    this.main?._setVariantReport?.(on);
    for (const s of this.tiles.values()) s._setVariantReport?.(on);
  }

  /** Dispose every surface, hidden ones included, and stop listening to input. */
  dispose(): void {
    this.worlds.length = 0;
    this.wishes.clear();
    for (const s of this.tiles.values()) s.dispose();
    this.tiles.clear();
    for (const h of this.handOvers.splice(0)) h.surface?.dispose();
    this.main?.dispose();
    this.main = null;
    this.mainWorld = null;
    this.inputWorld = null;
    this.inputCanvas = null;
    this.options.input.detach();
  }

  /** Give the main view to the first World that wants it, if no live World has it. */
  private assign(): void {
    if (!this.mainWorld || !this.worlds.includes(this.mainWorld)) {
      const next = this.worlds.find((w) => this.renders(w)) ?? null;
      this.mainWorld = next;
      if (next) {
        this.dropTile(next); // a tiled World gives its tile up for the main view
        this.claimMain(next);
      }
    }
    this.applyInput();
  }

  /** `world` draws to the main surface, made now if there's none (and a container). */
  private claimMain(world: World): void {
    if (!this.options.container) return;
    this.main ??= this.newSurface(this.options.container, world);
    world.render = this.main;
  }

  private dropTile(world: World): void {
    const tile = this.tiles.get(world);
    if (!tile) return;
    this.tiles.delete(world);
    tile.dispose();
  }

  /** Hand back the main view of every hand-over from index `at` on, innermost first. */
  private unwind(at: number): void {
    while (this.handOvers.length > at) {
      const h = this.handOvers.pop()!;
      if (!h.from) continue; // the World that gave the view up is gone: the one given it keeps it
      if (h.to.render === this.main) h.to.render = null;
      this.main?.dispose(); // the given World's renderer objects live in it and go with it
      this.main = h.surface;
      if (this.main) this.main.canvas.style.display = "block";
      h.from.render = this.main;
      this.mainWorld = h.from;
      this.inputWorld = null;
    }
    this.applyInput();
  }

  private applyInput(): void {
    const target = this.inputWorld ?? this.mainWorld;
    for (const world of this.worlds) world._takesInput = this.wishes.get(world)?.input ?? world === target;
    const canvas = target ? this.surfaceOf(target)?.canvas : undefined;
    if (canvas && canvas !== this.inputCanvas) {
      if (this.inputCanvas) this.options.input.retarget(canvas);
      else this.options.input.attach(canvas);
      this.inputCanvas = canvas;
    }
  }

  private newSurface(element: HTMLElement, world: World): RenderSurface {
    const surface = this.options.createSurface(element, world);
    if (this.variantReport) surface._setVariantReport?.(true);
    return surface;
  }
}
