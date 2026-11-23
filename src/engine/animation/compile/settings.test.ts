// Clip compression settings (ADR 0371 "Compression", T19): the `animation.compression` section parses leniently and
// round-trips, and each value resolves on its own through sidecar → rule → project → built-in, each level's platform
// override just above it, as audio's encoding settings do (0351 §2). One case per level and per override.
import { describe, expect, it } from "vitest";
import {
  animationProjectSettingsToJson, animationSettingsOf, BUILTIN_COMPRESSION, parseAnimationProjectSettings, resolveCompression, type AnimationProjectSettings, type CompressionLevel,
} from "./settings";

const project = (raw: unknown): AnimationProjectSettings => parseAnimationProjectSettings(raw).settings;
const resolve = (path: string, sidecar: CompressionLevel | null, settings: AnimationProjectSettings, platform: "web" | "desktop" | "android" = "web") =>
  resolveCompression({ path, sidecar }, platform, settings);

const SETTINGS = project({
  compression: {
    error: 0.2,
    platforms: { android: { error: 0.5 } },
    rules: [
      { path: "anims/crowd/**", error: 1, maxRate: 15, platforms: { web: { maxRate: 10 } } },
      { path: "anims/**", propertyError: 0.01 },
    ],
  },
});

describe("compression settings: parse", () => {
  it("gives the built-in defaults without a section", () => {
    expect(parseAnimationProjectSettings(undefined)).toEqual({ settings: { compression: { rules: [] } }, problems: [] });
    expect(resolve("a.anim.json", null, project(undefined)).settings).toEqual(BUILTIN_COMPRESSION);
    expect(animationSettingsOf({ name: "Game" })).toEqual({ compression: { rules: [] } });
  });

  it("round-trips through its JSON, leaving an all-default section out", () => {
    expect(animationProjectSettingsToJson(project(undefined))).toBeUndefined();
    const json = animationProjectSettingsToJson(SETTINGS);
    expect(project(json)).toEqual(SETTINGS);
    expect(json).toEqual({ compression: { error: 0.2, platforms: { android: { error: 0.5 } }, rules: [{ path: "anims/crowd/**", error: 1, maxRate: 15, platforms: { web: { maxRate: 10 } } }, { path: "anims/**", propertyError: 0.01 }] } });
  });

  it("drops bad values with one problem each and keeps the rest", () => {
    const { settings, problems } = parseAnimationProjectSettings({
      compression: { error: -1, maxRate: "fast", platforms: { switch: { error: 1 }, web: { error: 2 } }, rules: [{ error: 1 }, { path: "x/**", maxRate: 999 }, 7] },
    });
    expect(settings.compression).toEqual({ error: 0.001, maxRate: 30, platforms: { web: { error: 2 } }, rules: [{ path: "x/**", maxRate: 240 }] });
    expect(problems).toEqual([
      "animation.compression.error: -1 is outside 0.001..1000; using 0.001.",
      "animation.compression.maxRate: must be a number; using 30.",
      "animation.compression.platforms.switch: isn't a platform (web, desktop, android); ignored.",
      "animation.compression.rules.0.path: a rule needs a path pattern; the rule is dropped.",
      "animation.compression.rules.1.maxRate: 999 is outside 1..240; using 240.",
      "animation.compression.rules.2: must be an object; ignored.",
    ]);
  });
});

describe("compression settings: inheritance (project → rule → sidecar → platform)", () => {
  it("takes the project profile", () => {
    const r = resolve("models/hero.glb", null, SETTINGS);
    expect(r.settings).toEqual({ error: 0.2, maxRate: null, propertyError: 1e-4 });
    expect(r.origins).toEqual({ error: { level: "project", platform: null }, maxRate: { level: "builtin" }, propertyError: { level: "builtin" } });
  });

  it("takes the project's platform override over the project", () => {
    expect(resolve("models/hero.glb", null, SETTINGS, "android").settings.error).toBe(0.5);
    expect(resolve("models/hero.glb", null, SETTINGS, "android").origins.error).toEqual({ level: "project", platform: "android" });
  });

  it("takes the first matching folder rule over the project, and its platform override over it", () => {
    const crowd = resolve("anims/crowd/walk.anim.json", null, SETTINGS);
    expect(crowd.settings).toEqual({ error: 1, maxRate: 10, propertyError: 1e-4 });
    expect(crowd.origins.maxRate).toEqual({ level: "rule", index: 0, path: "anims/crowd/**", platform: "web" });
    expect(resolve("anims/crowd/walk.anim.json", null, SETTINGS, "desktop").settings.maxRate).toBe(15);
    // Only the first match counts: the second rule's propertyError doesn't reach a crowd clip.
    expect(crowd.settings.propertyError).toBe(1e-4);
    expect(resolve("anims/hero/run.anim.json", null, SETTINGS).settings).toEqual({ error: 0.2, maxRate: null, propertyError: 0.01 });
  });

  it("takes the model sidecar's per-clip values over the rule, and its platform override over them", () => {
    const sidecar: CompressionLevel = { error: 0.05, platforms: { web: { error: 0.3 } } };
    expect(resolve("anims/crowd/crowd.glb", sidecar, SETTINGS, "desktop").settings).toEqual({ error: 0.05, maxRate: 15, propertyError: 1e-4 });
    const web = resolve("anims/crowd/crowd.glb", sidecar, SETTINGS, "web");
    expect(web.settings.error).toBe(0.3);
    expect(web.origins.error).toEqual({ level: "sidecar", platform: "web" });
    // A value the sidecar doesn't set inherits on its own.
    expect(web.origins.maxRate).toEqual({ level: "rule", index: 0, path: "anims/crowd/**", platform: "web" });
  });
});
