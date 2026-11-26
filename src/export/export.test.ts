import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GAMEPAD_COMMANDS, GAMEPAD_DEPENDENCIES, desktopProjectFiles, slug } from "./desktop";
import { modulePath, relativeSpecifier, type GameManifest } from "./format";
import { exportProject } from "./node";
import { USAGE, parseArgs } from "./main";
import { ExportError, RENDEZVOUS_FILE, SERVE_SCRIPT, debugServeScript, isOutputInsideProject, planWebBuild, type BuildSource } from "./webBuild";
import { typescript } from "../editor/moduleImports";

const SAMPLES = join(__dirname, "..", "..", "samples");
const SRC_TAURI = join(__dirname, "..", "..", "src-tauri");

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
  it("exports assets, data and sidecars, and leaves out sources, editor files, hidden and build folders", async () => {
    const shipped = ["project.json", "scenes/main.scene.json", "images/bird.png", "images/bird.png.meta.json", "music/a.mp3", "data/levels.json", "lib/plain.js", "scripts/notes.json", "scenes/main.nav.bin"];
    const left = ["scripts/Bird.ts", "scripts/types.d.ts", "tsconfig.json", "sample.json", ".myco/history.json", ".myco/thumbnails/0123456789abcdef0123.webp", ".myco/nav/scenes/main.nav.bin.json", "images/.DS_Store", "node_modules/x/index.js", "dist/web/index.html", "src-tauri/target/a"];
    const { copies } = await planWebBuild(source({ files: [...shipped, ...left, "levels/sample.json"] }));
    for (const path of shipped) expect(copies, path).toContain(path);
    for (const path of left) expect(copies, path).not.toContain(path);
    expect(copies).toContain("levels/sample.json"); // only the root sample.json is the editor's
  });

  it("ships a derived sample a playlist names, with its source audio file and that file's sidecar (ADR 0342)", async () => {
    const derived = { format: "myco.sample@1", source: "audio/skid.wav", range: [0.8, 1.6], lineage: { kind: "snippet", parent: "audio/skid.wav", mode: "pin" } };
    const playlist = { format: "myco.playlist@1", type: "clip", entries: [{ sample: "audio/snips/skid.brake.sample.json" }] };
    const { copies, manifest } = await planWebBuild(source({
      files: ["audio/skid.wav"],
      jsonFiles: {
        "audio/skid.wav.meta.json": JSON.stringify({ format: "myco.import@1", sample: { trim: [0, 2] } }),
        "audio/snips/skid.brake.sample.json": JSON.stringify(derived),
        "audio/brake.playlist.json": JSON.stringify(playlist),
      },
    }));
    for (const path of ["audio/brake.playlist.json", "audio/snips/skid.brake.sample.json", "audio/skid.wav", "audio/skid.wav.meta.json"]) {
      expect(copies, path).toContain(path);
      expect(manifest.files, path).toContain(path);
    }
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

  it("ships audio.json with the project's files and refuses a project.json that still has an audio section (ADR 0344)", async () => {
    const plan = await planWebBuild(source({ jsonFiles: { "audio.json": '{ "format": "myco.audio@1" }' } }));
    expect(plan.copies).toContain("audio.json");
    const legacy = source({ jsonFiles: { "project.json": '{ "name": "Old", "audio": { "buses": [{ "name": "Master" }] } }' } });
    const err = await planWebBuild(legacy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as Error).message).toMatch(/still has an "audio" section, which moved to audio\.json/);
  });

  it("refuses a project that still has audio event files, naming the migration (ADR 0343)", async () => {
    const old = source({ jsonFiles: { "audio/step.audioevent.json": '{ "format": "myco.audioevent@1" }', "audio/hit.audioevent.json": "{}" } });
    const err = await planWebBuild(old).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportError);
    expect((err as Error).message).toMatch(/is an audio event \(myco\.audioevent@1\).*npm run audio:migrate.*\(2 audio event files in all\)/);
    expect((err as ExportError).problems.map((p) => p.path).sort()).toEqual(["audio/hit.audioevent.json", "audio/step.audioevent.json"]);
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

describe("the audio take option (ADR 0348)", () => {
  it("planWebBuild writes audioTake only when asked; --audio-take sets it", async () => {
    expect((await planWebBuild(source())).manifest).not.toHaveProperty("audioTake");
    const plan = await planWebBuild(source(), { audioTake: true });
    expect(JSON.parse(plan.generated.get("game.json")!)).toMatchObject({ audioTake: true });
    expect(plan.manifest).not.toHaveProperty("audioCapture");
    expect(parseArgs(["proj", "--audio-take"])).toEqual({ projectDir: "proj", audioTake: true });
    expect(USAGE).toMatch(/--audio-take[\s\S]*F10/);
  });

  it("takes record pictures unless asked not to: audioTakeFrames false (with audioTake), --no-take-pictures", async () => {
    expect((await planWebBuild(source(), { audioTake: true })).manifest).not.toHaveProperty("audioTakeFrames");
    const off = await planWebBuild(source(), { audioTake: true, audioTakeFrames: false });
    expect(JSON.parse(off.generated.get("game.json")!)).toMatchObject({ audioTake: true, audioTakeFrames: false });
    expect((await planWebBuild(source(), { audioTakeFrames: false })).manifest).not.toHaveProperty("audioTakeFrames"); // no takes, nothing to say
    expect(parseArgs(["proj", "--audio-take", "--no-take-pictures"])).toEqual({ projectDir: "proj", audioTake: true, audioTakeFrames: false });
    expect(() => parseArgs(["proj", "--no-take-pictures"])).toThrow(/--audio-take/);
    expect(USAGE).toMatch(/--no-take-pictures/);
  });
});

describe("the debug link option (ADR 0376)", () => {
  it("planWebBuild writes game.json's debug only when asked: the editor on this machine, or the address given", async () => {
    expect((await planWebBuild(source())).manifest).not.toHaveProperty("debug");
    const local = await planWebBuild(source(), { debugLink: true });
    expect(JSON.parse(local.generated.get("game.json")!)).toMatchObject({ debug: { link: "ws://localhost:7790/myco-debug" } });
    expect((await planWebBuild(source(), { debugLink: "192.168.1.4:7790" })).manifest.debug).toEqual({ link: "ws://192.168.1.4:7790/myco-debug" });
    await expect(planWebBuild(source(), { debugLink: "nope://" })).rejects.toThrow(/isn't a WebSocket address/);
  });

  it("the command line: --debug-link takes the editor's address, and the help says what it does", () => {
    expect(parseArgs(["proj", "--debug-link", "7790"])).toEqual({ projectDir: "proj", debugLink: "7790" });
    expect(parseArgs(["proj", "--debug-link=ws://10.0.0.2:7790/myco-debug"])).toEqual({ projectDir: "proj", debugLink: "ws://10.0.0.2:7790/myco-debug" });
    expect(() => parseArgs(["proj", "--debug-link", "http://x"])).toThrow(/WebSocket address/);
    expect(() => parseArgs(["proj", "--debug-link"])).toThrow(/needs/);
    expect(USAGE).toMatch(/--debug-link[\s\S]*hold none of the link's code/);
  });

  it("a desktop package with debugging on takes --debug-link at launch; a release one has no such flag", () => {
    const release = desktopProjectFiles({ name: "x", settings: {}, gamepadModule: "" });
    expect(release.get("src/lib.rs")).not.toContain("debug-link");
    expect(release.get("src/lib.rs")).toContain("    tauri::Builder::default()\n        .plugin(tauri_plugin_fs::init())");
    expect(release.get("Cargo.toml")!.split("[dependencies]")[1]!.split("[dev-dependencies]")[0]).not.toContain("serde_json"); // only the dev one
    const debug = desktopProjectFiles({ name: "x", settings: {}, gamepadModule: "", debug: true });
    const lib = debug.get("src/lib.rs")!;
    expect(lib).toContain('a == "--debug-link"');
    expect(lib).toContain('strip_prefix("--debug-link=")');
    expect(lib).toContain("builder = builder.append_invoke_initialization_script(format!(\"globalThis.__mycoDebugLink = {literal};\"));");
    expect(lib).toContain("    builder\n        .plugin(tauri_plugin_fs::init())");
    expect(debug.get("Cargo.toml")).toMatch(/^\[dependencies\][\s\S]*^serde_json = "1"$[\s\S]*^\[dev-dependencies\]/m);
  });
});

/** This machine's non-loopback IPv4 addresses (a machine without any prints no "On your network" line). */
const networkInterfaces4 = () => Object.values(networkInterfaces()).flatMap((list) => (list ?? []).filter((a) => a.family === "IPv4" && !a.internal));

describe("a debug web build hosts the rendezvous (ADR 0403 'Rendezvous' 2 and 3)", () => {
  const BUNDLE = "export async function startRendezvous() {}\n";
  const files = async (o: object) => (await planWebBuild(source(), o)).generated;

  it("a release build's serve.mjs is unchanged and has no bundle, whatever the bundle option says", async () => {
    const release = await files({ rendezvousBundle: BUNDLE });
    expect(release.get("serve.mjs")).toBe(SERVE_SCRIPT);
    expect(release.get("serve.mjs")).toContain('server.listen(port, "127.0.0.1"');
    expect(release.has(RENDEZVOUS_FILE)).toBe(false);
  });

  it("--debug-link with the bundle: rendezvous.mjs beside a serve.mjs that mounts it, still on 127.0.0.1", async () => {
    const g = await files({ debugLink: true, rendezvousBundle: BUNDLE });
    expect(g.get(RENDEZVOUS_FILE)).toBe(BUNDLE);
    const serve = g.get("serve.mjs")!;
    expect(serve).toContain('import { startRendezvous } from "./rendezvous.mjs"');
    expect(serve).toContain('await startRendezvous(server, "/myco-rendezvous")');
    expect(serve).toContain('server.listen(port, "127.0.0.1"');
    expect(serve).not.toContain("0.0.0.0");
    expect(g.get("README.txt")).toContain("/myco-rendezvous");
  });

  it("--debug-lan binds 0.0.0.0 and prints the LAN addresses; without the bundle it still does, and warns", async () => {
    const lan = await files({ debugLan: true, rendezvousBundle: BUNDLE });
    expect(lan.get("serve.mjs")).toContain('server.listen(port, "0.0.0.0"');
    expect(lan.get("serve.mjs")).toContain("On your network: http://");
    expect(lan.get("README.txt")).toContain("every network interface");
    const plan = await planWebBuild(source(), { debugLan: true });
    expect(plan.generated.has(RENDEZVOUS_FILE)).toBe(false);
    expect(plan.generated.get("serve.mjs")).not.toContain("rendezvous.mjs");
    expect(plan.generated.get("serve.mjs")).toContain('server.listen(port, "0.0.0.0"');
    expect(plan.warnings?.join("\n")).toMatch(/no rendezvous\.mjs[\s\S]*npm run build:rendezvous/);
  });

  it("every flag combination writes a serve.mjs that runs: serves the page, mounts the rendezvous, prints the LAN", async () => {
    // A stand-in bundle: it is handed the server and the path, and answers /rendezvous-mounted over HTTP with the path.
    const bundle = 'export async function startRendezvous(server, path) { server.prependListener("request", (req, res) => { if (req.url === "/rendezvous-mounted") res.end(path); }); }\n';
    for (const lan of [false, true]) {
      for (const rendezvous of [false, true]) {
        const label = `lan ${lan}, rendezvous ${rendezvous}`;
        const dir = mkdtempSync(join(tmpdir(), "myco-serve-"));
        try {
          writeFileSync(join(dir, "serve.mjs"), debugServeScript({ lan, rendezvous }));
          writeFileSync(join(dir, "index.html"), "<title>game</title>");
          if (rendezvous) writeFileSync(join(dir, RENDEZVOUS_FILE), bundle);
          const child = spawn(process.execPath, [join(dir, "serve.mjs"), "0"], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          child.stderr.on("data", (d: Buffer) => (out += d));
          try {
            const port = await new Promise<number>((resolve, reject) => {
              child.on("exit", (code) => reject(new Error(`serve.mjs exited ${code}: ${out}`)));
              child.stdout.on("data", (d: Buffer) => {
                out += d;
                const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
                if (m) setTimeout(() => resolve(Number(m[1])), 50); // the rest of the lines
              });
            });
            expect(await (await fetch(`http://127.0.0.1:${port}/`)).text(), label).toContain("<title>game</title>");
            const mounted = await fetch(`http://127.0.0.1:${port}/rendezvous-mounted`);
            if (rendezvous) expect(await mounted.text(), label).toBe("/myco-rendezvous");
            else expect(mounted.status, label).toBe(404);
            expect(out.includes("Pairing rendezvous at ws://127.0.0.1:"), label).toBe(rendezvous);
            expect(out.includes("On your network: http://"), label).toBe(lan && networkInterfaces4().length > 0);
          } finally {
            child.removeAllListeners("exit");
            child.kill();
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }, 30_000);

  it("--debug-rendezvous implies debugging on and is written as debug.rendezvous; a bad address is refused", async () => {
    const plan = await planWebBuild(source(), { debugRendezvous: "wss://rdv.example.com/myco-rendezvous" });
    expect(plan.manifest.debug).toEqual({ rendezvous: "wss://rdv.example.com/myco-rendezvous" });
    await expect(planWebBuild(source(), { debugRendezvous: "https://x" })).rejects.toThrow(/ws:\/\/ or wss:\/\/ URL/);
    await expect(planWebBuild(source(), { debugRendezvous: "nope" })).rejects.toThrow(/ws:\/\/ or wss:\/\/ URL/);
  });

  it("the command line takes --debug-rendezvous and the help says what it does", () => {
    expect(parseArgs(["proj", "--debug-rendezvous", "wss://rdv.example.com/myco-rendezvous"])).toEqual({ projectDir: "proj", debugRendezvous: "wss://rdv.example.com/myco-rendezvous" });
    expect(() => parseArgs(["proj", "--debug-rendezvous", "https://x"])).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() => parseArgs(["proj", "--debug-rendezvous"])).toThrow(/needs/);
    expect(USAGE).toMatch(/--debug-rendezvous[\s\S]*rendezvous\.mjs[\s\S]*--build/);
  });
});

describe("the debug link's listening flags (ADR 0403)", () => {
  it("--debug-listen, --debug-lan and --debug-port parse, imply debugging on, and the help says so", () => {
    expect(parseArgs(["proj", "--debug-listen"])).toEqual({ projectDir: "proj", debugListen: true });
    expect(parseArgs(["proj", "--debug-listen", "--debug-lan", "--debug-port", "7800"])).toEqual({ projectDir: "proj", debugListen: true, debugLan: true, debugPort: 7800 });
    expect(() => parseArgs(["proj", "--debug-port", "0"])).toThrow(/whole number/);
    expect(() => parseArgs(["proj", "--debug-port", "x"])).toThrow(/whole number/);
    expect(USAGE).toMatch(/--debug-listen[\s\S]*--debug-code[\s\S]*--debug-lan[\s\S]*--debug-port/);
  });

  it("game.json gets debug.listen, debug.lan and debug.port; a listen-only build writes no link (it would dial the default address)", async () => {
    const debug = async (o: object) => JSON.parse((await planWebBuild(source(), o)).generated.get("game.json")!).debug;
    expect(await debug({ debugListen: true })).toEqual({ listen: true });
    expect(await debug({ debugListen: true, debugLan: true, debugPort: 7800 })).toEqual({ listen: true, lan: true, port: 7800 });
    expect(await debug({ debugLan: true })).toEqual({ lan: true });
    expect(await debug({ debugLink: "192.168.1.4:7790", debugListen: true })).toEqual({ link: "ws://192.168.1.4:7790/myco-debug", listen: true });
    expect(await debug({})).toBeUndefined();
    await expect(planWebBuild(source(), { debugPort: 70000 })).rejects.toThrow(/debug port/);
  });

  const crates = new Map([
    ["ws-listener/Cargo.toml", "# ws\n"],
    ["ws-listener/src/lib.rs", "// ws\n"],
    ["debug-link-tauri/Cargo.toml", "# tauri\n"],
    ["debug-link-tauri/src/lib.rs", "// tauri\n"],
  ]);

  it("a debug desktop package vendors the listener crates, depends on them, manages the listeners and registers the commands", () => {
    const files = desktopProjectFiles({ name: "x", settings: {}, gamepadModule: "", debug: true, debugListener: crates });
    for (const [path, text] of crates) expect(files.get(`vendor/${path}`)).toBe(text);
    expect(files.get("Cargo.toml")).toMatch(/^\[dependencies\][\s\S]*^myco-debug-link-tauri = \{ path = "vendor\/debug-link-tauri" \}$[\s\S]*^\[dev-dependencies\]/m);
    const lib = files.get("src/lib.rs")!;
    expect(lib).toContain("builder = builder.manage(debug_link_tauri::DebugLinkListeners::default());");
    expect(lib).toContain("builder = builder.manage(debug_link_tauri::DebugDiscovery::default());");
    for (const c of ["listen_range", "listen", "send", "close", "interfaces", "advertise", "unadvertise", "browse", "browse_stop"]) expect(lib).toContain(`debug_link_tauri::commands::myco_debuglink_${c},`);
    expect(lib).toContain("gamepad::myco_gamepad_listen,");
    // The Android multicast lock (pairing plan D3), so discovery works on a phone.
    expect(files.get("Cargo.toml")).toMatch(/^tauri-plugin-myco-multicast = \{ path = "vendor\/tauri-plugin-myco-multicast" \}$/m);
    expect(lib).toContain(".plugin(tauri_plugin_myco_multicast::init())");
    expect(lib).toContain('a == "--debug-code"');
    expect(lib).toContain("globalThis.__mycoDebugCode = {literal};");
  });

  it("a release package, and a debug one given no crates, have none of it", () => {
    for (const o of [{}, { debugListener: crates }, { debug: true }]) {
      const files = desktopProjectFiles({ name: "x", settings: {}, gamepadModule: "", ...o });
      expect([...files.keys()].filter((k) => k.startsWith("vendor/"))).toEqual([]);
      expect(files.get("Cargo.toml")).not.toContain("myco-debug-link-tauri");
      expect(files.get("src/lib.rs")).not.toContain("DebugLinkListeners");
      expect(files.get("src/lib.rs")).not.toContain("DebugDiscovery");
      expect(files.get("src/lib.rs")).not.toContain("myco_debuglink");
      expect(files.get("Cargo.toml")).not.toContain("tauri-plugin-myco-multicast");
      expect(files.get("src/lib.rs")).not.toContain("myco_multicast");
    }
    expect(desktopProjectFiles({ name: "x", settings: {}, gamepadModule: "" }).get("src/lib.rs")).not.toContain("debug-code");
  });
});

describe("desktop project", () => {
  it("names the app after the project and points the window at the web build", () => {
    const files = desktopProjectFiles({ name: "Flappy Bird", settings: { display: { width: 720, height: 680 } }, gamepadModule: "// gamepads\n" });
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
    expect([...files.keys()].sort()).toEqual([".gitignore", "Cargo.toml", "build.rs", "capabilities/default.json", "src/gamepad.rs", "src/lib.rs", "src/main.rs", "tauri.conf.json"]);
  });

  it("includes the editor's native gamepad module, its dependencies and its commands (ADR 0335)", () => {
    const files = desktopProjectFiles({ name: "x", settings: {}, gamepadModule: "// gamepads\n" });
    expect(files.get("src/gamepad.rs")).toBe("// gamepads\n");
    expect(files.get("src/lib.rs")).toContain("mod gamepad;");
    for (const command of GAMEPAD_COMMANDS) expect(files.get("src/lib.rs")).toContain(`gamepad::${command},`);
    expect(files.get("Cargo.toml")).toContain(GAMEPAD_DEPENDENCIES);
    // The same SDL3 build as the editor's shell, and the commands gamepad.rs defines and the editor registers.
    expect(readFileSync(join(SRC_TAURI, "Cargo.toml"), "utf8")).toContain(GAMEPAD_DEPENDENCIES);
    const module = readFileSync(join(SRC_TAURI, "src", "gamepad.rs"), "utf8");
    const editorLib = readFileSync(join(SRC_TAURI, "src", "lib.rs"), "utf8");
    for (const command of GAMEPAD_COMMANDS) {
      expect(module).toContain(`pub fn ${command}(`);
      expect(editorLib).toContain(`gamepad::${command}`);
    }
  });

  it("takes the identifier and version from project.json's build settings", () => {
    const config = JSON.parse(desktopProjectFiles({ name: "x", settings: { build: { identifier: "com.example.x", version: "1.2.3" } }, gamepadModule: "" }).get("tauri.conf.json")!);
    expect(config).toMatchObject({ identifier: "com.example.x", version: "1.2.3" });
    expect(() => desktopProjectFiles({ name: "x", settings: { build: { identifier: "not an id" } }, gamepadModule: "" })).toThrow(/reverse-DNS/);
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

  // The first build that compiles Svelte UI loads svelte/compiler and esbuild (ADR 0419, 0421): several seconds.
  it("writes the Flappy sample as a web build: player, project files, compiled scripts and UI, manifest", { timeout: 120_000 }, async () => {
    const out = join(temp(), "web");
    const result = await exportProject({ projectDir: join(SAMPLES, "flappy"), out, playerDir: fakePlayer() });
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain("<title>player</title>");
    expect(existsSync(join(out, "player.html"))).toBe(false);
    for (const file of ["myco.js", "assets/player-x.js", "game.json", "serve.mjs", "README.txt", "project/project.json", "project/images/flappyBird.png", "project/music/town.mp3", "code/scripts/behaviors/Bird.js", "code/ui/Hud.svelte.js"]) {
      expect(existsSync(join(out, file)), file).toBe(true);
    }
    for (const file of ["project/sample.json", "project/scripts/behaviors/Bird.ts", "code/scripts/behaviors/Bird.ts", "project/ui/Hud.svelte"]) expect(existsSync(join(out, file)), file).toBe(false);
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

  it("a debug web build copies the rendezvous bundle beside serve.mjs; a release build writes neither; --debug-rendezvous reaches game.json", async () => {
    const project = temp();
    mkdirSync(join(project, "scenes"));
    writeFileSync(join(project, "project.json"), '{ "name": "Tiny" }');
    writeFileSync(join(project, "scenes", "main.scene.json"), "{}");
    const bundle = join(temp(), "rendezvous.mjs");
    writeFileSync(bundle, "// the rendezvous bundle\nexport async function startRendezvous() {}\n");
    const release = join(temp(), "web");
    await exportProject({ projectDir: project, out: release, playerDir: fakePlayer(), rendezvousFile: bundle });
    expect(existsSync(join(release, "rendezvous.mjs"))).toBe(false);
    expect(readFileSync(join(release, "serve.mjs"), "utf8")).toBe(SERVE_SCRIPT);
    const debug = join(temp(), "web");
    await exportProject({ projectDir: project, out: debug, playerDir: fakePlayer(), rendezvousFile: bundle, debugRendezvous: "wss://rdv.example.com/myco-rendezvous", debugLan: true });
    expect(readFileSync(join(debug, "rendezvous.mjs"), "utf8")).toContain("// the rendezvous bundle");
    expect(readFileSync(join(debug, "serve.mjs"), "utf8")).toContain('"0.0.0.0"');
    expect((JSON.parse(readFileSync(join(debug, "game.json"), "utf8")) as GameManifest).debug).toMatchObject({ lan: true, rendezvous: "wss://rdv.example.com/myco-rendezvous" });
  });

  it("replaces an earlier build through Node's fs, and keeps it when the given player isn't a built one", async () => {
    // A project with no scripts, images or models: what's checked is the output folder (the build writer's suite has the rest).
    const project = temp();
    mkdirSync(join(project, "scenes"));
    writeFileSync(join(project, "project.json"), '{ "name": "Tiny" }');
    writeFileSync(join(project, "scenes", "main.scene.json"), "{}");
    const out = join(temp(), "web");
    await exportProject({ projectDir: project, out, playerDir: fakePlayer() });
    mkdirSync(join(out, "old"));
    writeFileSync(join(out, "old", "stale.txt"), "old");
    await exportProject({ projectDir: project, out, playerDir: fakePlayer() });
    expect(existsSync(join(out, "game.json"))).toBe(true);
    expect(existsSync(join(out, "old"))).toBe(false);

    writeFileSync(join(out, "stale.txt"), "old");
    const broken = fakePlayer();
    writeFileSync(join(broken, "files.json"), JSON.stringify({ files: ["myco.js"] }));
    await expect(exportProject({ projectDir: project, out, playerDir: broken })).rejects.toThrow(/game player .* is incomplete/);
    expect(readFileSync(join(out, "stale.txt"), "utf8")).toBe("old");
    expect(existsSync(join(out, "index.html"))).toBe(true);
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

  it("refuses a desktop build.icon that isn't a PNG or SVG", async () => {
    const project = temp();
    cpSync(join(SAMPLES, "arena"), project, { recursive: true });
    const settings = JSON.parse(readFileSync(join(project, "project.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(project, "project.json"), JSON.stringify({ ...settings, build: { icon: "icon.jpg" } }));
    writeFileSync(join(project, "icon.jpg"), "not a png");
    await expect(exportProject({ projectDir: project, out: temp(), target: "desktop", tauriBuild: false, playerDir: fakePlayer() })).rejects.toThrow(/PNG or SVG/);
  }, 60_000);

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
    expect(existsSync(join(out, "src-tauri", "app-icon.svg"))).toBe(true);
    const readme = readFileSync(join(out, "README.txt"), "utf8");
    expect(readme).toContain("npx @tauri-apps/cli@2 icon src-tauri/app-icon.svg");
    expect(readme).toContain("npx @tauri-apps/cli@2 build");
    expect(readFileSync(join(out, "src-tauri", "src", "gamepad.rs"), "utf8")).toBe(readFileSync(join(SRC_TAURI, "src", "gamepad.rs"), "utf8"));
  }, 60_000);
});
