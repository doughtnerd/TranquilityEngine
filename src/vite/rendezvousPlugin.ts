// The dev server answers the rendezvous (ADR 0403 "Rendezvous", 0404; plan task R4): `/myco-rendezvous` on the port the
// pages come from (3000), so two pages opened from one dev server pair by room code through it. The coordinator mounts
// it in vite.config.ts: `plugins: [..., rendezvous()]`. It attaches to the dev server's own http server by `upgrade`,
// at its path only, so Vite's HMR socket (which upgrades its own path) is left alone.
import type { Server } from "node:http";
import type { Plugin } from "vite";
import { RENDEZVOUS_PATH } from "../engine/debugLink/rendezvous/protocol";

export function rendezvous(path: string = RENDEZVOUS_PATH): Plugin {
  return {
    name: "myco:rendezvous",
    apply: "serve",
    async configureServer(server) {
      const http = server.httpServer;
      if (!http) return; // middleware mode: no http server of its own to attach to
      const { startRendezvous } = await import("../server/rendezvousService");
      // http, https and http2 servers all emit "upgrade"; the service only listens for it.
      const running = await startRendezvous(http as unknown as Server, path);
      http.once("close", () => void running.close());
    },
  };
}
