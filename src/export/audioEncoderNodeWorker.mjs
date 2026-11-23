// An encoder thread in Node (ADR 0351 §4): the `worker_threads` entry `audioEncoderNode.ts` spawns. Plain JavaScript,
// since it registers the hooks that let Node load the engine's TypeScript (src/server/tsLoader.mjs, as cli.mjs does),
// then serves requests with audioEncoderThread.ts. The wasm comes compiled from the parent (`workerData.module`).
import * as nodeModule from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const hooks = new URL("../server/tsLoader.mjs", import.meta.url);
if (typeof nodeModule.registerHooks === "function") nodeModule.registerHooks(await import(hooks.href));
else nodeModule.register(hooks.href);

const { serveEncoder } = await import("./audioEncoderThread.ts");
serveEncoder(
  {
    onMessage: (handler) => parentPort.on("message", handler),
    post: (reply, transfer) => parentPort.postMessage(reply, transfer),
  },
  async () => workerData.module,
);
