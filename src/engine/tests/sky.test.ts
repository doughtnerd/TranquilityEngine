import { describe, expect, it } from "vitest";
import { SKY_PRESETS, skyPreset } from "../sky/presets";
import { Sky } from "../sky/Sky";
import { bakeSizeOf, defaultSky, formatSky, hexToLinear, isSkyPath, linearToHex, parseSky, SKY_FORMAT } from "../sky/skyFormat";
import { bakeSignature, bodyDirections, directionFromAngles, hoursApart, moonPhase, SkyBakeScheduler, skyLight, starRotation, sunAngles, transmittance } from "../sky/skyMath";

const near = (a: number, b: number, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("sky format", () => {
  it("round-trips the default sky and every preset", () => {
    for (const s of [defaultSky(), ...SKY_PRESETS.map((p) => skyPreset(p.id))]) {
      const text = formatSky(s);
      expect(JSON.parse(text).format).toBe(SKY_FORMAT);
      const back = parseSky(JSON.parse(text), "x.sky.json");
      expect(back.problems).toEqual([]);
      expect(back.settings).toEqual(s);
    }
  });

  it("reads bad values as defaults with warnings, and clamps numbers", () => {
    const { settings, problems } = parseSky({ mode: "plasma", sun: { timeOfDay: 30, latitude: "north" }, sunDisc: { color: "red" }, exposure: 99, lighting: { bakeSize: 100 }, clouds: [{ coverage: 2 }, {}, {}] }, "a.sky.json");
    expect(settings.mode).toBe("atmosphere");
    expect(settings.sun.timeOfDay).toBe(24);
    expect(settings.sun.latitude).toBe(defaultSky().sun.latitude);
    expect(settings.sunDisc.color).toBe(defaultSky().sunDisc.color);
    expect(settings.exposure).toBe(16);
    expect(settings.lighting.bakeSize).toBe(128);
    expect(settings.clouds).toHaveLength(2);
    expect(settings.clouds[0].coverage).toBe(1);
    expect(problems.map((p) => p.message).join("\n")).toMatch(/mode.*sun\.latitude.*sunDisc\.color|mode/s);
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });

  it("reads a non-object as the default sky with an error", () => {
    const r = parseSky(42, "b.sky.json");
    expect(r.settings).toEqual(defaultSky());
    expect(r.problems[0].severity).toBe("error");
  });

  it("knows sky paths, bake sizes and colours", () => {
    expect(isSkyPath("skies/Day.SKY.JSON")).toBe(true);
    expect(isSkyPath("skies/day.json")).toBe(false);
    expect(bakeSizeOf(100)).toBe(128);
    expect(bakeSizeOf(1000)).toBe(512);
    expect(bakeSizeOf(1)).toBe(32);
    expect(hexToLinear("#ffffff")).toEqual([1, 1, 1]);
    near(hexToLinear("#808080")[0], 0.2159);
    expect(linearToHex(hexToLinear("#3a7bd5"))).toBe("#3a7bd5");
  });
});

describe("sky maths", () => {
  it("points directions with -Z north and +X east", () => {
    const north = directionFromAngles(0, 0);
    near(north[2], -1);
    const east = directionFromAngles(0, 90);
    near(east[0], 1);
    near(directionFromAngles(90, 0)[1], 1);
    near(directionFromAngles(0, 0, 90)[0], 1); // north turned to +X
  });

  it("puts the sun due south at noon in the north, east in the morning, below at midnight", () => {
    const sky = defaultSky();
    sky.sun.latitude = 45;
    sky.sun.dayOfYear = 80; // equinox-ish
    const noon = sunAngles(sky, 12);
    near(noon.azimuth, 180, 0.5);
    near(noon.elevation, 45, 1.5);
    const morning = sunAngles(sky, 9);
    expect(morning.azimuth).toBeGreaterThan(90);
    expect(morning.azimuth).toBeLessThan(180);
    expect(sunAngles(sky, 0).elevation).toBeLessThan(-30);
    sky.sun.placement = "manual";
    sky.sun.elevation = 10;
    sky.sun.azimuth = 270;
    expect(sunAngles(sky, 3)).toEqual({ elevation: 10, azimuth: 270 });
  });

  it("puts a full moon opposite the sun", () => {
    const sky = defaultSky();
    sky.moon.phase = 0.5;
    const { sun, moon } = bodyDirections(sky, 12);
    expect(sun[1]).toBeGreaterThan(0);
    expect(moon[1]).toBeLessThan(0);
    sky.moon.autoPhase = true;
    const p = moonPhase(sky);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
  });

  it("reddens and dims sunlight near the horizon", () => {
    const high = transmittance(90);
    const low = transmittance(2);
    expect(low[2] / low[0]).toBeLessThan(high[2] / high[0]);
    expect(low[1]).toBeLessThan(high[1]);
  });

  it("lights the scene with the sun by day and the moon at night", () => {
    const sky = defaultSky();
    const day = skyLight(sky, 12);
    expect(day.body).toBe("sun");
    near(day.intensity, sky.lighting.sunIntensity, 0.8);
    expect(day.direction[1]).toBeGreaterThan(0.5);
    sky.clouds = [];
    sky.moon.phase = 0.5;
    const night = skyLight(sky, 0);
    expect(night.body).toBe("moon");
    expect(night.intensity).toBeGreaterThan(0);
    expect(night.intensity).toBeLessThanOrEqual(sky.lighting.moonIntensity);
    sky.moon.enabled = false;
    expect(skyLight(sky, 0).intensity).toBe(0);
  });

  it("turns the stars about the pole", () => {
    const sky = defaultSky();
    const m = starRotation(sky, 3);
    // Orthonormal columns.
    for (let c = 0; c < 3; c++) near(Math.hypot(m[c * 3], m[c * 3 + 1], m[c * 3 + 2]), 1);
    const pole = directionFromAngles(sky.sun.latitude, 0);
    const out = [0, 1, 2].map((r) => m[r] * pole[0] + m[3 + r] * pole[1] + m[6 + r] * pole[2]);
    for (let i = 0; i < 3; i++) near(out[i], pole[i]);
  });

  it("schedules bakes on change and after the clock moves, throttled", () => {
    const sky = defaultSky();
    sky.lighting.rebakeInterval = 1;
    sky.lighting.rebakeHours = 0.5;
    const s = new SkyBakeScheduler();
    expect(s.update(0, sky, 10)).toBe(true);
    expect(s.update(0.1, sky, 10)).toBe(false);
    expect(s.update(5, sky, 10.4)).toBe(false); // under the threshold
    expect(s.update(5, sky, 10.6)).toBe(true);
    sky.exposure = 1;
    expect(s.update(5.5, sky, 10.6)).toBe(false); // throttled
    expect(s.update(6.1, sky, 10.6)).toBe(true);
    s.invalidate();
    expect(s.update(6.2, sky, 10.6)).toBe(true);
    expect(hoursApart(23.5, 0.5)).toBe(1);
    expect(bakeSignature({ ...sky, sun: { ...sky.sun, timeOfDay: 3 } })).toBe(bakeSignature(sky));
  });
});

describe("Sky component", () => {
  it("follows the asset's time until timeOfDay is set, then runs the day cycle from it", () => {
    const sky = new Sky();
    sky.settings = skyPreset("night");
    expect(sky.currentTime).toBe(23.5);
    sky.settings = skyPreset("sunset");
    expect(sky.currentTime).toBeCloseTo(19.3);
    sky.timeOfDay = 18.5;
    expect(sky.currentTime).toBe(18.5);
    sky.timeOfDay = 25; // wraps
    expect(sky.currentTime).toBe(1);
    expect(sky.sunDirection.y).toBeLessThan(0);
    sky.timeOfDay = 12;
    expect(sky.sunDirection.y).toBeGreaterThan(0);
    expect(sky.light.body).toBe("sun");
    const before = sky._rebakes;
    sky.rebake();
    expect(sky._rebakes).toBe(before + 1);
  });
});

