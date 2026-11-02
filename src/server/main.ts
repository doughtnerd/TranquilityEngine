/**
 * `tranquility-server`: a headless dedicated server (T14, ADR 0033 §8, 0035).
 *
 * ```sh
 * npm run server -- <projectDir> [--port N] [--host H] [--max-connections N] [--tick-rate N]
 * npx tranquility-server <projectDir> …     # the same, through package.json's `bin`
 * ```
 *
 * What it does:
 * - Reads the project folder: `project.json`, every JSON asset (scenes, prefabs, data), and the
 *   scripts under `scripts/`, compiled with the TypeScript compiler and loaded before the Engine
 *   starts, so their components, systems, RPCs and inputs are registered (the editor's script
 *   loader, ADR 0030). Images and audio aren't loaded; their paths resolve, to `file:` URLs.
 * - Runs only the bootstrap's Worlds tagged "server" (ADR 0032), plus any templates they create
 *   later. Other Worlds (clients, local play) are skipped, and so are links between them.
 * - Has each server World listen over WebSocket: on the port (or `address`) of the bootstrap
 *   link that connects to it, else, for the first server World, on `--port` or 7777. `--port`
 *   overrides the first server World's port, `--host` the interface every World binds (default
 *   all), and `--max-connections` how many clients each accepts (default 64).
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
import { DEFAULT_PORT, ServerError, startServer, type RunningServer, type ServerOptions } from "./run";

export const USAGE = `Usage: tranquility-server <projectDir> [options]

Runs a project's server Worlds headless and has them listen over WebSocket.

Options:
  --port N             Port for the first server World (default: its bootstrap link's, else ${DEFAULT_PORT}; 0 picks a free one)
  --host H             Interface to listen on (default: all)
  --max-connections N  Clients each server World accepts at once (default ${DEFAULT_MAX_CONNECTIONS})
  --tick-rate N        Engine steps per second (default: the fastest server World's tick rate)
  --stats-interval S   Seconds between stats lines (default 60; 0 turns them off)
  -h, --help           Show this help`;

/** Bad command-line arguments. */
export class UsageError extends Error {}

/** `argv` (without node and the script) as server options, or `"help"`. Throws a `UsageError`. */
export function parseArgs(argv: readonly string[]): ServerOptions | "help" {
  const options: Partial<ServerOptions> = {};
  const positional: string[] = [];
  const number = (flag: string, text: string | undefined, check: (n: number) => boolean, what: string): number => {
    const n = text === undefined || text.trim() === "" ? NaN : Number(text);
    if (!check(n)) throw new UsageError(`${flag} needs ${what} (got ${text === undefined ? "nothing" : JSON.stringify(text)}).`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case "-h":
      case "--help":
        return "help";
      case "--port":
        options.port = number(flag, value(), (n) => Number.isInteger(n) && n >= 0 && n <= 65535, "a port from 0 to 65535");
        break;
      case "--host": {
        const host = value();
        if (!host || host.startsWith("-")) throw new UsageError(`--host needs a host name or address (got ${host === undefined ? "nothing" : JSON.stringify(host)}).`);
        options.host = host;
        break;
      }
      case "--max-connections":
        options.maxConnections = number(flag, value(), (n) => Number.isInteger(n) && n >= 1, "a whole number of at least 1");
        break;
      case "--tick-rate":
        options.tickRate = number(flag, value(), (n) => Number.isFinite(n) && n > 0 && n <= 1000, "a number of steps per second, above 0 and at most 1000");
        break;
      case "--stats-interval":
        options.statsIntervalMs = number(flag, value(), (n) => Number.isFinite(n) && n >= 0, "a number of seconds (0 for none)") * 1000;
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}.`);
        positional.push(arg);
    }
  }
  if (positional.length === 0) throw new UsageError("Give the project folder to run.");
  if (positional.length > 1) throw new UsageError(`Give one project folder (got ${positional.map((p) => JSON.stringify(p)).join(", ")}).`);
  return { ...options, projectDir: positional[0] };
}

/**
 * Run the server from the command line. Resolves with an exit code once it can't start (1, or 2
 * for bad arguments) or `--help` printed (0); while it runs, it resolves with undefined and
 * SIGINT/SIGTERM later stop it and exit 0.
 */
export async function main(argv: readonly string[]): Promise<number | undefined> {
  let options: ServerOptions | "help";
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`tranquility-server: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (options === "help") {
    console.log(USAGE);
    return 0;
  }

  let server: RunningServer;
  try {
    server = await startServer(options);
  } catch (err) {
    console.error(err instanceof ServerError ? `tranquility-server: ${err.message}` : err);
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
