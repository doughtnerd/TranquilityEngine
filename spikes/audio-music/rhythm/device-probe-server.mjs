// Serves device-probe.html for the owner's real-device run (README section 8). Two ports from one process:
//   PORT (default 8081)    the page as any host would serve it
//   ISOLATED_PORT (8082)   the same page with COOP/COEP, so `crossOriginIsolated` is true (item 4)
// `node device-probe-server.mjs [port]`. For a phone: Android, `adb reverse tcp:8081 tcp:8081 tcp:8082 tcp:8082` and open
// http://localhost:8081/ (localhost is a secure context, so the isolated page works too). iOS: the page works over the LAN
// address on 8081; the isolated page needs HTTPS (a tunnel), because isolation needs a secure context.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("./device-probe.html", import.meta.url)));
const port = Number(process.argv[2] ?? process.env.PORT ?? 8081);
const isolatedPort = Number(process.env.ISOLATED_PORT ?? port + 1);

const serve = (p, isolated) =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
      if (isolated) Object.assign(headers, { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" });
      if ((req.url ?? "/").split("?")[0] !== "/") { res.writeHead(404).end(); return; }
      res.writeHead(200, headers).end(html);
    });
    server.listen(p, "0.0.0.0", () => resolve(server));
  });

await serve(port, false);
await serve(isolatedPort, true);
console.log(`device-probe listening on ${port} (plain) and ${isolatedPort} (cross-origin isolated)`);
