// The weather follows the match's replicated storm (rules.ts): the waves grow in every World, so
// the server's cannonballs splash on the same sea the clients draw; clients also darken the sky
// and fog, dim the sun, and turn on the rain and its sound. Lightning flashes come as effects.
import { AudioSource, Camera, Fog, GameObject, Light, ParticleSystem, Time, WaterSurface, defineSystem } from "myco";
import { STORM_WAVES, game } from "./data";

/** Per World: the storm's strength, eased 0..1, and each thing's calm value. */
interface Calm {
  storm: number;
  waves: Map<WaterSurface, number>;
  fog: Map<Fog, { color: [number, number, number]; near: number; far: number }>;
  lights: Map<Light, number>;
  seas: Map<WaterSurface, { deep: [number, number, number]; shallow: [number, number, number] }>;
  flash: number;
}
const calm = new WeakMap<object, Calm>();

function state(world: object): Calm {
  let c = calm.get(world);
  if (!c) {
    c = { storm: 0, waves: new Map(), fog: new Map(), lights: new Map(), seas: new Map(), flash: 0 };
    calm.set(world, c);
  }
  return c;
}

/** Light up the sky for a moment (a lightning strike). */
export function flash(world: object): void {
  state(world).flash = 0.18;
}

/** Eases the storm in and out and scales every water surface's waves with it. */
defineSystem({
  name: "pirates.Waves",
  phase: "update",
  worlds: ["client", "server"],
  run(_rows, ctx) {
    const s = state(ctx.world);
    const target = (game()?.storm ?? 0) > 0 ? 1 : 0;
    s.storm += (target - s.storm) * Math.min(1, ctx.dt * 0.6);
    for (const water of GameObject.findObjectsOfType(WaterSurface)) {
      if (!s.waves.has(water)) s.waves.set(water, water.waveScale);
      const scale = s.waves.get(water)! * (1 + (STORM_WAVES - 1) * s.storm);
      if (Math.abs(water.waveScale - scale) > 1e-3) water.waveScale = scale;
    }
  },
});

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const STORM_FOG: [number, number, number] = [0.2, 0.23, 0.28];

/** Darkens the fog and sky, dims the lights, rains, and flashes for lightning. */
defineSystem({
  name: "pirates.Weather",
  phase: "lateUpdate",
  worlds: ["client"],
  run(_rows, ctx) {
    const s = state(ctx.world);
    const k = s.storm;
    s.flash = Math.max(0, s.flash - Time.deltaTime);
    for (const fog of GameObject.findObjectsOfType(Fog)) {
      if (!s.fog.has(fog)) s.fog.set(fog, { color: [fog.color.r, fog.color.g, fog.color.b], near: fog.near, far: fog.far });
      const base = s.fog.get(fog)!;
      const f = s.flash > 0 ? 0.9 : 0;
      fog.color.r = mix(mix(base.color[0], STORM_FOG[0], k), 0.9, f);
      fog.color.g = mix(mix(base.color[1], STORM_FOG[1], k), 0.92, f);
      fog.color.b = mix(mix(base.color[2], STORM_FOG[2], k), 1, f);
      fog.near = mix(base.near, base.near * 0.35, k);
      fog.far = mix(base.far, base.far * 0.45, k);
    }
    for (const light of GameObject.findObjectsOfType(Light)) {
      if (light.type !== "directional" && light.type !== "ambient") continue;
      if (!s.lights.has(light)) s.lights.set(light, light.intensity);
      const base = s.lights.get(light)!;
      const dim = light.type === "ambient" ? 0.5 : 0.85;
      light.intensity = s.flash > 0 && light.type === "ambient" ? base * 3 : base * (1 - dim * k);
    }
    // The sea turns slate grey.
    for (const water of GameObject.findObjectsOfType(WaterSurface)) {
      if (!s.seas.has(water)) s.seas.set(water, { deep: [water.deepColor.r, water.deepColor.g, water.deepColor.b], shallow: [water.shallowColor.r, water.shallowColor.g, water.shallowColor.b] });
      const base = s.seas.get(water)!;
      water.deepColor.r = mix(base.deep[0], 0.05, k);
      water.deepColor.g = mix(base.deep[1], 0.09, k);
      water.deepColor.b = mix(base.deep[2], 0.12, k);
      water.shallowColor.r = mix(base.shallow[0], 0.22, k);
      water.shallowColor.g = mix(base.shallow[1], 0.28, k);
      water.shallowColor.b = mix(base.shallow[2], 0.3, k);
    }
    for (const rain of GameObject.findObjectsOfType(ParticleSystem)) {
      if (rain.node.name !== "Rain") continue;
      rain.emissionScale = k;
      // Rain falls around what the camera looks at.
      const cam = Camera.main?.node.transform?.position;
      if (cam) rain.node.transform!.position.set(cam.x, 24, cam.z + 14);
      const sound = rain.node.getBehavior(AudioSource);
      if (sound) sound.volume = 0.6 * k;
    }
  },
});
