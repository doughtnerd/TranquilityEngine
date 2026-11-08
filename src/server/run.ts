/**
 * The dedicated server's core (T14, ADR 0033 §8): load a project, create an Engine with only its
 * server-tagged Worlds, have them listen over WebSocket, and step the Engine on a timer until
 * closed. `main.ts` is the command line around it; tests call `startServer` directly.
 */
import "./websocketServer"; // registers the Node "websocket" transport, which can listen
import { Assets, Engine, type Bootstrap, type BootstrapConfig, type BootstrapEngine, type LinkConfig, type WorldConfig, type WorldHandle } from "../engine";
import { BootstrapError, assertValidBootstrap } from "../engine/core/bootstrap";
import { DEFAULT_WORLD_TAGS } from "../engine/core/worlds";
import type { World } from "../engine/core/World";
import { listenWorld, netSession, setDefaultListenOptions, type NetPeer } from "../engine/net/session";
import { loadProjectCode, readProject, scriptExports, ServerError, type ServerProject } from "./project";
import { parseListenAddress } from "./websocketServer";
import { activateRuntimePlugins, enabledRuntimePlugins, RUNTIME_PLUGINS } from "../plugins/runtime";

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
  Assets.addSource(project.assets);
  let engine: Engine;
  try {
    // First-party runtime halves (ADR 0135), skipping drawing-only ones (`server: false`).
    activateRuntimePlugins(RUNTIME_PLUGINS, { server: true, enabled: enabledRuntimePlugins(project.settings.plugins?.disabled) }); // and the project's disabled ones (ADR 0133)
    // Third-party runtime halves after them (ADR 0139); `loadProjectCode` already left out disabled and `server: false` ones.
    if (thirdParty.length > 0) activateRuntimePlugins([...RUNTIME_PLUGINS, ...thirdParty], { server: true, enabled: [...enabledRuntimePlugins(project.settings.plugins?.disabled), ...thirdParty.map((p) => p.manifest.name)] });
    engine = await Engine.create({ headless: true, project: project.settings, bootstrap: plan.bootstrap });
  } catch (err) {
    Assets.removeSource(project.assets);
    if (err instanceof BootstrapError) throw new ServerError(`The project's bootstrap is invalid:\n${err.problems.map((p) => `  - ${p}`).join("\n")}`);
    if (err instanceof ServerError) throw err;
    throw new ServerError(`The project's server Worlds couldn't start: ${(err as Error).message}`);
  }
  // After the bootstrap ran: a code bootstrap's skipped Worlds are known only then.
  for (const name of plan.skipped) log(`[server] Skipping World "${name}": it isn't tagged "server".`);
  const shutDown = () => {
    engine.dispose();
    Assets.removeSource(project.assets);
  };

  const listeners: ServerListener[] = [];
  try {
    const servers = engine.worlds().filter((w) => w.hasTag("server"));
    if (servers.length === 0) throw new ServerError("The bootstrap created no Worlds tagged \"server\"; there's nothing to run.");
    for (const [i, handle] of servers.entries()) {
      const link = plan.links.find((l) => l.to === handle.name);
      const listen = listenOptions(handle.name, link, i === 0, options);
      if (!listen) {
        log(`[server] World "${handle.name}" isn't listening: no link connects to it and --port only applies to the first server World.`);
        continue;
      }
      if (link && link.transport !== "websocket") log(`[server] World "${handle.name}": its link uses "${link.transport}"; a dedicated server listens over "websocket".`);
      const url = await listenWorld(engine._world(handle.name)!, "websocket", listen.options).catch((err: Error) => {
        if (/EADDRINUSE|is already listened on/.test(err.message)) throw new ServerError(`Port ${listen.port} is already in use, so World "${handle.name}" can't listen there. Stop whatever is using it, or pick another port with --port.`);
        if (/EACCES/.test(err.message)) throw new ServerError(`World "${handle.name}" isn't allowed to listen on port ${listen.port} (ports below 1024 usually need privileges). Pick another with --port.`);
        throw new ServerError(err.message);
      });
      const port = Number(new URL(url).port || 80);
      listeners.push({ world: handle.name, url, port });
      log(`[server] World "${handle.name}" listening on ${url}${listen.host ? "" : " (all interfaces)"}.`);
    }
  } catch (err) {
    shutDown();
    throw err;
  }
  // ADR 0067: Worlds created at runtime (a lobby's matches) that listen without a port share the
  // first server World's port (`--port`, its real one if that was 0), by path.
  if (listeners.length > 0) setDefaultListenOptions("websocket", { port: listeners[0].port, ...(options.host ? { host: options.host } : {}) });

  const rates = engine.worlds().map((w) => 1 / engine._world(w.name)!.time.fixedDeltaTime);
  const tickRate = options.tickRate ?? Math.max(...rates);
  if (!(Number.isFinite(tickRate) && tickRate > 0)) {
    shutDown();
    throw new ServerError(`The tick rate must be a positive number (got ${tickRate}).`);
  }
  const spawned = spawnedListener(engine, plan.spawnLinks, options, log);
  const loop = runLoop(engine, tickRate, log, options.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS, new Set(engine.worlds().map((w) => w.name)), spawned);
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
        setDefaultListenOptions("websocket", null);
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
 * The project's bootstrap cut down to its server Worlds. A declarative one keeps the Worlds
 * tagged "server", the links between them, and every template (created later by name); links from
 * other Worlds to a server World say where it listens. A bootstrap with no server Worlds whose
 * templates include server-tagged ones (Unity's frontend pattern: a Host button creates the server
 * World at runtime) runs those templates, each as a World named as `Engine.createWorld` would name
 * it (its `name`, else its key). Links to server templates not created at start are kept for when
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
  const isServer = (w: Omit<WorldConfig, "name">) => (w.tags ?? DEFAULT_WORLD_TAGS).includes("server");
  let worlds = setting.worlds.filter(isServer);
  const skipped = setting.worlds.filter((w) => !isServer(w)).map((w) => w.name);
  if (worlds.length === 0) {
    const templates = Object.entries(setting.templates ?? {}).filter(([, t]) => isServer(t));
    // A lobby (ADR 0068) creates its match Worlds from their templates when rooms start: run only the lobby.
    const lobbies = templates.filter(([, t]) => t.lobby);
    worlds = (lobbies.length > 0 ? lobbies : templates).map(([key, t]) => ({ ...t, name: t.name ?? key }));
  }
  if (worlds.length === 0) {
    throw new ServerError(`The project's bootstrap has no Worlds or templates tagged "server" (it has ${skipped.map((n) => `"${n}"`).join(", ")}); there's nothing for a dedicated server to run.`);
  }
  const kept = new Set(worlds.map((w) => w.name));
  const links = setting.links ?? [];
  const serverTemplates = new Set(Object.entries(setting.templates ?? {}).filter(([, t]) => isServer(t)).map(([key, t]) => t.name ?? key));
  return {
    // Links between server Worlds (start-up or spawnable) apply in the server's Engine as they would anywhere.
    bootstrap: { worlds, links: links.filter((l) => (kept.has(l.from) || serverTemplates.has(l.from)) && (kept.has(l.to) || serverTemplates.has(l.to))), ...(setting.templates ? { templates: setting.templates } : {}) },
    links: links.filter((l) => !kept.has(l.from) && kept.has(l.to)),
    spawnLinks: links.filter((l) => !kept.has(l.from) && !serverTemplates.has(l.from) && !kept.has(l.to) && serverTemplates.has(l.to)),
    skipped,
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
        if (typeof config === "string" || (config.tags ?? DEFAULT_WORLD_TAGS).includes("server")) return engine.createWorld(config);
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
 * The options to listen with for a server World: its link's (minus the client-only `url`), with
 * the address built from the link's `address`, `port` or `url` port, overridden by `--host` (every
 * World) and `--port` (the first). Null if there's no address for it.
 */
function listenOptions(world: string, link: LinkConfig | undefined, first: boolean, cli: ServerOptions): { options: Record<string, unknown>; port: number; host?: string } | null {
  const { url: _url, port: _port, address: _address, ...rest } = link?.options ?? {};
  // Another transport's address (a loopback name) means nothing to a WebSocket server.
  const linked = link?.transport === "websocket" ? linkAddress(world, link) : {};
  const port = first && cli.port !== undefined ? cli.port : (linked.port ?? (first ? DEFAULT_PORT : undefined));
  if (port === undefined) return null;
  if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) throw new ServerError(`World "${world}": ${port} isn't a port (0 to 65535).`);
  const host = cli.host ?? linked.host;
  const path = linked.path ?? "/";
  // No host: every interface (ws binds "::", which takes IPv4 too). A path needs a URL, and so a host.
  const address = host ? `ws://${host.includes(":") ? `[${host}]` : host}:${port}${path}` : path === "/" ? String(port) : `ws://0.0.0.0:${port}${path}`;
  const options: Record<string, unknown> = { ...rest, address };
  if (cli.maxConnections !== undefined) options.maxConnections = cli.maxConnections;
  return { options, port, host };
}

/** Where a link says its server listens: `address`, else `port`, else the port and path of its `url`. */
function linkAddress(world: string, link: LinkConfig | undefined): { host?: string; port?: number; path?: string } {
  const o = link?.options ?? {};
  try {
    if (typeof o.address === "string" && o.address !== "") return parseListenAddress(o.address);
    if (typeof o.port === "number" || typeof o.port === "string") return parseListenAddress(o.port);
    if (typeof o.url === "string") {
      const { port, path } = parseListenAddress(o.url);
      return { port, path };
    }
  } catch (err) {
    throw new ServerError(`World "${world}": the link from "${link!.from}" has a bad address. ${(err as Error).message}`);
  }
  return {};
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
function runLoop(engine: Engine, rate: number, log: (line: string) => void, statsMs: number, started: ReadonlySet<string>, afterStep: () => void = () => {}): { stop(): void } {
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
    afterStep();
    watch();

    if (statsMs > 0 && now - statsAt >= statsMs) {
      const seconds = (now - statsAt) / 1000;
      const ticks = ticksByWorld(engine);
      const worlds = [...ticks].map(([name, t]) => {
        const connections = netSession(engine._world(name)!)?.openPeers().length ?? 0;
        return `World "${name}" ${round((t - (statsTicks.get(name) ?? t)) / seconds)} ticks/s, ${connections} connection${connections === 1 ? "" : "s"}`;
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

/**
 * A function to call each frame that has server Worlds created at runtime from a template listen
 * where a link to them from a skipped (client) World says (ADR 0062), unless they already listen
 * (game code called `listen` itself). Over `--host` like the start-up Worlds; a link with no
 * WebSocket address leaves the World to listen on the shared port by path if its code asks.
 */
function spawnedListener(engine: Engine, links: readonly LinkConfig[], cli: ServerOptions, log: (line: string) => void): () => void {
  if (links.length === 0) return () => {};
  const handled = new WeakSet<World>();
  return () => {
    for (const handle of engine.worlds()) {
      const world = engine._world(handle.name)!;
      if (handled.has(world) || !handle.hasTag("server")) continue;
      const link = links.find((l) => l.to === handle.name);
      if (!link) continue;
      handled.add(world);
      if (handle.addresses().length > 0) continue;
      if (link.transport !== "websocket") {
        log(`[server] World "${handle.name}" (created at runtime): its link from "${link.from}" uses "${link.transport}"; a dedicated server listens over "websocket", so it isn't listening.`);
        continue;
      }
      let listen: ReturnType<typeof listenOptions>;
      try {
        listen = listenOptions(handle.name, link, false, cli);
      } catch (err) {
        log(`[server] World "${handle.name}" (created at runtime) can't listen: ${(err as Error).message}`);
        continue;
      }
      if (!listen) {
        log(`[server] World "${handle.name}" (created at runtime): its link from "${link.from}" gives no port, so it isn't listening.`);
        continue;
      }
      listenWorld(world, "websocket", listen.options).catch((err: Error) => {
        const reason = /EADDRINUSE|is already listened on/.test(err.message) ? `port ${listen!.port} is already in use` : err.message;
        log(`[server] World "${handle.name}" (created at runtime) can't listen where its link from "${link.from}" says: ${reason}.`);
      });
    }
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
