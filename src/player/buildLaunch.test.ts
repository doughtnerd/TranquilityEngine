// What the player launches a build with (ADR 0435), without a page: the manifest check, the files' JSON problems,
// the launch settings' refusal and notices, and the launch-time decisions of the build's Export options (debug link,
// audio capture and take triggers).
import { describe, expect, it } from "vitest";
import { resolveSettings } from "../engine/core/settings";
import { MANIFEST_FORMAT, type GameManifest } from "../export/format";
import { buildLaunch, checkManifest, type PlayerEnvironment } from "./buildLaunch";

const MANIFEST: GameManifest = { format: MANIFEST_FORMAT, name: "Game", mainScene: null, files: ["project.json"], scripts: [] };
const PAGE: PlayerEnvironment = { search: "", flags: {}, desktop: false, userAgent: "Mozilla/5.0 (X11; Linux x86_64)" };
const files = (entries: Record<string, unknown> = { "project.json": { name: "Game" } }, problems: { path: string; message: string }[] = []) => ({ values: new Map(Object.entries(entries)), problems });
const launchOf = (manifest: Partial<GameManifest> = {}, env: Partial<PlayerEnvironment> = {}) => buildLaunch({ ...MANIFEST, ...manifest }, files(), { ...PAGE, ...env });

describe("checkManifest", () => {
  it("passes this player's format and refuses another, asking for a new export", () => {
    expect(checkManifest(MANIFEST)).toBe(MANIFEST);
    expect(() => checkManifest({ ...MANIFEST, format: 99 })).toThrow(`This player reads game.json format ${MANIFEST_FORMAT}, but the game is format 99. Export it again.`);
    expect(() => checkManifest("not a manifest")).toThrow(/but the game is format undefined/);
  });
});

describe("buildLaunch", () => {
  it("launches with the launch settings: project.json with audio.json's mix, and audio.json's notices", () => {
    const launch = buildLaunch(MANIFEST, files({ "project.json": { name: "Game" }, "audio.json": { format: "nope", buses: 3 } }), PAGE);
    expect(resolveSettings(launch.project).name).toBe("Game");
    expect(launch.notices.length).toBeGreaterThan(0);
    expect(launch.notices.every((n) => n.startsWith("audio.json: "))).toBe(true);
  });

  it("stops on JSON files that don't parse, naming each", () => {
    expect(() => buildLaunch(MANIFEST, files({}, [{ path: "a.json", message: "bad" }, { path: "b.json", message: "worse" }]), PAGE)).toThrow(
      "Some of the game's JSON files don't parse: a.json (bad), b.json (worse)",
    );
  });

  it("stops on a project.json that still has an audio section", () => {
    expect(() => buildLaunch(MANIFEST, files({ "project.json": { audio: { buses: [] } } }), PAGE)).toThrow(/moved to audio\.json \(ADR 0344\)/);
  });

  it("installs the audio triggers only for the Export options, takes with pictures unless turned off", () => {
    expect(launchOf()).toMatchObject({ audioCapture: false, audioTake: null, debug: null });
    expect(launchOf({ audioCapture: true, audioTake: true })).toMatchObject({ audioCapture: true, audioTake: { frames: true } });
    expect(launchOf({ audioTake: true, audioTakeFrames: false }).audioTake).toEqual({ frames: false });
  });

  describe("the debug link", () => {
    it("a build with a link dials it, from a page as web", () => {
      expect(launchOf({ debug: { link: "ws://localhost:9" } }).debug).toEqual({ debug: { link: "ws://localhost:9" }, override: null, code: null, platform: "web", dial: true, listen: false });
    });

    it("takes a page's ?debug-link= and ?debug-code= over a desktop shell's flags", () => {
      const env = { search: "?debug-link=ws%3A%2F%2Fhost%3A1&debug-code=ABCD", flags: { __mycoDebugLink: "ws://other:2", __mycoDebugCode: "WXYZ" } };
      expect(launchOf({ debug: { link: "ws://localhost:9" } }, env).debug).toMatchObject({ override: "ws://host:1", code: "ABCD" });
      expect(launchOf({ debug: { link: "ws://localhost:9" } }, { flags: env.flags }).debug).toMatchObject({ override: "ws://other:2", code: "WXYZ" });
    });

    it("a listen-only build listens without dialling the default address, unless given an address or a code", () => {
      expect(launchOf({ debug: { listen: true } }).debug).toMatchObject({ dial: false, listen: true });
      expect(launchOf({ debug: { listen: true } }, { search: "?debug-code=ABCD" }).debug).toMatchObject({ dial: true, listen: true });
      expect(launchOf({ debug: { listen: true } }, { flags: { __mycoDebugLink: "ws://host:1" } }).debug).toMatchObject({ dial: true, listen: true });
      expect(launchOf({ debug: { listen: true, link: "ws://localhost:9" } }).debug).toMatchObject({ dial: true, listen: true });
    });

    it("a Tauri app is desktop, or android on a phone", () => {
      expect(launchOf({ debug: { link: "ws://localhost:9" } }, { desktop: true }).debug?.platform).toBe("desktop");
      expect(launchOf({ debug: { link: "ws://localhost:9" } }, { desktop: true, userAgent: "Mozilla/5.0 (Linux; Android 14)" }).debug?.platform).toBe("android");
    });
  });
});
