/**
 * The dedicated server's core (T14, ADR 0033 §8): load a project, create an Engine with only its
 * server-tagged Worlds, have them listen over WebSocket, and step the Engine on a timer until
 * closed. `main.ts` is the command line around it; tests call `startServer` directly.
 */
import "./websocketServer"; // registers the Node "websocket" transport, which can listen
import { type Bootstrap, type Engine, type BootstrapConfig, type BootstrapEngine, type LinkConfig, type WorldConfig, type WorldHandle } from "../engine";
import { BootstrapError, assertValidBootstrap } from "../engine/core/bootstrap";
import { bootstrapTopology, isServerConfig } from "../engine/core/bootstrapTopology";
import { DEFAULT_WORLD_TAGS } from "../engine/core/worlds";
import type { World } from "../engine/core/World";
import { launchGame, type LaunchedGame } from "../engine/launch";
import { listenTarget, type ListenTarget } from "../engine/net/listenTarget";
import { listenWorld, netSession, type NetPeer } from "../engine/net/session";
import { loadProjectCode, readProject, scriptExports, ServerError, type ServerProject } from "./project";
import { activateGamePlugins } from "../plugins/runtime";

export { ServerError } from "./project";

/** The port the first server World listens on when neither a link nor `--port` gives one. */
export const DEFAULT_PORT = 7777;

/** How often stats are logged by default. */
export const DEFAULT_STATS_INTERVAL_MS = 60_000;

export interface ServerOptions {
  /** The project folder (holding `project.json`). */
  projectDir: string;
  /** The first server World's port, over its link's (0 picks a free one). */
  port?: number;
  /** The interface every server World listens on, over its link's (default: all of them). */
  host?: string;
  /** Connections each server World accepts at once (default `DEFAULT_MAX_CONNECTIONS`, 64). */
  maxConnections?: number;
  /** Engine steps per second (default: the fastest server World's tick rate). */
  tickRate?: number;
  /**
   * WebRTC data channels for unreliable messages (ADR 0333), for every server World: `false` turns
   * them off; `udpPort` and `publicIp` go to the transport's `webrtc` option, over its link's.
   */
  webrtc?: false | { udpPort?: number; publicIp?: string };
  /** Where log lines go (default `console.log`). */
  log?: (line: string) => void;
  /** How often to log stats, in ms; 0 turns them off. Default `DEFAULT_STATS_INTERVAL_MS`. */
  statsIntervalMs?: number;
}

/** A server World that's listening. */
export interface ServerListener {
  readonly world: string;
  /** Where clients on this machine can connect, e.g. "ws://localhost:7777". */
  readonly url: string;
  readonly port: number;
}

export interface RunningServer {
  readonly engine: Engine;
  readonly project: ServerProject;
  readonly listeners: readonly ServerListener[];
  /** Engine steps per second. */
  readonly tickRate: number;
  /** Stop stepping and dispose the Engine, closing every connection and socket. */
  close(): Promise<void>;
}

/**
 * Load the project at `options.projectDir` and run its server Worlds. Resolves once every server
 * World that has an address is listening; rejects with a `ServerError` for a bad folder, a script
 * that doesn't load, a bootstrap problem or a port in use (nothing is left running then).
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const project = await readProject(options.projectDir);
  const { loaded, plugins: thirdParty } = await loadProjectCode(project); // scripts and third-party runtime halves (ADR 0139)
  log(`[server] Project "${project.settings.name ?? project.root}" (${project.root}): ${loaded.length} script${loaded.length === 1 ? "" : "s"} loaded.`);

  const plan = await serverBootstrap(project);
  let game: LaunchedGame;
  try {
    // The launch (ADR 0236), with the scripts loaded above (the bootstrap plan needs them) and the filtered bootstrap.
    game = await launchGame({
      assets: project.assets,
      // The plugin set (ADR 0144): first-party runtime halves (ADR 0135) and the third-party ones (ADR 0139),
      // minus drawing-only (`server: false`) and the project's disabled ones (ADR 0133). A plugin that fails
      // to activate stops the server, like a broken script.
      activatePlugins: () => activateGamePlugins(thirdParty, { disabled: project.settings.plugins?.disabled, server: true }),
      project: project.settings,
      bootstrap: plan.bootstrap,
      // A dedicated server runs a project folder, not a build: it has no main scene, so empty server Worlds stay
      // empty (their scenes come from the bootstrap, or their code loads them at runtime, as a lobby's do).
      entryScene: null,
      headless: true,
    });
  } catch (err) {
    if (err instanceof BootstrapError) throw new ServerError(`The project's bootstrap is invalid:\n${err.problems.map((p) => `  - ${p}`).join("\n")}`);
    if (err instanceof ServerError) throw err;
    throw new ServerError(`The project's server Worlds couldn't start: ${(err as Error).message}`);
  }
  // After the bootstrap ran: a code bootstrap's skipped Worlds are known only then.
  for (const name of plan.skipped) log(`[server] Skipping World "${name}": it isn't tagged "server".`);
  const engine = game.engine;
  const shutDown = () => game.dispose(); // the Engine, then the project's assets

  const listeners: ServerListener[] = [];
  try {
    const servers = engine.worlds().filter((w) => w.hasTag("server"));
    if (servers.length === 0) throw new ServerError("The bootstrap created no Worlds tagged \"server\"; there's nothing to run.");
    for (const [i, handle] of servers.entries()) {
      const listener = await serverListen(engine._world(handle.name)!, plan.links.find((l) => l.to === handle.name), i === 0 ? "first" : "start-up", options, log);
      if (listener) listeners.push(listener);
    }
  } catch (err) {
    shutDown();
    throw err;
  }
  // ADR 0067: Worlds created at runtime (a lobby's matches) that listen without a port share the
  // first server World's port (`--port`, its real one if that was 0), by path.
  if (listeners.length > 0) {
    const webrtc = webRtcOverride(options);
    engine._setListenDefaults("websocket", { port: listeners[0].port, ...(options.host ? { host: options.host } : {}), ...(webrtc === undefined ? {} : { options: { webrtc } }) });
  }

  const rates = engine.worlds().map((w) => 1 / engine._world(w.name)!.time.fixedDeltaTime);
  const tickRate = options.tickRate ?? Math.max(...rates);
  if (!(Number.isFinite(tickRate) && tickRate > 0)) {
    shutDown();
    throw new ServerError(`The tick rate must be a positive number (got ${tickRate}).`);
  }
  // ADR 0062, 0323: a server template created at runtime listens where a link to it from a skipped
  // (client) World says, by the same operation as the start-up Worlds; the Engine's link applier
  // says when one appears (at the start of the frame after its creation, so its code has had its say).
  engine._watchLinks(plan.spawnLinks, (world, link) => {
    if (!world.worldTags.includes("server")) return;
    serverListen(world, link, "runtime", options, log).catch((err: Error) => log(`[server] ${err.message}`));
  });
  const loop = runLoop(engine, tickRate, log, options.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS, new Set(engine.worlds().map((w) => w.name)));
  log(`[server] Running at ${round(tickRate)} steps/s. Press Ctrl+C to stop.`);

  let closing: Promise<void> | null = null;
  return {
    engine,
    project,
    listeners,
    tickRate,
    close() {
      return (closing ??= (async () => {
        loop.stop();
        shutDown();
        log("[server] Stopped.");
      })());
    },
  };
}

// --- which Worlds -------------------------------------------------------------------------------

interface ServerPlan {
  /** What to pass `Engine.create`: the server Worlds only. */
  readonly bootstrap: BootstrapConfig | Bootstrap;
  /** Links from skipped (client) Worlds to server Worlds: where those listen. */
  readonly links: readonly LinkConfig[];
  /**
   * Links from skipped Worlds to server-tagged Spawnable Worlds (templates) the server doesn't
   * create at start (ADR 0062): when game code creates one, it listens where its link says.
   */
  readonly spawnLinks: readonly LinkConfig[];
  /** Worlds left out. */
  readonly skipped: readonly string[];
}

/**
 * The project's bootstrap cut down to its server Worlds. A declarative one keeps the Worlds its
 * bootstrap topology (ADR 0256) says a dedicated server starts (the start-up servers, else the
 * lobbies, else the Host template, named as `Engine.createWorld` would name it), the links between
 * server Worlds, and every template (created later by name); links from other Worlds to a server
 * World say where it listens, and links to server templates not created at start are kept for when
 * game code creates them (ADR 0062). A code bootstrap
 * runs against an Engine whose `createWorld` skips Worlds not tagged "server", returning an inert
 * handle whose `connect` records the link instead.
 */
async function serverBootstrap(project: ServerProject): Promise<ServerPlan> {
  const setting = project.settings.bootstrap;
  if (setting === undefined) {
    throw new ServerError(
      "The project has no bootstrap, so its one World isn't a server. Add a bootstrap to project.json with a World tagged \"server\", e.g.\n" +
        '  "bootstrap": { "worlds": [{ "name": "Server", "tags": ["server"], "scenes": ["scenes/main.scene.json"] }] }',
    );
  }
  if (typeof setting === "string") return codeBootstrap(setting);
  try {
    assertValidBootstrap(setting);
  } catch (err) {
    if (err instanceof BootstrapError) throw new ServerError(`The project's bootstrap is invalid:\n${err.problems.map((p) => `  - ${p}`).join("\n")}`);
    throw err;
  }
  // The bootstrap topology (ADR 0256) says which Worlds the server starts and where they listen; play mode reads the same.
  const topology = bootstrapTopology(setting)!;
  if (topology.serverStart.length === 0) {
    throw new ServerError(`The project's bootstrap has no Worlds or templates tagged "server" (it has ${topology.skipped.map((n) => `"${n}"`).join(", ")}); there's nothing for a dedicated server to run.`);
  }
  return {
    // Links between server Worlds (start-up or spawnable) apply in the server's Engine as they would anywhere.
    bootstrap: { worlds: [...topology.serverStart], links: [...topology.serverLinks], ...(setting.templates ? { templates: setting.templates } : {}) },
    links: topology.listenLinks,
    spawnLinks: topology.spawnLinks,
    skipped: topology.skipped,
  };
}

async function codeBootstrap(path: string): Promise<ServerPlan> {
  let exports: Record<string, unknown>;
  try {
    exports = await scriptExports(path);
  } catch (err) {
    throw new ServerError(`The project's bootstrap script couldn't be loaded: ${(err as Error).message}`);
  }
  const script = exports.bootstrap;
  if (typeof script !== "function") throw new ServerError(`The bootstrap script "${path}" must export a function named bootstrap(engine).`);
  const links: LinkConfig[] = [];
  const skipped: string[] = [];
  const bootstrap: Bootstrap = async (engine) => {
    const stubs = new Map<string, WorldHandle>();
    const filtered: BootstrapEngine = {
      settings: engine.settings,
      findWorld: (name) => engine.findWorld(name) ?? stubs.get(name) ?? null,
      createWorld(config) {
        if (typeof config === "string" || isServerConfig(config)) return engine.createWorld(config);
        skipped.push(config.name);
        const stub = skippedWorld(config, links);
        stubs.set(config.name, stub);
        return stub;
      },
    };
    await (script as Bootstrap)(filtered);
  };
  return { bootstrap, links, spawnLinks: [], skipped };
}

/** The handle a code bootstrap gets for a World the server skips: inert, except that `connect` records the link. */
function skippedWorld(config: WorldConfig, links: LinkConfig[]): WorldHandle {
  const tags = config.tags ?? DEFAULT_WORLD_TAGS;
  return {
    name: config.name,
    tags,
    alive: false,
    paused: false,
    hasTag: (tag) => tags.includes(tag),
    loadScene: async () => {},
    addSystem() {},
    removeSystem() {},
    systems: () => [],
    connect(server, transport, options) {
      if (typeof server === "string") return; // a client of some other server: nothing to listen for here
      links.push({ from: config.name, to: server.name, transport, ...(options ? { options } : {}) });
    },
    listen: () => Promise.reject(new Error(`World "${config.name}" isn't run by the dedicated server (it isn't tagged "server").`)),
    addresses: () => [],
    pause() {},
    resume() {},
    destroy() {},
  };
}

/**
 * The one server listen (ADR 0323), for the start-up server Worlds and for server templates created
 * at runtime (`kind`): have `world` listen over WebSocket where `link` says (ADR 0255), under `--host`
 * and `--port`. Resolves with the listener, or null when it doesn't listen: its code listens already
 * or is starting to (a lobby's match World), or there's no port for it (logged). Rejects with a
 * `ServerError` worded for the log: a bad address, a port in use, no permission.
 */
async function serverListen(world: World, link: LinkConfig | undefined, kind: ServerWorldKind, cli: ServerOptions, log: (line: string) => void): Promise<ServerListener | null> {
  if (netSession(world)?.listens()) return null; // its code listens where it wants
  const first = kind === "first";
  const name = kind === "runtime" ? `World "${world.name}" (created at runtime)` : `World "${world.name}"`;
  if (link && link.transport !== "websocket") log(`[server] ${name}: its link from "${link.from}" uses "${link.transport}"; a dedicated server listens over "websocket".`);
  const listen = listenOptions(name, link, first, cli);
  if (!listen) {
    const why = link ? `its link from "${link.from}" gives no WebSocket port` : "no link connects to it";
    log(`[server] ${name} isn't listening: ${why}${kind === "runtime" ? "; its code can still listen on the server's port, by path" : ", and --port only applies to the first server World"}.`);
    return null;
  }
  const url = await listenWorld(world, "websocket", listen.options).catch((err: Error) => {
    // The first World's port can come from --port; another's comes from its link.
    const pick = first || !link ? "pick another port with --port" : `change the port in its link from "${link.from}"`;
    if (/EADDRINUSE|is already listened on/.test(err.message)) throw new ServerError(`Port ${listen.port} is already in use, so ${name} can't listen there. Stop whatever is using it, or ${pick}.`);
    if (/EACCES/.test(err.message)) throw new ServerError(`${name} isn't allowed to listen on port ${listen.port} (ports below 1024 usually need privileges). ${pick[0].toUpperCase()}${pick.slice(1)}.`);
    throw new ServerError(err.message);
  });
  if (kind !== "runtime") log(`[server] ${name} listening on ${url}${listen.host ? "" : " (all interfaces)"}.`); // a runtime World's is logged with the connections
  return { world: world.name, url, port: Number(new URL(url).port || 80) };
}

/**
 * Which server World a listen is for: the first start-up one (`--port` applies to it, else
 * `DEFAULT_PORT`), another start-up one, or one created at runtime from a template.
 */
type ServerWorldKind = "first" | "start-up" | "runtime";

/**
 * The options to listen with for a server World: its link's, with the address from its listen
 * target (ADR 0255: the link's `address`, else its `port`, `host` and `path`, else its `url`'s port
 * and path), under `--host` (every World) and `--port` (the first, which also falls back to
 * `DEFAULT_PORT`). Null if there's no port for it. `name` names the World in errors.
 */
function listenOptions(name: string, link: LinkConfig | undefined, first: boolean, cli: ServerOptions): { options: Record<string, unknown>; port: number; host?: string } | null {
  // Another transport's options (a loopback name) mean nothing to a WebSocket server.
  const linked = link?.transport === "websocket" ? (link.options ?? {}) : {};
  let target: ListenTarget | null;
  try {
    target = listenTarget("websocket", linked, {
      overrides: { host: cli.host, port: first ? cli.port : undefined },
      defaults: first ? { port: DEFAULT_PORT } : undefined,
    });
  } catch (err) {
    throw new ServerError(`${name}: the link from "${link!.from}" has a bad address. ${(err as Error).message}`);
  }
  if (!target) return null;
  const port = target.port as number;
  if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) throw new ServerError(`${name}: ${port} isn't a port (0 to 65535).`);
  const { url: _url, ...rest } = link?.options ?? {}; // a client's address, not the server's to report
  const options: Record<string, unknown> = { ...rest, address: target.address };
  if (cli.maxConnections !== undefined) options.maxConnections = cli.maxConnections;
  const webrtc = webRtcOverride(cli, rest.webrtc);
  if (webrtc !== undefined) options.webrtc = webrtc;
  return { options, port, host: target.host };
}

/**
 * The `webrtc` transport option the command line makes of `linked` (a link's own, if any): `false`
 * for `--no-webrtc`, the link's object with `--udp-port` and `--public-ip` over it, or undefined
 * when the command line says nothing.
 */
function webRtcOverride(cli: ServerOptions, linked?: unknown): unknown {
  if (cli.webrtc === undefined) return undefined;
  if (cli.webrtc === false) return false;
  const base = typeof linked === "object" && linked !== null ? linked : {};
  return { ...base, ...cli.webrtc };
}

// --- the loop -----------------------------------------------------------------------------------

/**
 * Step `engine` `rate` times a second on a drift-free timer: each step is scheduled for
 * `start + n / rate` on the monotonic clock (`performance.now()`), not "an interval after the
 * last one", so timer lateness doesn't accumulate. Each step gets the real time since the last,
 * and the Worlds' fixed-step accumulators turn that into exact ticks. If the process falls more
 * than a few steps behind (a long GC, a suspended VM), the schedule restarts from now rather than
 * bursting to catch up; the Worlds still see the elapsed time (capped by `time.maxFrameTime`).
 *
 * Also logs connections opening and closing on the server Worlds, and stats every `statsMs`.
 * `started`: the Worlds the bootstrap made (the rest were created at runtime).
 */
function runLoop(engine: Engine, rate: number, log: (line: string) => void, statsMs: number, started: ReadonlySet<string>): { stop(): void } {
  const intervalMs = 1000 / rate;
  let last = performance.now();
  let next = last + intervalMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const watch = connectionWatcher(engine, log, started);

  let steps = 0;
  let statsAt = last;
  let statsTicks = ticksByWorld(engine);
  let lastError = "";

  const frame = () => {
    if (stopped) return;
    const now = performance.now();
    try {
      engine.step((now - last) / 1000);
      lastError = "";
    } catch (err) {
      // A script error shouldn't take the server down; repeats of the same one are logged once.
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      if (message !== lastError) log(`[server] Error in a frame: ${message}`);
      lastError = message;
    }
    last = now;
    steps++;
    watch();

    if (statsMs > 0 && now - statsAt >= statsMs) {
      const seconds = (now - statsAt) / 1000;
      const ticks = ticksByWorld(engine);
      const worlds = [...ticks].map(([name, t]) => {
        const peers = netSession(engine._world(name)!)?.openPeers() ?? [];
        const connections = peers.length;
        // ADR 0333: how many send their unreliable messages over a WebRTC data channel.
        const datagram = peers.filter((p) => p.link.maxDatagramBytes !== undefined).length;
        return `World "${name}" ${round((t - (statsTicks.get(name) ?? t)) / seconds)} ticks/s, ${connections} connection${connections === 1 ? "" : "s"}${connections > 0 ? ` (${datagram} on WebRTC)` : ""}`;
      });
      log(`[server] ${round(steps / seconds)} steps/s; ${worlds.join("; ")}.`);
      statsAt = now;
      steps = 0;
      statsTicks = ticks;
    }

    next += intervalMs;
    const after = performance.now();
    if (after - next > intervalMs * 5) next = after + intervalMs; // far behind: start the schedule afresh
    timer = setTimeout(frame, Math.max(0, next - after));
  };
  timer = setTimeout(frame, intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Each server World's fixed-step count. */
function ticksByWorld(engine: Engine): Map<string, number> {
  const out = new Map<string, number>();
  for (const handle of engine.worlds()) if (handle.hasTag("server")) out.set(handle.name, engine._world(handle.name)!.time.fixedStepCount);
  return out;
}

/**
 * A function to call each frame that logs connections that opened or closed since the last call,
 * and Worlds created at runtime (from a template) once they listen (ADR 0067: `WorldHandle.listen`,
 * e.g. a lobby's match Worlds), and when they go.
 */
function connectionWatcher(engine: Engine, log: (line: string) => void, started: ReadonlySet<string>): () => void {
  const known = new Map<World, Map<NetPeer, number>>();
  const noted = new Map<World, string>();
  return () => {
    for (const [world, name] of noted) {
      if (engine._world(name) === world) continue;
      noted.delete(world);
      known.delete(world);
      log(`[server] World "${name}" (created at runtime) was destroyed.`);
    }
    for (const handle of engine.worlds()) {
      const world = engine._world(handle.name)!;
      if (!started.has(handle.name) && !noted.has(world)) {
        const addresses = handle.addresses();
        if (addresses.length > 0) {
          noted.set(world, handle.name);
          log(`[server] World "${handle.name}" was created at runtime and is listening on ${addresses.join(", ")}.`);
        }
      }
      const session = netSession(world);
      if (!session?.isServer) continue;
      let peers = known.get(world);
      if (!peers) known.set(world, (peers = new Map()));
      const open = session.openPeers();
      for (const peer of open) {
        if (peers.has(peer)) continue;
        peers.set(peer, peer.id);
        log(`[server] World "${world.name}": connection ${peer.id} opened from ${peer.link.remote} (${open.length} open).`);
      }
      for (const [peer, id] of peers) {
        if (open.includes(peer)) continue;
        peers.delete(peer);
        let reason = "closed";
        for (let i = session.closed.length - 1; i >= 0; i--) {
          if (session.closed[i].id === id) {
            reason = session.closed[i].reason || reason;
            break;
          }
        }
        log(`[server] World "${world.name}": connection ${id} closed: ${reason} (${open.length} open).`);
      }
    }
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
