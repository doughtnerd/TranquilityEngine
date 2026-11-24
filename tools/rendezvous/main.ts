// The rendezvous service's entry (ADR 0403 "Rendezvous", 0404; plan task R3). Built to one file, dist/rendezvous/rendezvous.mjs:
//   node rendezvous.mjs [--host 0.0.0.0] [--port 7790] [--path /myco-rendezvous]
// Ports (0404): 7790 here; 3000 is the dev server's and 8080 `serve.mjs`'s, which mount the rendezvous on their own port.
// The bundle also exports `startRendezvous(httpServer | { port, host }, path)` for those two to mount it.
import { fileURLToPath } from "node:url";
import { RENDEZVOUS_PATH } from "../../src/engine/debugLink/rendezvous/protocol";
import { startRendezvous } from "../../src/server/rendezvousService";

export { startRendezvous };

const USAGE = "Usage: node rendezvous.mjs [--host 0.0.0.0] [--port 7790] [--path /myco-rendezvous]";

function parse(args: string[]): { host: string; port: number; path: string } {
  const out = { host: "0.0.0.0", port: 7790, path: RENDEZVOUS_PATH };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (flag === "--host" && value) out.host = value;
    else if (flag === "--port" && value && /^\d+$/.test(value) && Number(value) <= 65535) out.port = Number(value);
    else if (flag === "--path" && value?.startsWith("/")) out.path = value;
    else throw new Error(`${flag === "--help" || flag === "-h" ? "" : `Unknown or incomplete option "${flag}". `}${USAGE}`);
  }
  return out;
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const running = await startRendezvous({ port: options.port, host: options.host }, options.path);
  console.log(`Myco rendezvous listening on ${running.url} (bound to ${options.host}:${running.address?.port})`);
  const stop = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Run when started as a script (the bundle), not when imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
