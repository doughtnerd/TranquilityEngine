/** `npm run audio:migrate`: arguments, and the command run over a project on disk (a temporary folder). */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, reportLines } from "./main";

describe("audio:migrate CLI", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

  it("parses arguments", () => {
    expect(parseArgs(["p", "--dry-run"])).toEqual({ projectDir: "p", dryRun: true });
    expect(parseArgs(["p"])).toEqual({ projectDir: "p", dryRun: false });
    expect(parseArgs(["-h"])).toBe("help");
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(["p", "q"])).toThrow();
    expect(() => parseArgs(["p", "--nope"])).toThrow();
  });

  it("reports sample files (settings sidecars, derived samples) in their own words and count, apart from playlists and references", () => {
    const report = {
      written: ["audio/engine.playlist.json", "audio/hum.wav.meta.json", "audio/engine_loop.sample.json"],
      rewritten: ["scenes/main.scene.json", "audio/idle.wav.meta.json"],
      moved: [{ from: "audio/engine.audioevent.json", to: ".myco/migrated/audio/engine.audioevent.json" }],
      notes: [],
    };
    expect(reportLines(report, true)).toEqual([
      "would write audio/engine.playlist.json",
      "would write sample settings audio/hum.wav.meta.json",
      "would write derived sample audio/engine_loop.sample.json",
      "would update the sample settings in audio/idle.wav.meta.json",
      "would rewrite references in scenes/main.scene.json",
      "would move audio/engine.audioevent.json -> .myco/migrated/audio/engine.audioevent.json",
      "1 playlists to write, 3 sample files to write or update, 1 files to rewrite, 1 events to move, 0 notes.",
    ]);
    expect(reportLines(report, false)).toContain("updated the sample settings in audio/idle.wav.meta.json");
    expect(reportLines({ written: [], rewritten: [], moved: [], notes: [] }, false)).toEqual(["No audio events to migrate."]);
  });

  it("--dry-run reports and writes nothing; a real run migrates; bad arguments exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-audio-migrate-"));
    dirs.push(dir);
    mkdirSync(join(dir, "audio"));
    mkdirSync(join(dir, "scenes"));
    const eventText = JSON.stringify({ format: "myco.audioevent@1", root: { type: "clip", clip: "audio/a.wav" } });
    writeFileSync(join(dir, "audio", "a.audioevent.json"), eventText);
    writeFileSync(join(dir, "scenes", "main.scene.json"), `{ "clip": "asset:audio/a.audioevent.json" }\n`);

    const dry = run(dir, "--dry-run");
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("would write audio/a.playlist.json");
    expect(dry.stdout).toContain("would move audio/a.audioevent.json -> .myco/migrated/audio/a.audioevent.json");
    expect(existsSync(join(dir, "audio", "a.playlist.json"))).toBe(false);

    const real = run(dir);
    expect(real.status).toBe(0);
    expect(real.stdout).toContain("1 playlists written, 0 sample files written or updated, 1 files rewritten, 1 events moved");
    expect(JSON.parse(readFileSync(join(dir, "audio", "a.playlist.json"), "utf8"))).toMatchObject({ format: "myco.playlist@1", type: "clip" });
    expect(readFileSync(join(dir, "scenes", "main.scene.json"), "utf8")).toBe(`{ "clip": "asset:audio/a.playlist.json" }\n`);
    expect(readFileSync(join(dir, ".myco", "migrated", "audio", "a.audioevent.json"), "utf8")).toBe(eventText);
    expect(existsSync(join(dir, "audio", "a.audioevent.json"))).toBe(false);

    expect(run(dir).stdout).toContain("No audio events to migrate.");
    expect(run().status).toBe(2);
    expect(run(join(dir, "missing")).status).toBe(1);
  }, 60_000); // six runs of node, each loading the engine's TypeScript
});
