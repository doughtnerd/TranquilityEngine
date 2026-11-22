/**
 * `myco-server`: a headless dedicated server (T14, ADR 0033 §8, 0035).
 *
 * ```sh
 * npm run server -- <projectDir> [--port N] [--host H] [--max-connections N] [--tick-rate N] [--udp-port N] …
 * npx myco-server <projectDir> …     # the same, through package.json's `bin`
 * ```
 *
 * What it does:
 * - Reads the project folder: `project.json`, every JSON asset (scenes, prefabs, data), and the
 *   scripts under `scripts/`, compiled with the TypeScript compiler and loaded before the Engine
 *   starts, so their components, systems, RPCs and inputs are registered (the editor's script
 *   loader, ADR 0030). Images and audio aren't loaded; their paths resolve, to `file:` URLs.
 * - Runs only the bootstrap's Worlds tagged "server" (ADR 0032), or, if it has none, its
 *   server-tagged templates. Other Worlds (clients, local play) are skipped, and so are links
 *   between them. Server Worlds game code creates later run, and listen when code calls
 *   `WorldHandle.listen` (ADR 0067; a lobby's matches): without a port, on the first server
 *   World's port, by path.
 * - Has each server World listen over WebSocket: on the port (or `address`) of the bootstrap
 *   link that connects to it, else, for the first server World, on `--port` or 7777. `--port`
 *   overrides the first server World's port, `--host` the interface every World binds (default
 *   all), and `--max-connections` how many clients each accepts (default 64).
 * - Offers each browser client a WebRTC data channel beside its WebSocket for unreliable messages
 *   (ADR 0333; node-datachannel). `--udp-port` puts every channel on one UDP port (open it in the
 *   firewall), `--public-ip` names the address clients reach behind one-to-one NAT, and
 *   `--no-webrtc` keeps everyone on WebSocket. A client whose channel can't open stays on WebSocket.
 * - Steps the Engine on a drift-free timer at the fastest server World's tick rate (`--tick-rate`
 *   sets the steps per second instead; each World still simulates at its own fixed rate, which its
 *   clients must match). Logs a line per connection opened or closed, and stats every minute.
 * - On SIGINT or SIGTERM (Ctrl+C), disposes the Engine, which closes every connection and socket,
 *   and exits 0. Exits 1 with a message for a bad project folder, a script that doesn't compile or
 *   throws, a bootstrap problem or a port in use; 2 for bad arguments.
 *
 * What it doesn't do (yet): TLS (`wss://`; put it behind a reverse proxy, ADR 0035), hot reload
 * of scripts, transports other than WebSocket, code bootstraps that do more with a skipped World
 * than create it and `connect` it, or any rendering and audio: a project's server Worlds must run
 * headless (no code in them that needs a canvas, a DOM or Web Audio).
 *
 * Node runs this file from source through `cli.mjs`, whose module hooks (`tsLoader.mjs`) compile
 * the engine's TypeScript as it loads.
 */
import { DEFAULT_MAX_CONNECTIONS } from "../engine/net/session";
import { parseCommandLine, readCommandLine, UsageError, type Command } from "./commandLine";
import { DEFAULT_PORT, ServerError, startServer, type RunningServer, type ServerOptions } from "./run";

export const USAGE = `Usage: myco-server <projectDir> [options]

Runs a project's server Worlds headless and has them listen over WebSocket.

Options:
  --port N             Port for the first server World (default: its bootstrap link's, else ${DEFAULT_PORT}; 0 picks a free one)
  --host H             Interface to listen on (default: all)
  --max-connections N  Clients each server World accepts at once (default ${DEFAULT_MAX_CONNECTIONS})
  --tick-rate N        Engine steps per second (default: the fastest server World's tick rate)
  --stats-interval S   Seconds between stats lines (default 60; 0 turns them off)
  --udp-port N         One UDP port for every client's WebRTC data channel (default: an ephemeral port each)
  --public-ip A        The address clients reach this machine at, for WebRTC behind one-to-one NAT
  --no-webrtc          Keep every client on WebSocket alone (no WebRTC data channels)
  -h, --help           Show this help`;

/** A number option's value, checked; `what` says what it must be. */
const number = (text: string, flag: string, check: (n: number) => boolean, what: string): number => {
  const n = text.trim() === "" ? NaN : Number(text);
  if (!check(n)) throw new UsageError(`${flag} needs ${what} (got ${JSON.stringify(text)}).`);
  return n;
};

const PORT = "a port from 0 to 65535";
const CONNECTIONS = "a whole number of at least 1";
const TICK_RATE = "a number of steps per second, above 0 and at most 1000";
const SECONDS = "a number of seconds (0 for none)";
const UDP_PORT = "a port from 1 to 65535";

/** The WebRTC settings so far; refused after `--no-webrtc`. */
const webrtcOf = (o: ServerOptions, flag: string): { udpPort?: number; publicIp?: string } => {
  if (o.webrtc === false) throw new UsageError(`${flag} can't be used with --no-webrtc.`);
  return o.webrtc ?? {};
};

const SERVER_COMMAND: Command<ServerOptions> = {
  argument: "project folder",
  verb: "run",
  options: {
    "--port": { takes: PORT, set: (o, v, f) => void (o.port = number(v, f, (n) => Number.isInteger(n) && n >= 0 && n <= 65535, PORT)) },
    "--host": { takes: "a host name or address", set: (o, v) => void (o.host = v) },
    "--max-connections": { takes: CONNECTIONS, set: (o, v, f) => void (o.maxConnections = number(v, f, (n) => Number.isInteger(n) && n >= 1, CONNECTIONS)) },
    "--tick-rate": { takes: TICK_RATE, set: (o, v, f) => void (o.tickRate = number(v, f, (n) => Number.isFinite(n) && n > 0 && n <= 1000, TICK_RATE)) },
    "--stats-interval": { takes: SECONDS, set: (o, v, f) => void (o.statsIntervalMs = number(v, f, (n) => Number.isFinite(n) && n >= 0, SECONDS) * 1000) },
    "--udp-port": { takes: UDP_PORT, set: (o, v, f) => void (o.webrtc = { ...webrtcOf(o, f), udpPort: number(v, f, (n) => Number.isInteger(n) && n >= 1 && n <= 65535, UDP_PORT) }) },
    "--public-ip": { takes: "an IP address", set: (o, v, f) => void (o.webrtc = { ...webrtcOf(o, f), publicIp: v }) },
    "--no-webrtc": { set: (o) => void (o.webrtc = false) },
  },
};

/** `argv` (without node and the script) as server options, or `"help"`. Throws a `UsageError`. */
export function parseArgs(argv: readonly string[]): ServerOptions | "help" {
  const parsed = parseCommandLine(argv, SERVER_COMMAND);
  return parsed === "help" ? parsed : { ...parsed.options, projectDir: parsed.argument };
}

/**
 * Run the server from the command line. Resolves with an exit code once it can't start (1, or 2
 * for bad arguments) or `--help` printed (0); while it runs, it resolves with undefined and
 * SIGINT/SIGTERM later stop it and exit 0.
 */
export async function main(argv: readonly string[]): Promise<number | undefined> {
  const options = readCommandLine("myco-server", USAGE, () => parseArgs(argv));
  if (typeof options === "number") return options;

  let server: RunningServer;
  try {
    server = await startServer(options);
  } catch (err) {
    console.error(err instanceof ServerError ? `myco-server: ${err.message}` : err);
    return 1;
  }

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      process.exit(130); // asked twice: don't wait
    }
    stopping = true;
    console.log(`[server] ${signal}: shutting down.`);
    void server.close().then(() => {
      process.exitCode = 0;
      // Everything is closed, so Node exits once close frames are flushed; don't let a slow peer hold it.
      setTimeout(() => process.exit(0), 2000).unref();
    });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  return undefined;
}
