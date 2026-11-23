// ADR 0370 "Third-party graph and rig nodes" (T45t): a game build meters every enabled project plugin's declared node
// module with the editor module's fuel pass, since games can't, through the Node exporter (`exportProject`). The
// project is a temporary folder with a nodes-only plugin holding the sample module unmetered (`plugin_sample_raw.wasm`)
// and metered (`plugin_sample.wasm`), and a turned-off plugin with the same module.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportProject } from "./node";

const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "myco-export-nodes-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string) => readFileSync(new URL(`../plugins/animation/runtime/wasm/fixtures/${name}`, import.meta.url));
const metered = (bytes: Uint8Array) => WebAssembly.Module.customSections(new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>), "myco.metered").length > 0;

/** A stand-in for dist/player/. */
function fakePlayer(): string {
  const dir = temp();
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "files.json"), JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] }));
  writeFileSync(join(dir, "assets", "player-x.js"), "// player");
  writeFileSync(join(dir, "myco.js"), "export {};");
  writeFileSync(join(dir, "player.html"), "<!DOCTYPE html><title>player</title>");
  return dir;
}

function project(): string {
  const dir = temp();
  const nodes = (name: string) => JSON.stringify({ name, version: "1.0.0", sdk: "^1.0.0", animationNodes: [{ module: "nodes/sample.wasm", budget: 5000 }, { module: "nodes/shipped.wasm" }] });
  const files: Record<string, string | Uint8Array> = {
    "project.json": JSON.stringify({ name: "Nodes", plugins: { disabled: ["off"] } }),
    "scenes/main.scene.json": JSON.stringify({ nodes: [] }),
    "plugins/acme/plugin.json": nodes("acme"),
    "plugins/acme/nodes/sample.wasm": fixture("plugin_sample_raw.wasm"),
    "plugins/acme/nodes/shipped.wasm": fixture("plugin_sample.wasm"),
    "plugins/off/plugin.json": nodes("off"),
    "plugins/off/nodes/sample.wasm": fixture("plugin_sample_raw.wasm"),
    "plugins/off/nodes/shipped.wasm": fixture("plugin_sample.wasm"),
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

describe("exports meter animation node modules (ADR 0370, T45t)", () => {
  it("writes an enabled plugin's modules metered, keeps metered ones as they are, and leaves a disabled plugin's out", async () => {
    const out = join(temp(), "web");
    const lines: string[] = [];
    await exportProject({ projectDir: project(), out, playerDir: fakePlayer(), log: (l) => lines.push(l) });
    const raw = fixture("plugin_sample_raw.wasm");
    expect(metered(raw)).toBe(false);
    const sample = new Uint8Array(readFileSync(join(out, "project/plugins/acme/nodes/sample.wasm")));
    expect(metered(sample)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(sample as Uint8Array<ArrayBuffer>))).toEqual([]);
    expect(new Uint8Array(readFileSync(join(out, "project/plugins/acme/nodes/shipped.wasm")))).toEqual(new Uint8Array(fixture("plugin_sample.wasm")));
    // The budgets stay in the shipped plugin.json, where the runtime loader reads them.
    expect(JSON.parse(readFileSync(join(out, "project/plugins/acme/plugin.json"), "utf8")).animationNodes[0]).toEqual({ module: "nodes/sample.wasm", budget: 5000 });
    expect(existsSync(join(out, "project/plugins/off/nodes/sample.wasm"))).toBe(false);
    expect(existsSync(join(out, "project/plugins/off/nodes/shipped.wasm"))).toBe(false);
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^plugins\/acme\/nodes\/sample\.wasm: metered \(\d+ → \d+ bytes\)\.$/), "plugins/acme/nodes/shipped.wasm: metered already; shipped as it is."]));
  });
});
