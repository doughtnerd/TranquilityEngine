// The game view in play mode (ADR 0032, 0034): the Engine's main view, plus a tile for each other
// World that wants to render, made and removed as Worlds come and go (game code can create them
// at runtime). Clicking a tile gives its World local input. A strip lists every World, headless
// ones (a server, multiplayer play's thin clients) included, with pause and resume, and Step to
// advance just that World one frame (paused or not). The elements are plain DOM rather than Preact:
// each tile's surface must stay the same element for as long as its World draws into it.
import type { Engine } from "../engine";
import { attachWorldView, focusWorldInput, stepEngineWorld, worldViewStates, type WorldViewState } from "../engine/editor";

/** One stepped frame, in seconds (play mode's Step): a 60 Hz frame. A World ticking slower runs its fixed step every few steps, when due. */
export const STEP_SECONDS = 1 / 60;

export interface GameView {
  /** The main view's element: the Engine's container. */
  readonly main: HTMLElement;
  /** The play bar's own tools (Gizmos, Stats), after the World strip. */
  readonly tools: HTMLElement;
  /** A layer over the whole game view for overlays such as Stats (it takes no clicks itself). */
  readonly hud: HTMLElement;
  /**
   * Start following `engine`'s Worlds: tiles, input focus and the strip, updated every frame.
   * `thin`: multiplayer play's thin clients (ADR 0033 §9), noted as such in the strip.
   */
  attach(engine: Engine, options?: { thin?: readonly string[] }): void;
  /** Stop following, remove the tiles' surfaces and empty the container. */
  dispose(): void;
}

interface Tile {
  readonly element: HTMLDivElement;
  readonly label: HTMLSpanElement;
  /** Removes the World's surface (no-op for the main view, which the Engine owns). */
  readonly detach: () => void;
}

const div = (className: string) => Object.assign(document.createElement("div"), { className });

/** Lay out the game view in `container` (`#game-view`). The Engine is created into `main`, then `attach`ed. */
export function createGameView(container: HTMLElement): GameView {
  const tilesEl = div("game-tiles");
  const strip = div("world-strip");
  strip.setAttribute("role", "toolbar");
  strip.setAttribute("aria-label", "Worlds");
  const tools = div("play-tools");
  const bar = div("play-bar");
  bar.append(strip, tools);
  const hud = div("play-hud");
  container.replaceChildren(tilesEl, bar, hud);

  const makeTile = (): Omit<Tile, "detach"> & { surface: HTMLDivElement } => {
    const element = div("game-tile");
    const surface = div("game-surface");
    const label = Object.assign(document.createElement("span"), { className: "game-tile-label" });
    element.append(surface, label);
    tilesEl.append(element);
    return { element, label, surface };
  };
  const mainTile = { ...makeTile(), detach: () => {} };
  /** Tiles of the other rendering Worlds, by World name. */
  const tiles = new Map<string, Tile>();
  let frame = 0;
  let stripKey = "";
  let thin: ReadonlySet<string> = new Set();

  const update = (engine: Engine) => {
    const states = worldViewStates(engine);
    const main = states.find((s) => s.mainView) ?? null;
    const others = states.filter((s) => s.renders && !s.mainView);

    for (const [name, tile] of tiles) {
      if (others.some((s) => s.name === name)) continue;
      tile.detach(); // the World is gone, or has the main view now (the Engine dropped its surface)
      tile.element.remove();
      tiles.delete(name);
    }
    for (const s of others) {
      if (tiles.has(s.name)) continue;
      const tile = makeTile();
      const detach = attachWorldView(engine, s.name, tile.surface);
      tiles.set(s.name, { ...tile, detach });
      tile.element.addEventListener("pointerdown", () => engine.findWorld(s.name) && focusWorldInput(engine, s.name), { capture: true });
    }

    const tiled = tiles.size > 0;
    container.classList.toggle("tiled", tiled);
    const show = (tile: Tile, s: WorldViewState | null) => {
      tile.element.dataset.world = s?.name ?? "";
      tile.label.textContent = s?.name ?? "";
      tile.element.classList.toggle("has-input", tiled && !!s?.takesInput);
      tile.element.setAttribute("aria-label", s ? `World ${s.name}${s.takesInput ? " (has input)" : ""}` : "Game");
    };
    show(mainTile, main);
    for (const [name, tile] of tiles) show(tile, states.find((s) => s.name === name)!);

    const key = JSON.stringify(states.map((s) => [s.name, s.paused, s.renders]));
    if (key !== stripKey) {
      stripKey = key;
      renderStrip(engine, states);
    }
  };

  const renderStrip = (engine: Engine, states: readonly WorldViewState[]) => {
    strip.replaceChildren(
      ...states.map((s) => {
        const isThin = thin.has(s.name);
        const item = div(`world-item${s.paused ? " paused" : ""}${isThin ? " thin" : ""}`);
        item.dataset.world = s.name;
        const name = Object.assign(document.createElement("span"), { className: "world-name", textContent: s.name });
        const note = Object.assign(document.createElement("span"), {
          className: "world-note",
          textContent: [isThin ? "thin client" : s.renders ? "" : "headless", s.paused ? "paused" : ""].filter(Boolean).join(", "),
        });
        const button = Object.assign(document.createElement("button"), { textContent: s.paused ? "Resume" : "Pause" });
        button.setAttribute("aria-label", `${s.paused ? "Resume" : "Pause"} ${s.name}`);
        button.addEventListener("click", () => {
          const handle = engine.findWorld(s.name);
          if (!handle) return;
          if (handle.paused) handle.resume();
          else handle.pause();
          update(engine);
        });
        const step = Object.assign(document.createElement("button"), {
          textContent: "Step",
          className: "world-step",
          title: `Advance ${s.name} one frame (a fixed step when one is due), paused or not`,
        });
        step.setAttribute("aria-label", `Step ${s.name}`);
        step.addEventListener("click", () => {
          if (!engine.findWorld(s.name)) return;
          try {
            stepEngineWorld(engine, s.name, STEP_SECONDS);
          } catch (err) {
            console.error(`[myco] Couldn't step World "${s.name}":`, err);
          }
        });
        item.append(name, note, button, step);
        return item;
      }),
    );
  };

  return {
    main: mainTile.surface,
    tools,
    hud,
    attach(engine, options) {
      thin = new Set(options?.thin ?? []);
      mainTile.element.addEventListener("pointerdown", () => focusWorldInput(engine, null), { capture: true });
      const loop = () => {
        frame = requestAnimationFrame(loop); // first, so an error below doesn't stop the view following its Worlds
        try {
          update(engine);
        } catch (err) {
          console.error("[myco] The game view couldn't update:", err);
        }
      };
      loop();
    },
    dispose() {
      cancelAnimationFrame(frame);
      for (const tile of tiles.values()) tile.detach();
      tiles.clear();
      container.replaceChildren();
      container.classList.remove("tiled");
    },
  };
}
