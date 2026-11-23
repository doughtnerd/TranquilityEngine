// The pose database bake worker (ADR 0370; T55): loads the editor's compile module (`anim-editor-wasm`) once and bakes one
// database per message, as `compile/clipCompile.worker.ts` compresses one clip.
//
// Messages in: `{ id, job }` (`PoseDbBakeJob`; the buffers are transferred). Out: `{ id, result }` (`PoseDbBakeResult`;
// the baked bytes transferred).
import { loadAnimationCompiler } from "../compile/compiler";
import { bakeWith, type PoseDbBakeJob, type PoseDbBakeResult } from "./bakeLogic";

const scope = self as unknown as { onmessage: ((e: MessageEvent<{ id: number; job: PoseDbBakeJob }>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };

scope.onmessage = async (e) => {
  const { id, job } = e.data;
  let result: PoseDbBakeResult;
  try {
    result = bakeWith(await loadAnimationCompiler(), job);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage({ id, result }, result.ok ? [result.bytes.buffer as ArrayBuffer] : []);
};
