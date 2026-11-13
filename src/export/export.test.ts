import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { appIdentifier, desktopProjectFiles, slug } from "./desktop";
import { modulePath, relativeSpecifier, type GameManifest } from "./format";
import { exportProject } from "./node";
import { USAGE, parseArgs } from "./main";
import { ExportError, isExportedFile, isOutputInsideProject, planWebBuild, type BuildSource } from "./webBuild";
import { typescript } from "../editor/moduleImports";

const SAMPLES = join(__dirname, "..", "..", "samples");

// The TypeScript compiler loads once per file, on the first script compiled: seconds when the
// machine is busy (the full suite in parallel), which is set-up, not the build a test times.
beforeAll(() => typescript().then(() => undefined), 60_000);

function source(extra: Partial<BuildSource> & { scriptFiles?: Record<string, string>; jsonFiles?: Record<string, string> } = {}): BuildSource {
  const scripts = new Map(Object.entries(extra.scriptFiles ?? {}));
  const json = new Map(Object.entries({ "project.json": '{ "name": "Test Game" }', "scenes/main.scene.json": "{}", ...extra.jsonFiles }));
  return {
    name: "folder",
    settings: JSON.parse(json.get("project.json")!),
    files: [...json.keys(), ...scripts.keys(), "images/a.png", ...(extra.files ?? [])],
    scripts,
    json,
    ...(extra.settings ? { settings: extra.settings } : {}),
  };
}

describe("file selection", () => {
  it("exports assets, data and sidecars, and leaves out sources, editor files, hidden and build folders", () => {
    for (const path of ["project.json", "scenes/main.scene.json", "images/bird.png", "images/bird.png.meta.json", "music/a.mp3", "data/levels.json", "lib/plain.js", "scripts/notes.json", "scenes/main.nav.bin"]) {
      expect(isExportedFile(path), path).toBe(true);
    }
    for (const path of ["scripts/Bird.ts", "scripts/types.d.ts", "tsconfig.json", "sample.json", ".myco/history.json", ".myco/thumbnails/0123456789abcdef0123.webp", ".myco/nav/scenes/main.nav.bin.json", "images/.DS_Store", "node_modules/x/index.js", "dist/web/index.html", "src-tauri/target/a"]) {
      expect(isExportedFile(path), path).toBe(false);
    }
    expect(isExportedFile("levels/sample.json")).toBe(true); // only the root sample.json is the editor's
  });

  it("refuses an output folder inside the project, except in its hidden and build folders", () => {
    expect(isOutputInsideProject("C:\\games\\flappy", "C:\\games\\flappy\\build")).toBe(true);
    expect(isOutputInsideProject("C:\\games\\flappy", "c:/games/flappy")).toBe(true);
    expect(isOutputInsideProject("C:\\games\\flappy", "C:\\games\\flappy\\dist\\web")).toBe(false);
    expect(isOutputInsideProject("C:\\games\\flappy", "C:\\games\\flappy-web")).toBe(false);
    expect(isOutputInsideProject("/home/me/game", "/home/me/game/.out")).toBe(false);
  });
});

describe("module paths", () => {
  it("puts compiled scripts and JSON modules under code/, with relative specifiers between build files", () => {
    expect(modulePath("scripts/behaviors/Bird.ts")).toBe("code/scripts/behaviors/Bird.js");
    expect(modulePath("data/levels.json")).toBe("code/data/levels.json.js");
    expect(relativeSpecifier("code/scripts/behaviors/Bird.js", "myco.js")).toBe("../../../myco.js");
    expect(relativeSpecifier("code/scripts/a.js", "code/scripts/b.js")).toBe("./b.js");
    expect(relativeSpecifier("code/scripts/a/b.js", "code/data/x y.json.js")).toBe("../../data/x%20y.json.js");
  });
});

describe("planWebBuild", () => {
  it("compiles scripts in load order, pointing the engine, scripts and JSON at build files", async () => {
    const plan = await planWebBuild(
      source({
        scriptFiles: {
          "scripts/b/Spawner.ts": 'import { GameBehavior, behavior } from "myco";\nimport { speed } from "../data";\nimport levels from "../../data/levels.json";\n@behavior("t.Spawner")\nexport class Spawner extends GameBehavior { n = speed + levels.length; }\n',
          "scripts/data.ts": 'import { Vector2 } from "tranquility";\nexport const speed: number = 2;\nexport const origin = new Vector2(0, 0);\n',
        },
        jsonFiles: { "data/levels.json": "[1, 2, 3]" },
      }),
    );
    expect(plan.manifest).toEqual<GameManifest>({
      format: 1,
      name: "Test Game",
      mainScene: "scenes/main.scene.json",
      files: ["data/levels.json", "images/a.png", "project.json", "scenes/main.scene.json"],
      scripts: [
        { source: "scripts/data.ts", module: "code/scripts/data.js" },
        { source: "scripts/b/Spawner.ts", module: "code/scripts/b/Spawner.js" },
      ],
    });
    const spawner = plan.generated.get("code/scripts/b/Spawner.js")!;
    expect(spawner).toContain('from "../../../myco.js"');
    expect(spawner).toContain('from "../data.js"');
    expect(spawner).toContain('from "../../data/levels.json.js"');
    expect(spawner).not.toContain("sourceMappingURL"); // builds don't ship the TypeScript
    expect(spawner).not.toMatch(/@behavior\(/); // decorators are lowered
    expect(plan.generated.get("code/scripts/data.js")).toContain('from "../../myco.js"');
    expect(plan.generated.get("code/data/levels.json.js")).toBe("export default [1,2,3];\n");
    expect(JSON.parse(plan.generated.get("game.json")!)).toEqual(plan.manifest);
    expect(plan.generated.get("serve.mjs")).toContain("createServer");
    expect(plan.generated.get("README.txt")).toContain("node serve.mjs");
    expect(plan.copies).not.toContain("scripts/data.ts");
  });

  it("fails with every script that doesn't compile or resolve", async () => {
    const err = await planWebBuild(source({ scriptFiles: { "scripts/a.ts": "export const = 1;", "scripts/b.ts": 'import "./missing";', "scripts/c.ts": 'import "lodash";' } })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).problems.map((p) => p.path).sort()).toEqual(["scripts/a.ts", "scripts/b.ts", "scripts/c.ts"]);
    expect((err as Error).message).toContain("scripts/b.ts: can't find");
  });

  it("checks the bootstrap script and the main scene", async () => {
    await expect(planWebBuild(source({ settings: { bootstrap: "scripts/Boot.ts" } }))).rejects.toThrow(/bootstrap is the script "scripts\/Boot.ts"/);
    await expect(planWebBuild(source(), { mainScene: "scenes/nope.scene.json" })).rejects.toThrow(/no scene/);
    const plan = await planWebBuild(source({ jsonFiles: { "scenes/level2.scene.json": "{}" } }), { mainScene: "scenes/level2.scene.json" });
    expect(plan.manifest.mainScene).toBe("scenes/level2.scene.json");
    const none = await planWebBuild({ ...source(), files: ["project.json"], json: new Map([["project.json", "{}"]]), settings: {} });
    expect(none.manifest).toMatchObject({ name: "folder", mainScene: null });
  });
});

describe("the audio capture option", () => {
  it("planWebBuild writes the field only when asked", async () => {
    expect((await planWebBuild(source())).manifest).not.toHaveProperty("audioCapture");
    expect((await planWebBuild(source(), { audioCapture: false })).manifest).not.toHaveProperty("audioCapture");
    const plan = await planWebBuild(source(), { audioCapture: true });
    expect(plan.manifest.audioCapture).toBe(true);
    expect(JSON.parse(plan.generated.get("game.json")!)).toMatchObject({ audioCapture: true });
  });

  it("the command line: --audio-capture sets it, nothing sets it otherwise, and the help says what it does", () => {
    expect(parseArgs(["proj"])).toEqual({ projectDir: "proj" });
    expect(parseArgs(["proj", "--audio-capture"])).toEqual({ projectDir: "proj", audioCapture: true });
    expect(parseArgs(["--audio-capture", "proj", "--target", "desktop", "--no-build"])).toMatchObject({ projectDir: "proj", audioCapture: true, target: "desktop", tauriBuild: false });
    expect(USAGE).toMatch(/--audio-capture[\s\S]*F9/);
  });
});

describe("desktop project", () => {
  it("names the app after the project and points the window at the web build", () => {
    const files = desktopProjectFiles({ name: "Flappy Bird", settings: { display: { width: 720, height: 680 } } });
    const config = JSON.parse(files.get("tauri.conf.json")!);
    expect(config).toMatchObject({
      productName: "Flappy Bird",
      version: "0.1.0",
      identifier: "com.myco.game.flappybird",
      build: { frontendDist: "../web" },
      app: { windows: [{ title: "Flappy Bird", url: "index.html", width: 720, height: 680 }] },
    });
    expect(config.build.beforeBuildCommand).toBeUndefined(); // the web build is already made
    expect(files.get("Cargo.toml")).toContain('name = "flappy-bird"');
    expect(files.get("src/main.rs")).toContain("flappy_bird_lib::run()");
    expect(files.get("src/lib.rs")).toContain("tauri_plugin_fs::init()");
    expect(JSON.parse(files.get("capabilities/default.json")!).permissions).toContain("fs:allow-appdata-write-recursive");
    expect([...files.keys()].sort()).toEqual([".gitignore", "Cargo.toml", "build.rs", "capabilities/default.json", "src/lib.rs", "src/main.rs", "tauri.conf.json"]);
  });

  it("takes the identifier and version from project.json's build settings", () => {
    const config = JSON.parse(desktopProjectFiles({ name: "x", settings: { build: { identifier: "com.example.x", version: "1.2.3" } } }).get("tauri.conf.json")!);
    expect(config).toMatchObject({ identifier: "com.example.x", version: "1.2.3" });
    expect(() => appIdentifier({ name: "x", settings: { build: { identifier: "not an id" } } })).toThrow(/reverse-DNS/);
    expect(slug("3D Racer!")).toBe("game-3d-racer");
  });
});

describe("exportProject (Node)", () => {
  const temps: string[] = [];
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-export-test-"));
    temps.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** A stand-in for dist/player/. */
  const fakePlayer = () => {
    const dir = temp();
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "files.json"), JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] }));
    writeFileSync(join(dir, "assets", "player-x.js"), "// player");
    writeFileSync(join(dir, "myco.js"), "export {};");
    writeFileSync(join(dir, "player.html"), "<!DOCTYPE html><title>player</title>");
    return dir;
  };

  it("writes the Flappy sample as a web build: player, project files, compiled scripts, manifest", async () => {
    const out = join(temp(), "web");
    const result = await exportProject({ projectDir: join(SAMPLES, "flappy"), out, playerDir: fakePlayer() });
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain("<title>player</title>");
    expect(existsSync(join(out, "player.html"))).toBe(false);
    for (const file of ["myco.js", "assets/player-x.js", "game.json", "serve.mjs", "README.txt", "project/project.json", "project/images/flappyBird.png", "project/music/town.mp3", "code/scripts/behaviors/Bird.js"]) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
    for (const file of ["project/sample.json", "project/scripts/behaviors/Bird.ts", "code/scripts/behaviors/Bird.ts"]) expect(existsSync(join(out, file)), file).toBe(false);
    const manifest = JSON.parse(readFileSync(join(out, "game.json"), "utf8")) as GameManifest;
    expect(manifest).toMatchObject({ name: "flappy", mainScene: "scenes/main.scene.json" });
    expect(manifest.scripts.map((s) => s.source)).toContain("scripts/behaviors/GameManager.ts");
    expect(result.plan.manifest).toEqual(manifest);
  });

  it("--audio-capture / audioCapture writes the manifest field the player reads; without it the manifest has none", async () => {
    const project = temp();
    mkdirSync(join(project, "scenes"));
    writeFileSync(join(project, "project.json"), '{ "name": "Tiny" }');
    writeFileSync(join(project, "scenes", "main.scene.json"), "{}");
    const manifestOf = (out: string) => JSON.parse(readFileSync(join(out, "game.json"), "utf8")) as GameManifest;
    const off = join(temp(), "web");
    await exportProject({ projectDir: project, out: off, playerDir: fakePlayer() });
    expect(manifestOf(off)).not.toHaveProperty("audioCapture");
    const explicitOff = join(temp(), "web");
    await exportProject({ projectDir: project, out: explicitOff, playerDir: fakePlayer(), audioCapture: false });
    expect(manifestOf(explicitOff)).not.toHaveProperty("audioCapture");
    const on = join(temp(), "web");
    const result = await exportProject({ projectDir: project, out: on, playerDir: fakePlayer(), audioCapture: true });
    expect(manifestOf(on).audioCapture).toBe(true);
    expect(result.plan.manifest).toEqual(manifestOf(on));
  });

  it("replaces an earlier build, and refuses a folder holding something else", async () => {
    // A project with no scripts, images or models: what's checked is the output folder, not the build.
    const project = temp();
    mkdirSync(join(project, "scenes"));
    writeFileSync(join(project, "project.json"), '{ "name": "Tiny" }');
    writeFileSync(join(project, "scenes", "main.scene.json"), "{}");
    const out = join(temp(), "web");
    await exportProject({ projectDir: project, out, playerDir: fakePlayer() });
    writeFileSync(join(out, "stale.txt"), "old");
    await exportProject({ projectDir: project, out, playerDir: fakePlayer() });
    expect(existsSync(join(out, "game.json"))).toBe(true);
    expect(existsSync(join(out, "stale.txt"))).toBe(false);
    const other = temp();
    writeFileSync(join(other, "notes.txt"), "mine");
    await expect(exportProject({ projectDir: project, out: other, playerDir: fakePlayer() })).rejects.toThrow(/isn't empty/);
    expect(readFileSync(join(other, "notes.txt"), "utf8")).toBe("mine");
  });

  it("bakes the models of the 3D Playground beside them and lists them in the manifest (ADR 0090)", async () => {
    const out = join(temp(), "web");
    const lines: string[] = [];
    const result = await exportProject({ projectDir: join(SAMPLES, "playground3d"), out, playerDir: fakePlayer(), log: (l) => lines.push(l) });
    for (const model of ["models/crate.obj", "models/robot.fbx", "models/lamp.glb"]) {
      const baked = `${model}.mycomesh`;
      expect(result.plan.manifest.files, baked).toContain(baked);
      const bytes = readFileSync(join(out, "project", baked));
      expect(bytes.subarray(0, 8).toString("latin1"), baked).toBe("MYCOMESH");
      expect(existsSync(join(out, "project", model)), model).toBe(true); // the model file stays, for anything that reads it
    }
    expect(lines.filter((l) => /couldn't be baked/.test(l))).toEqual([]);
  });

  it("refuses to write into the project", async () => {
    await expect(exportProject({ projectDir: join(SAMPLES, "flappy"), out: join(SAMPLES, "flappy", "build"), playerDir: fakePlayer() })).rejects.toThrow(/inside the project/);
  });

  it("writes a desktop package's Tauri project around the web build, with icons, without building it", async () => {
    const out = temp();
    const result = await exportProject({ projectDir: join(SAMPLES, "arena"), out, target: "desktop", tauriBuild: false, playerDir: fakePlayer() });
    expect(result.built).toBe(false);
    expect(existsSync(join(out, "web", "index.html"))).toBe(true);
    expect(existsSync(join(out, "web", "code", "scripts", "behaviors", "Menu.js"))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "src-tauri", "tauri.conf.json"), "utf8"))).toMatchObject({ productName: "arena", app: { windows: [{ width: 800, height: 600 }] } });
    for (const icon of ["icons/icon.ico", "icons/icon.icns", "icons/32x32.png"]) expect(existsSync(join(out, "src-tauri", icon)), icon).toBe(true);
    expect(readFileSync(join(out, "README.txt"), "utf8")).toContain("npx @tauri-apps/cli build");
  }, 60_000);
});
