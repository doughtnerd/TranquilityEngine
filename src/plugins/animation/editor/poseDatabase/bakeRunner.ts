// How the editor runs the pose database bake (ADR 0370: "Pose-database baking and clip compression run in a Web Worker
// with their own instance, so the editor stays responsive"; T55): in the bake worker (`poseDbBake.worker.ts`, its own
// instance of the editor compile module, as T19's clip compile worker), or on this thread where there are no workers
// (Node, tests) or the worker couldn't start, as `compile/runner.ts` does for clips.
import { loadAnimationCompiler } from "../compile/compiler";
import { bakeWith, type PoseDbBakeJob, type PoseDbBakeResult, type PoseDbBakeRunner } from "./bakeLogic";

/** @internal Bakes on this thread. */
export const inThreadBakeRunner: PoseDbBakeRunner = async (job) => bakeWith(await loadAnimationCompiler(), job);

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, { job: PoseDbBakeJob; resolve: (r: PoseDbBakeResult) => void }>();

function bakeWorker(): Worker | null {
  if (worker || workerFailed || typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(new URL("./poseDbBake.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result: PoseDbBakeResult }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      p.resolve(e.data.result);
    };
    worker.onerror = (e) => {
      // A worker that can't start (or crashed): bake what was sent to it here instead, and everything from now on.
      e.preventDefault?.();
      workerFailed = true;
      worker?.terminate();
      worker = null;
      console.warn(`[editor] the pose database bake worker stopped (${e.message || "it couldn't load"}); baking on the main thread.`);
      const jobs = [...pending.values()];
      pending.clear();
      for (const p of jobs) inThreadBakeRunner(p.job).then(p.resolve, (err: unknown) => p.resolve({ ok: false, error: String(err) }));
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

/** @internal The editor's runner: the bake worker, else this thread. */
export const workerBakeRunner: PoseDbBakeRunner = (job) => {
  const w = bakeWorker();
  if (!w) return inThreadBakeRunner(job);
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { job, resolve });
    // Copies go to the worker (the job keeps its buffers for the in-thread fallback).
    const skeleton = job.skeleton.slice();
    const clips = job.clips.map((c) => ({ ...c, bytes: c.bytes.slice() }));
    w.postMessage({ id, job: { ...job, skeleton, clips } }, [skeleton.buffer, ...clips.map((c) => c.bytes.buffer as ArrayBuffer)]);
  });
};
