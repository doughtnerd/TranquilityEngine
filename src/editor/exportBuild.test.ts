import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameManifest } from "../export/format";
import { desktopExportCommand, exportDesktopProject, exportProjectBuild, isRendezvousUrl, writeDesktopReadme } from "./exportBuild";
import { openFolderProject, readOnlyProject } from "./projects";
import { demoFolder, ROOT, type MemoryFileSystem } from "./testing";
import { joinPath } from "./projectPaths";

// Build / Export in the editor (ADR 0041): the editor's file sources (the open project's files, its scripts compiled, and the
// player fetched from beside the editor) wired to the build writer (ADR 0296), whose own suite has the rest.
const PLAYER: Record<string, string> = {
  "player/files.json": JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] }),
  "player/assets/player-x.js": "// player",
  "player/myco.js": "export {};",
  "player/player.html": "<!DOCTYPE html><title>player</title>",
};

let blobs: Map<string, Uint8Array>;
beforeEach(() => {
  blobs = new Map();
  vi.stubGlobal("document", { baseURI: "http://editor.test/" });
  let n = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:test/${n++}`;
    void (blob as Blob).arrayBuffer().then((b) => blobs.set(url, new Uint8Array(b)));
    return url;
  });
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace("http://editor.test/", "");
    const body = PLAYER[path] ?? blobs.get(url);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function folderProject(fs: MemoryFileSystem) {
  fs.files.set(`${ROOT}\\scripts\\Hello.ts`, 'import { GameBehavior, behavior } from "myco";\n@behavior("t.Hello") export class Hello extends GameBehavior {}\n');
  const project = await openFolderProject(fs, ROOT);
  await new Promise((r) => setTimeout(r, 0)); // blob bytes land
  return project;
}

describe("the Export dialog's audio capture checkbox (its option reaches the build)", () => {
  it("checked: game.json carries audioCapture; unchecked, or no option: it doesn't", async () => {
    const run = async (options?: { audioCapture?: boolean }) => {
      const fs = demoFolder();
      const project = await folderProject(fs);
      await exportProjectBuild(project, fs, "C:\\Out\\flappy", undefined, options);
      return JSON.parse(fs.files.get("C:\\Out\\flappy\\game.json") as string) as GameManifest;
    };
    expect((await run({ audioCapture: true })).audioCapture).toBe(true);
    expect(await run({ audioCapture: false })).not.toHaveProperty("audioCapture");
    expect(await run()).not.toHaveProperty("audioCapture");
  });

  it("the desktop command the dialog shows adds --audio-capture only when it is checked", async () => {
    const project = await folderProject(demoFolder());
    expect(desktopExportCommand(project)).not.toContain("--audio-capture");
    expect(desktopExportCommand(project, false)).not.toContain("--audio-capture");
    expect(desktopExportCommand(project, true)).toMatch(/--target desktop --audio-capture$/);
  });

  it("adds --debug-link with this editor's port only when debugging is on (ADR 0376)", async () => {
    const project = await folderProject(demoFolder());
    expect(desktopExportCommand(project)).not.toContain("--debug-link");
    expect(desktopExportCommand(project, false, false, true, true)).toMatch(/--target desktop --debug-link 7790$/);
  });
});

describe("the Export dialog's Rendezvous URL (ADR 0403)", () => {
  it("the desktop command adds --debug-rendezvous only with debugging on and a URL given", async () => {
    const project = await folderProject(demoFolder());
    expect(desktopExportCommand(project, false, false, true, true, false, false, "")).not.toContain("--debug-rendezvous");
    expect(desktopExportCommand(project, false, false, true, false, false, false, "wss://r.example/myco-rendezvous")).not.toContain("--debug-rendezvous");
    expect(desktopExportCommand(project, false, false, true, true, false, false, " wss://r.example/myco-rendezvous ")).toMatch(/--debug-link 7790 --debug-rendezvous "wss:\/\/r\.example\/myco-rendezvous"$/);
  });

  it("is validated as a ws:// or wss:// URL", () => {
    expect(isRendezvousUrl("wss://r.example/myco-rendezvous")).toBe(true);
    expect(isRendezvousUrl("ws://192.168.1.4:7790/myco-rendezvous")).toBe(true);
    expect(isRendezvousUrl("https://r.example")).toBe(false);
    expect(isRendezvousUrl("r.example")).toBe(false);
  });

  it("a debug export writes it as debug.rendezvous, and fetches the rendezvous bundle served beside the editor when there is one", async () => {
    PLAYER["rendezvous/rendezvous.mjs"] = "export async function startRendezvous() {}\n";
    try {
      const fs = demoFolder();
      const project = await folderProject(fs);
      const plan = await exportProjectBuild(project, fs, "C:\\Out\\flappy", undefined, { debugLink: true, debugRendezvous: "wss://r.example/myco-rendezvous" });
      expect(JSON.parse(fs.files.get("C:\\Out\\flappy\\game.json") as string).debug).toMatchObject({ rendezvous: "wss://r.example/myco-rendezvous" });
      expect(fs.files.get("C:\\Out\\flappy\\rendezvous.mjs")).toContain("startRendezvous");
      expect(fs.files.get("C:\\Out\\flappy\\serve.mjs")).toContain("./rendezvous.mjs");
      expect(plan.warnings ?? []).toEqual([]);
      // A release export has none of it.
      const release = demoFolder();
      await exportProjectBuild(await folderProject(release), release, "C:\\Out\\flappy");
      expect(release.files.has("C:\\Out\\flappy\\rendezvous.mjs")).toBe(false);
    } finally {
      delete PLAYER["rendezvous/rendezvous.mjs"];
    }
  });

  it("without the bundle beside the editor, a debug export still builds and warns", async () => {
    const fs = demoFolder();
    const plan = await exportProjectBuild(await folderProject(fs), fs, "C:\\Out\\flappy", undefined, { debugLink: true });
    expect(fs.files.has("C:\\Out\\flappy\\rendezvous.mjs")).toBe(false);
    expect(plan.warnings?.join("\n")).toContain("rendezvous.mjs");
  });
});

describe("exportProjectBuild", () => {
  it("writes the player, the project's files and its compiled scripts into the folder", async () => {
    const fs = demoFolder();
    const project = await folderProject(fs);
    const progress: number[] = [];
    const plan = await exportProjectBuild(project, fs, "C:\\Out\\flappy", (done) => progress.push(done));
    const file = (p: string) => fs.files.get(`C:\\Out\\flappy\\${p.replace(/\//g, "\\")}`);
    expect(file("index.html")).toEqual(new TextEncoder().encode(PLAYER["player/player.html"]));
    expect(file("myco.js")).toBeDefined();
    expect(file("player.html")).toBeUndefined();
    expect(file("project/project.json")).toBe(project.textOf("project.json"));
    expect(file("project/images/flappyBird.png")).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(file("code/scripts/Hello.js")).toContain('from "../../myco.js"');
    expect(file("project/scripts/Hello.ts")).toBeUndefined();
    const manifest = JSON.parse(file("game.json") as string) as GameManifest;
    expect(manifest).toEqual(plan.manifest);
    expect(manifest).toMatchObject({ name: "flappy", mainScene: "scenes/main.scene.json", scripts: [{ source: "scripts/Hello.ts", module: "code/scripts/Hello.js" }] });
    // ADR 0351, 0359 §6: the notices are a generated file; the audio report (the project has a sound) is one more.
    expect(plan.generated.has("THIRD_PARTY_NOTICES.md")).toBe(true);
    expect(progress.at(-1)).toBe(3 + plan.copies.length + plan.generated.size + (plan.audioReport ? 1 : 0));

    // Replacing an earlier build and refusing other folders: the build writer's suite (src/export/buildWriter.test.ts).
    await expect(exportProjectBuild(project, fs, `${ROOT}\\build`)).rejects.toThrow(/inside the project/);
  });

  it("explains when there's no player beside the editor", async () => {
    delete PLAYER["player/files.json"];
    try {
      const project = readOnlyProject("p", { values: new Map([["project.json", {}]]), texts: new Map([["project.json", "{}"]]) });
      await expect(exportProjectBuild(project, demoFolder(), "C:\\Out")).rejects.toThrow(/no game player/);
    } finally {
      PLAYER["player/files.json"] = JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] });
    }
  });
});

describe("exportDesktopProject (ADR 0406)", () => {
  const OUT = "C:\\Out\\desktop";
  const file = (fs: MemoryFileSystem, p: string) => fs.files.get(joinPath(OUT, p));
  /** project.json's exporter-only `build` settings (ADR 0041). */
  const setBuild = (fs: MemoryFileSystem, build: Record<string, string>) => {
    const at = joinPath(ROOT, "project.json");
    fs.files.set(at, JSON.stringify({ ...(JSON.parse(fs.files.get(at) as string) as object), build }));
  };

  it("writes the web build in web/, the generated Tauri project, the default icon's source and a README", async () => {
    const fs = demoFolder();
    const project = await folderProject(fs);
    const plan = await exportDesktopProject(project, fs, OUT);
    expect(file(fs, "web/game.json")).toBeDefined();
    expect(file(fs, "web/index.html")).toBeDefined();
    expect(file(fs, "game.json")).toBeUndefined();
    const config = JSON.parse(file(fs, "src-tauri/tauri.conf.json") as string) as { productName: string; build: { frontendDist: string } };
    expect(config).toMatchObject({ productName: plan.manifest.name, build: { frontendDist: "../web" } });
    expect(file(fs, "src-tauri/src/gamepad.rs")).toContain("myco_gamepad_listen");
    expect(file(fs, "src-tauri/app-icon.svg")).toContain("<svg");
    // The package has no icons/ until `tauri icon` runs, so the README makes them before the build.
    expect(file(fs, "README.txt")).toContain("npx @tauri-apps/cli@2 icon src-tauri/app-icon.svg");
    expect(file(fs, "README.txt")).toContain("npx @tauri-apps/cli@2 build");
    expect(file(fs, "README.txt")).not.toContain("Installers:");
  });

  it("re-exporting keeps the Rust build cache, and build.icon's PNG replaces the default icon source", async () => {
    const fs = demoFolder();
    const project = await folderProject(fs);
    await exportDesktopProject(project, fs, OUT);
    fs.files.set(joinPath(OUT, "src-tauri/target/release/cached.rlib"), new Uint8Array([7]));
    setBuild(fs, { icon: "images/flappyBird.png" });
    const withIcon = await folderProject(fs);
    await exportDesktopProject(withIcon, fs, OUT);
    expect(file(fs, "src-tauri/target/release/cached.rlib")).toEqual(new Uint8Array([7]));
    expect(file(fs, "src-tauri/app-icon.png")).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(file(fs, "src-tauri/app-icon.svg")).toBeUndefined();
    expect(file(fs, "README.txt")).toContain("npx @tauri-apps/cli@2 icon src-tauri/app-icon.png");
  });

  it("refuses an icon that isn't a PNG or SVG, before writing anything", async () => {
    const fs = demoFolder();
    setBuild(fs, { icon: "images/ground.jpg" });
    const project = await folderProject(fs);
    await expect(exportDesktopProject(project, fs, OUT)).rejects.toThrow(/PNG or SVG/);
    expect([...fs.files.keys()].some((k) => k.startsWith(OUT))).toBe(false);
  });

  it("a debug package vendors the debug link's listener crates and the multicast plugin (ADR 0403); a release one doesn't", async () => {
    const fs = demoFolder();
    const project = await folderProject(fs);
    await exportDesktopProject(project, fs, OUT);
    expect(file(fs, "src-tauri/vendor/ws-listener/Cargo.toml")).toBeUndefined();
    const debugFs = demoFolder();
    await exportDesktopProject(await folderProject(debugFs), debugFs, OUT, undefined, { debugLink: true });
    for (const crate of ["ws-listener", "debug-discovery", "debug-link-tauri"]) {
      expect(file(debugFs, `src-tauri/vendor/${crate}/Cargo.toml`)).toContain("[package]");
      expect(file(debugFs, `src-tauri/vendor/${crate}/src/lib.rs`)).toBeDefined();
    }
    expect(file(debugFs, "src-tauri/vendor/tauri-plugin-myco-multicast/android/src/main/java/com/myco/multicast/MulticastPlugin.kt")).toBeDefined();
    expect(file(debugFs, "src-tauri/Cargo.toml")).toContain('myco-debug-link-tauri = { path = "vendor/debug-link-tauri" }');
  });

  it("the README names the installers once the app is built", async () => {
    const fs = demoFolder();
    await writeDesktopReadme(fs, OUT, "flappy", true);
    expect(file(fs, "README.txt")).toContain("Installers: src-tauri/target/release/bundle/");
  });
});
