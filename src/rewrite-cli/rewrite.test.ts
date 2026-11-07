import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { registerSceneMigration, type SceneFile } from "../engine/scene/SceneLoader";
import { parseArgs } from "./main";
import { rewriteProjectFiles } from "./rewrite";

// A fixture "version 0" format: nodes used `label` instead of `name`.
registerSceneMigration(0, (file) => ({
  ...file,
  nodes: file.nodes.map((n) => {
    const { label, ...rest } = n as typeof n & { label?: string };
    return label === undefined ? rest : { ...rest, name: label };
  }),
}));

const OLD = `{
  "format": "myco.scene@0",
  "nodes": [
    { "id": "a", "label": "Camera", "components": [{ "type": "engine.Transform", "data": { "position": [0, 0, 10] } }] },

    { "id": "b", "label": "Player", "parent": "a" }
  ]
}
`;
const NEW = `{
  "format": "myco.scene@2",
  "nodes": [
    { "id": "a", "name": "Camera", "components": [{ "type": "engine.Transform", "data": { "position": [0, 0, 10] } }] },
    { "id": "b", "name": "Player", "parent": "a" }
  ]
}
`;
const LATEST = `{ "format": "myco.scene@2", "nodes": [] }\n`;

describe("rewriteProjectFiles", () => {
  it("migrates old files, skips latest ones and ignores other paths", () => {
    const r = rewriteProjectFiles(new Map([["scenes/old.scene.json", OLD], ["prefabs/ok.prefab.json", LATEST], ["project.json", "{"]]));
    expect([...r.changed.keys()]).toEqual(["scenes/old.scene.json"]);
    expect(r.unchanged).toEqual(["prefabs/ok.prefab.json"]);
    expect(r.errors).toEqual([]);
    const out = r.changed.get("scenes/old.scene.json")!;
    expect(JSON.parse(out)).toMatchObject({ format: "myco.scene@2" });
    expect(Object.keys(JSON.parse(out))).toEqual(["format", "nodes"]);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain('"name": "Camera"');
    expect(out).not.toContain("label");
  });

  it("is idempotent: its own output is latest", () => {
    const first = rewriteProjectFiles(new Map([["a.scene.json", OLD]])).changed.get("a.scene.json")!;
    const again = rewriteProjectFiles(new Map([["a.scene.json", first]]));
    expect(again.changed.size).toBe(0);
    expect(again.unchanged).toEqual(["a.scene.json"]);
  });

  it("upgrades the former tranquility format tag, keeping CRLF endings", () => {
    const text = `{\r\n  "format": "tranquility.scene@1",\r\n  "nodes": [{ "id": "a", "name": "A" }]\r\n}\r\n`;
    const out = rewriteProjectFiles(new Map([["a.prefab.json", text]])).changed.get("a.prefab.json")!;
    expect(out).toBe(`{\r\n  "format": "myco.scene@2",\r\n  "nodes": [\r\n    { "id": "a", "name": "A" }\r\n  ]\r\n}\r\n`);
  });

  it("reports files it can't migrate", () => {
    const newer = JSON.stringify({ format: "myco.scene@99", nodes: [] });
    const r = rewriteProjectFiles(new Map([["bad.scene.json", "{ nope"], ["new.scene.json", newer], ["none.scene.json", "{}"]]));
    expect(r.changed.size).toBe(0);
    expect(r.errors.map((e) => e.path).sort()).toEqual(["bad.scene.json", "new.scene.json", "none.scene.json"]);
    expect(r.errors.find((e) => e.path === "new.scene.json")!.message).toMatch(/newer/);
  });

  it("matches what a SceneFile round-trip produces", () => {
    const file = JSON.parse(NEW) as SceneFile;
    expect(rewriteProjectFiles(new Map([["x.scene.json", NEW]])).unchanged).toEqual(["x.scene.json"]);
    expect(file.nodes).toHaveLength(2);
  });
});

describe("rewrite CLI", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

  it("parses arguments", () => {
    expect(parseArgs(["p", "--check", "--dry-run"])).toEqual({ projectDir: "p", check: true, dryRun: true });
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(["p", "--nope"])).toThrow();
  });

  it("--check exits 1 without writing; a real run rewrites, then --check passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-rewrite-"));
    dirs.push(dir);
    mkdirSync(join(dir, "scenes"));
    const file = join(dir, "scenes", "a.scene.json");
    // tranquility.scene@1 migrates with the engine's own migration (1 → 2, ADR 0118), which the CLI process has.
    const old = `{ "format": "tranquility.scene@1", "nodes": [] }\n`;
    writeFileSync(file, old);
    expect(run(dir, "--check").status).toBe(1);
    expect(run(dir, "--dry-run").status).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(old);
    expect(run(dir).status).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("myco.scene@2");
    expect(run(dir, "--check").status).toBe(0);
  }, 60_000);
});
