// The game view in play mode (ADR 0032, 0034): the Engine's main view, plus a tile for each other
// World that wants to render, made and removed as Worlds come and go (game code can create them
// at runtime). Clicking a tile gives its World local input. A strip lists every World, headless
// ones (a server) included, with pause and resume. The elements are plain DOM rather than Preact:
// each tile's surface must stay the same element for as long as its World draws into it.
import type { Engine } from "../engine";
import { attachWorldView, focusWorldInput, worldViewStates, type WorldViewState } from "../engine/editor";

export interface GameView {
  /** The main view's element: the Engine's container. */
  readonly main: HTMLElement;
  /** Start following `engine`'s Worlds: tiles, input focus and the strip, updated every frame. */
  attach(engine: Engine): void;
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
  container.replaceChildren(tilesEl, strip);

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
      tile.element.addEventListener("pointerdown", () => focusWorldInput(engine, s.name), { capture: true });
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
        const item = div(`world-item${s.paused ? " paused" : ""}`);
        item.dataset.world = s.name;
        const name = Object.assign(document.createElement("span"), { className: "world-name", textContent: s.name });
        const note = Object.assign(document.createElement("span"), {
          className: "world-note",
          textContent: [s.renders ? "" : "headless", s.paused ? "paused" : ""].filter(Boolean).join(", "),
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
        item.append(name, note, button);
        return item;
      }),
    );
  };

  return {
    main: mainTile.surface,
    attach(engine) {
      mainTile.element.addEventListener("pointerdown", () => focusWorldInput(engine, null), { capture: true });
      const loop = () => {
        update(engine);
        frame = requestAnimationFrame(loop);
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
