// ADR 0171 (K0): `Audio.capture`'s lazy recorder chunk. A game that never calls `start()` loads no recorder: the chunk
// loader is never called, and no source file imports `capture/recorder.ts` statically.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Audio } from "../Audio";
import { _setRecorderLoader, NOTHING_RECORDED, type RecorderModule } from "./capture";

const SRC = join(__dirname, "../../../..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("Audio.capture (K0)", () => {
  let restore: (() => Promise<RecorderModule>) | null = null;
  afterEach(() => {
    if (restore) _setRecorderLoader(restore);
    restore = null;
  });

  it("loads no recorder module while start() is never called", async () => {
    const load = vi.fn(() => Promise.resolve({ recorderModule: true as const }));
    restore = _setRecorderLoader(load);
    const capture = Audio.capture;
    expect(capture.state).toBe("idle");
    expect(capture.seconds).toBe(0);
    expect(capture.bytes).toBe(0);
    expect(capture.truncated).toBe(false);
    capture.mark("no ring");
    capture.stop();
    await expect(capture.save("take")).rejects.toThrow(NOTHING_RECORDED);
    expect(load).not.toHaveBeenCalled();
  });

  it("start() is what loads the recorder chunk", async () => {
    const load = vi.fn(() => Promise.resolve({ recorderModule: true as const }));
    restore = _setRecorderLoader(load);
    await expect(Audio.capture.start()).rejects.toThrow();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("no runtime source imports capture/recorder statically (only capture.ts, through import())", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      // A static import or re-export naming the recorder module (any relative spelling).
      if (/^\s*(import|export)\b[^;]*from\s+["'][^"']*capture\/recorder["']/m.test(text) || /^\s*(import|export)\b[^;]*from\s+["']\.\/recorder["']/m.test(text) && file.includes(`${sep}capture${sep}`)) {
        offenders.push(relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
