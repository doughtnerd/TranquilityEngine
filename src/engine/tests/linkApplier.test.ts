import { describe, expect, it } from "vitest";
import { LinkApplier } from "../core/linkApplier";
import { World } from "../core/World";
import type { LinkConfig } from "../core/worlds";

// ADR 0323: the link applier is the one place that notices "a World named in a link has appeared",
// for links its Engine doesn't connect itself (the dedicated server's links from client Worlds it skips).

function applier(): { links: LinkApplier; live: Set<World> } {
  const live = new Set<World>();
  const links = new LinkApplier({ find: (name) => [...live].find((w) => w.name === name) ?? null, alive: (w) => live.has(w) });
  return { links, live };
}

function create(live: Set<World>, links: LinkApplier, name: string): World {
  const world = new World("server", {}, { name, tags: ["server"] });
  live.add(world);
  links.worldCreated(world);
  return world;
}

const toArena: LinkConfig = { from: "Game", to: "Arena", transport: "websocket", options: { port: 7000 } };

describe("LinkApplier.watch (ADR 0323)", () => {
  it("acts on a World a watched link names at the start of the next frame, not when it's created", () => {
    const { links, live } = applier();
    const seen: [string, LinkConfig][] = [];
    links.watch([toArena], (world, link) => seen.push([world.name, link]));
    const arena = create(live, links, "Arena");
    create(live, links, "Other");
    expect(seen).toEqual([]); // the code that created it hasn't run on yet
    links.beginFrame();
    expect(seen).toEqual([[arena.name, toArena]]);
    links.beginFrame();
    expect(seen).toHaveLength(1); // once per World
  });

  it("skips a World destroyed before the frame, and stops acting once the watch is removed", () => {
    const { links, live } = applier();
    const seen: string[] = [];
    const unwatch = links.watch([toArena], (world) => seen.push(world.name));
    live.delete(create(live, links, "Arena"));
    links.beginFrame();
    expect(seen).toEqual([]);

    live.clear();
    create(live, links, "Arena");
    unwatch();
    links.beginFrame();
    create(live, links, "Arena");
    links.beginFrame();
    expect(seen).toEqual([]);
  });

  it("keeps going when an action throws, logging it", () => {
    const { links, live } = applier();
    const seen: string[] = [];
    links.watch([toArena], () => {
      throw new Error("boom");
    });
    links.watch([toArena], (world) => seen.push(world.name));
    const error = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      create(live, links, "Arena");
      links.beginFrame();
    } finally {
      console.error = error;
    }
    expect(seen).toEqual(["Arena"]);
    expect(String(logged[0]?.[0])).toContain('World "Arena"');
  });
});
