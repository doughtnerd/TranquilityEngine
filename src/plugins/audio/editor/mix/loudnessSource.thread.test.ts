// ADR 0171/0172 (M5b, Pf6): the loudness requests on a real thread. `worker.ts` (now importing the loudness model and the
// shared `LoudnessStats`) is bundled with esbuild-wasm as `profilerSource.thread.test.ts` does and run on a
// `node:worker_threads` Worker: the series arrays cross the thread by transfer, and the values read on the thread equal the
// live hub's, bit for bit. Pattern and adapter as the Rc5 thread test.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOUD_OUTPUT_TAP } from "../../runtime/wire.generated";
import type { CaptureResponse } from "../../runtime/capture/worker";
import { LoudnessSource } from "./loudnessSource";
import { MUSIC_SLOT, buildScene } from "./loudnessSceneSupport";
import { CaptureSource, type CaptureWorkerLike } from "./profilerSource";

interface EsbuildLike {
  build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
}

const ENTRY = `
import { parentPort } from "node:worker_threads";
import { bindCaptureWorker } from ${JSON.stringify(fileURLToPath(new URL("../../runtime/capture/worker.ts", import.meta.url)))};
let listener = null;
parentPort.on("message", (data) => listener?.({ data }));
bindCaptureWorker({
  set onmessage(f) { listener = f; },
  get onmessage() { return listener; },
  postMessage: (m, t) => parentPort.postMessage(m, t),
});
`;

let dir = "";
let script = "";

beforeAll(async () => {
  const mod = (await import("esbuild-wasm")) as unknown as EsbuildLike & { default?: EsbuildLike };
  const esbuild = mod.default ?? mod;
  const out = await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("../../runtime/capture/", import.meta.url)), loader: "ts", sourcefile: "thread-entry.ts" },
    bundle: true, format: "esm", platform: "node", target: "node20", write: false,
  });
  dir = mkdtempSync(join(tmpdir(), "pf6-capture-worker-"));
  script = join(dir, "worker.mjs");
  writeFileSync(script, out.outputFiles[0]!.text);
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function threadWorker(): CaptureWorkerLike {
  const w = new Worker(script);
  const like: CaptureWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (m, t) => w.postMessage(m, t as never),
    terminate: () => void w.terminate(),
  };
  w.on("message", (data: CaptureResponse) => like.onmessage?.({ data }));
  w.on("error", (e) => like.onerror?.(e));
  return like;
}

describe("the loudness requests on a worker_threads thread", () => {
  const scene = buildScene();

  it("a reopened capture reads the live meter's values on the thread, the series arriving by transfer", async () => {
    const source = await CaptureSource.openFile(scene.file.slice().buffer, { worker: threadWorker() });
    const loud = new LoudnessSource(source);
    const info = await loud.info();
    expect(info.mode).toBe("replay");
    expect(info.buses.map((b) => b.slot).sort((a, b) => a - b)).toEqual([MUSIC_SLOT, LOUD_OUTPUT_TAP]);
    let checked = 0;
    for (const e of scene.expected) {
      const [{ values }] = await loud.valuesAt(e.t - source.startSeconds, e.slot);
      const v = values!;
      expect([v.momentary, v.shortTerm, v.integrated, v.lra, v.truePeak, v.incomplete]).toEqual(
        [e.live.momentary, e.live.shortTerm, e.live.integrated, e.live.lra, e.live.maxTruePeak, e.live.incomplete],
      );
      checked++;
    }
    expect(checked).toBe((80 + 5) * 2);
    for (const slot of [MUSIC_SLOT, LOUD_OUTPUT_TAP]) {
      const s = await loud.series(slot);
      const ref = scene.reference.series(slot)!;
      expect(s.columns.time).toBeInstanceOf(Float64Array);
      expect(s.columns.time.buffer.byteLength).toBeGreaterThan(0); // owned by main: transferred, not detached here
      expect(Array.from(s.columns.integrated)).toEqual([...ref.integrated]);
      expect(Array.from(s.columns.momentary)).toEqual([...ref.momentary]);
    }
    const marks = await loud.marks({ integrated: -24, tolerance: 2, truePeak: -1 }, { metrics: ["momentary"] });
    expect(marks.length).toBeGreaterThan(0);
    source.close();
  });
});
