import { createServer, request as httpRequest, type Server } from "node:http";
import { RENDEZVOUS_PORTS } from "../../src/engine/debugLink/pairing/code";
import { startRendezvous, type RunningRendezvous } from "../../src/server/rendezvousService";

// A page's room code names a rendezvous on its own origin, and only on one of `RENDEZVOUS_PORTS` (ADR 0381), but `exportAndServe`
// serves the export on a free port, and (until plan task R4) the export's `serve.mjs` hosts no rendezvous. This is the stand-in: a
// small HTTP server in the test process on the first free port of 7790..7799 that forwards every request to the export's server
// and mounts a rendezvous (`startRendezvous`, the R3 service) at `/myco-rendezvous` on the same port, as R4's `serve.mjs` will.
// After R4 the spec can open the export's own origin instead (served on a listed port) and drop this file.

export interface RoomFront {
  /** `http://localhost:<port>/`: open the game here, so its page is on a rendezvous port, from `localhost`. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Fronts the server at `target` (`http://127.0.0.1:<port>/`) with a rendezvous on the first free port of `RENDEZVOUS_PORTS` below 7800. */
export async function startRoomFront(target: string): Promise<RoomFront> {
  const upstream = new URL(target);
  for (const port of RENDEZVOUS_PORTS.filter((p) => p >= 7790 && p <= 7799)) {
    const http: Server = createServer((req, res) => {
      const forward = httpRequest({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers }, (back) => {
        res.writeHead(back.statusCode ?? 502, back.headers);
        back.pipe(res);
      });
      forward.on("error", () => {
        res.writeHead(502);
        res.end("Bad gateway");
      });
      req.pipe(forward);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, resolve); // no host: both IPv4 and IPv6, as `localhost` resolves to either
      });
    } catch {
      continue; // taken (another worker's front, or a desktop editor's link): the next port
    }
    const rendezvous: RunningRendezvous = await startRendezvous(http);
    return {
      url: `http://localhost:${port}/`,
      port,
      async close() {
        await rendezvous.close();
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
      },
    };
  }
  throw new Error("no port of 7790..7799 is free for the rendezvous");
}
