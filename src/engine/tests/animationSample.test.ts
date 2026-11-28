// The Animation sample (ADR 0031, 0370–0372): its scenes load and animate headless, through the public API. The
// Sprout's graph goes Idle → Move on its speed parameter and hops on request (the hop's `land` notify reaches its
// behaviour), the Lantern's property clip moves the gem and recolours the glow and fires `chime`, the tween cubes
// finish rounds, the Orrery's timeline moves its moons and switches the flash, and the sprites page's flipbook critter
// walks and turns.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Light, SceneManager, SpriteRenderer } from "../../myco";
import { readProject } from "../../server/project";
import { SproutController } from "../../../samples/animation/scripts/behaviors/SproutController";
import { GemPulse } from "../../../samples/animation/scripts/behaviors/GemPulse";
import { TweenShowcase } from "../../../samples/animation/scripts/behaviors/TweenShowcase";
import { Walker } from "../../../samples/animation/scripts/behaviors/Walker";
import "../../../samples/animation/scripts/behaviors/Bob";
import "../../../samples/animation/scripts/behaviors/LabHud";
import "../../../samples/animation/scripts/behaviors/SceneKeys";

const SAMPLE = fileURLToPath(new URL("../../../samples/animation", import.meta.url));
const dt = 1 / 60;
const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function start(scene: string) {
  const project = await readProject(SAMPLE);
  Assets.clearSources();
  Assets.addSource(project.assets);
  const engine = await Engine.create({ headless: true, project: project.settings });
  engines.push(engine);
  await SceneManager.load(scene);
  return engine;
}
const run = (engine: Engine, seconds: number, each?: () => void) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    each?.();
    engine.step(dt);
  }
};
/** A node of the loaded scene by name. */
function find(name: string): GameObject {
  const walk = (n: GameObject): GameObject | null => (n.name === name ? n : n.children.reduce<GameObject | null>((hit, c) => hit ?? walk(c), null));
  const hit = walk(GameObject.findObjectOfType(SproutController)!.node.world.root);
  if (!hit) throw new Error(`no node named ${name}`);
  return hit;
}
/** Steps until `check` passes (loads finish between steps), at most `seconds` of game time. */
async function until(engine: Engine, check: () => void, seconds = 5): Promise<void> {
  let left = Math.round(seconds / dt);
  await vi.waitFor(
    () => {
      if (left-- > 0) engine.step(dt);
      check();
    },
    { timeout: 20_000, interval: 1 },
  );
}

describe("animation sample", () => {
  it("the Sprout's graph idles, moves on speed and hops on request, and the landing notify arrives", async () => {
    const engine = await start("scenes/main.scene.json");
    const control = GameObject.findObjectOfType(SproutController)!;
    const anim = find("Sprout").getBehavior(Animator)!;
    control.useKeyboard = false;
    control.autopilot = false;
    control.speed = 0;
    await until(engine, () => expect(anim.state().name).toBe("Idle"));

    control.speed = 1.5;
    await until(engine, () => expect(anim.state().name).toBe("Move"), 2);

    control.hop();
    await until(engine, () => expect(anim.state().name).toBe("Hop"), 1);
    await until(engine, () => expect(control.landings).toBe(1), 2);
    // Back to Move on its own (speed is still above the threshold).
    await until(engine, () => expect(anim.state().name).toBe("Move"), 2);

    control.speed = 0;
    await until(engine, () => expect(anim.state().name).toBe("Idle"), 2);
  });

  it("the Lantern's clip moves the gem, recolours the glow and chimes", async () => {
    const engine = await start("scenes/main.scene.json");
    const gem = find("Gem").transform!;
    const glow = find("Glow").getBehavior(Light)!;
    const pulse = find("Lantern").getBehavior(GemPulse)!;
    const heights = new Set<string>();
    const reds = new Set<string>();
    await until(engine, () => {
      heights.add(gem.position.y.toFixed(1));
      reds.add(glow.color.r.toFixed(1));
      expect(pulse.chimes).toBeGreaterThanOrEqual(1);
    }, 4);
    expect(heights.size).toBeGreaterThan(2);
    expect(reds.size).toBeGreaterThan(2);
  });

  it("the tween cubes finish a round and the Orrery's timeline moves its moons and flashes", async () => {
    const engine = await start("scenes/main.scene.json");
    const show = GameObject.findObjectOfType(TweenShowcase)!;
    const moon = find("Moon A").transform!;
    const flash = find("Flash");
    const xs: number[] = [];
    const flashes = new Set<boolean>();
    await until(engine, () => {
      xs.push(moon.position.x);
      flashes.add(flash.active);
      expect(show.rounds).toBeGreaterThanOrEqual(1);
    }, 5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1.5);
    expect(flashes).toEqual(new Set([true, false]));
  });

  it("the sprites page's critter walks its flipbook to the end and turns round", async () => {
    const engine = await start("scenes/sprites.scene.json");
    const walker = GameObject.findObjectOfType(Walker)!;
    const sprite = walker.node.getBehavior(SpriteRenderer)!;
    const frames = new Set<string>();
    await until(engine, () => {
      frames.add(String(sprite.sprite));
      expect(walker.turns).toBeGreaterThanOrEqual(1);
    }, 6);
    expect(frames.size).toBeGreaterThan(3);
    expect(sprite.flipX).toBe(true);
    run(engine, 0.1);
  });
});
