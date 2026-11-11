// The decoder worker under Node: the engine's own handler (decoder.worker.ts is a 21-line shell around it,
// decoder.worker.ts:9-20) behind worker_threads, plus a stats message that reports the worker's event-loop utilisation.
import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createDecoderHandler, hash } from '../build/engine.js';

const handler = createDecoderHandler({ post: (reply, transfer) => parentPort.postMessage(reply, transfer ?? []), expectedSourceHash: hash.sourceHash });
let mark = performance.eventLoopUtilization();
parentPort.on('message', (m) => {
  if (m && m.type === '__elu') {
    const now = performance.eventLoopUtilization();
    const d = performance.eventLoopUtilization(now, mark);
    if (m.reset) mark = now;
    parentPort.postMessage({ type: '__elu', utilization: d.utilization, active: d.active, idle: d.idle, chunks: handler.streamStats.chunks, allocated: handler.streamStats.allocated, credits: handler.streamStats.credits });
    return;
  }
  void handler.handle(m);
});
