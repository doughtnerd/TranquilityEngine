// How the editor compiles a clip (ADR 0370; T19): in the compile worker (`clipCompile.worker.ts`, its own instance of
// the editor module), or on this thread where there are no workers (Node, tests) or the worker couldn't start, as the
// navigation bake does (0065).
import type { ClipCompileRunner } from "./cache";
import { loadAnimationCompiler, type CompileOutcome } from "./compiler";

/** @internal Compiles on this thread. */
export const inThreadRunner: ClipCompileRunner = async (job) => (await loadAnimationCompiler()).compressClip(job.raw, job.skeleton, job.record);

type Job = Parameters<ClipCompileRunner>[0];

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, { job: Job; resolve: (o: CompileOutcome) => void }>();

function compileWorker(): Worker | null {
  if (worker || workerFailed || typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(new URL("./clipCompile.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; outcome: CompileOutcome }>) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      pending.delete(e.data.id);
      job.resolve(e.data.outcome);
    };
    worker.onerror = (e) => {
      // A worker that can't start (or crashed): compile what was sent to it here instead, and everything from now on.
      e.preventDefault?.();
      workerFailed = true;
      worker?.terminate();
      worker = null;
      console.warn(`[editor] the animation compile worker stopped (${e.message || "it couldn't load"}); compiling on the main thread.`);
      const jobs = [...pending.values()];
      pending.clear();
      for (const p of jobs) inThreadRunner(p.job).then(p.resolve, (err: unknown) => p.resolve({ ok: false, error: String(err) }));
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

/** @internal The editor's runner: the compile worker, else this thread. */
export const workerRunner: ClipCompileRunner = (job) => {
  const w = compileWorker();
  if (!w) return inThreadRunner(job);
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { job, resolve });
    // Copies go to the worker (the job keeps its buffers for the in-thread fallback).
    const raw = job.raw.slice(), skeleton = job.skeleton.slice(), record = job.record.slice();
    w.postMessage({ id, raw, skeleton, record }, [raw.buffer, skeleton.buffer, record.buffer]);
  });
};
