import type { Page } from "./fixtures";

/**
 * Reading the running game's Worlds the way project scripts can (CLAUDE.md: browser specs use the
 * public `myco` API, never internals by name).
 *
 * The editor's `window.playEngine` is the play Engine; `globalThis.__myco` is the engine module
 * scripts import as "myco". The default World is `playEngine.world`. Another World's nodes aren't
 * reachable from a `WorldHandle` (ADR 0032), so, like a game script, the spec defines a system
 * (`myco.defineSystem`) that runs in every World and keeps the `ctx.world` each run is given,
 * keyed by that World's handle (`myco.Engine.findWorld`, which looks in the current World's
 * Engine, so the edit Engine's Worlds never answer for the play Engine's). A World is known once it
 * has stepped a frame; it stays readable while paused.
 *
 * Nodes are read through the public GameObject API: `root`, `children`, `getComponents`.
 */

/** A node, as page callbacks see it (the public GameObject surface they use). */
export interface LiveNode {
  readonly name: string;
  readonly isValid: boolean;
  readonly children: LiveNode[];
  readonly transform: { position: { x: number; y: number; z: number; set(x: number, y: number, z: number): void } } | null;
  getComponents<T = unknown>(type: unknown): T[];
  addBehavior(type: unknown, init?: object): unknown;
}

/** A World, as page callbacks see it (`SystemContext.world` / `Engine.world`'s public members). */
export interface LiveWorld {
  readonly name: string;
  readonly root: LiveNode;
  readonly time: { frameCount: number };
  readonly sceneNodes: LiveNode[];
}

/** The engine module scripts import as "myco", loosely typed: page callbacks pick what they use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Myco = Record<string, any>;

/** What a page callback gets: the World (null if there's no such World, or it hasn't stepped yet), the myco module, and a helper. */
export interface LiveTools {
  readonly myco: Myco;
  /** Every component of `type` on `node` and its descendants, depth first. */
  componentsOf<T = unknown>(node: LiveNode, type: unknown): T[];
}

/**
 * Run `fn` in the page with a World of the running game: `world` by name, or the default World
 * (`null`). `fn` is serialized: it may use only its arguments.
 */
export function inLiveWorld<A, R>(page: Page, world: string | null, fn: (w: LiveWorld | null, tools: LiveTools, arg: A) => R, arg: A): Promise<R>;
export function inLiveWorld<R>(page: Page, world: string | null, fn: (w: LiveWorld | null, tools: LiveTools) => R): Promise<R>;
export function inLiveWorld(page: Page, world: string | null, fn: (w: LiveWorld | null, tools: LiveTools, arg: unknown) => unknown, arg?: unknown): Promise<unknown> {
  return page.evaluate(
    ({ world, src, arg }) => {
      type Handle = object;
      const g = globalThis as unknown as {
        __myco?: Myco;
        playEngine?: { world: LiveWorld; findWorld(name: string): Handle | null } | null;
        [key: symbol]: WeakMap<Handle, LiveWorld> | undefined;
      };
      const myco = g.__myco;
      const engine = g.playEngine;
      const callback = (0, eval)(`(${src})`) as (w: LiveWorld | null, tools: LiveTools, arg: unknown) => unknown;
      const componentsOf = <T>(node: LiveNode, type: unknown): T[] => {
        const out: T[] = [];
        const visit = (n: LiveNode) => {
          if (!n.isValid) return;
          out.push(...n.getComponents<T>(type));
          n.children.forEach(visit);
        };
        visit(node);
        return out;
      };
      const tools = { myco: myco ?? {}, componentsOf };
      if (!myco || !engine) return callback(null, tools, arg);
      if (world === null) return callback(engine.world, tools, arg);

      const key = Symbol.for("myco.e2e.liveWorlds");
      let seen = g[key];
      if (!seen) {
        const worlds = (seen = g[key] = new WeakMap());
        myco.defineSystem({
          name: "e2e.LiveWorlds",
          phase: "update",
          worlds: ["*"],
          run(_rows: unknown, ctx: { world: LiveWorld }) {
            const handle = myco.Engine.findWorld(ctx.world.name) as Handle | null;
            if (handle) worlds.set(handle, ctx.world);
          },
        });
      }
      const handle = engine.findWorld(world);
      return callback((handle && seen.get(handle)) ?? null, tools, arg);
    },
    { world, src: fn.toString(), arg },
  );
}
