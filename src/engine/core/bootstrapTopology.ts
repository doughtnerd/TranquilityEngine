/**
 * Bootstrap topology (ADR 0256): which World of a declarative bootstrap plays which network role,
 * classified once so the dedicated server, play mode and the editor's Worlds panel agree.
 *
 * - **Servers** are Worlds tagged `server` (a World's tags default to `DEFAULT_WORLD_TAGS`).
 * - **Spawnable server Worlds** are `server`-tagged templates, named as `Engine.createWorld` names
 *   them (the template's `name`, else its key). Those with `lobby` are **lobbies** (ADR 0068).
 * - **The Host template** (Unity's frontend pattern: a Host button creates the server World) is the
 *   first `server`-tagged template that isn't a lobby, when no start-up World is a server and no
 *   template is a lobby. Play mode's Host pattern uses it when no link joins two start-up Worlds
 *   (`startUpLinked`; with one, play copies the linked clients instead). Other server templates stay
 *   Spawnable: game code creates them by name, and links to them apply then (ADR 0062).
 * - **The Worlds a dedicated server starts:** the start-up servers, else every lobby, else the Host template.
 * - **The lobby** (ADR 0281): the first World the dedicated server starts that has a `lobby` config.
 *   `Lobby.connect("local")` runs the same one, so a page and the server agree. A `lobby` config on a
 *   World or template that isn't tagged `server`, or on a server template the server doesn't start
 *   (because start-up servers exist), is a problem (`lobbyProblems`, which `validateBootstrap` reports).
 * - **Listen links:** the first link from a World the server doesn't start into one it does says
 *   where that one listens; links into a Spawnable server World it doesn't start say where it
 *   listens once created.
 * - **Linked clients** (play mode's links layout): start-up Worlds that connect to another start-up
 *   World over a link and aren't connected to themselves; play copies the first `client`-tagged one
 *   (else the first).
 */
import { DEFAULT_WORLD_TAGS, type BootstrapConfig, type BootstrapSetting, type LinkConfig, type WorldConfig } from "./worlds";

/** A template as a Spawnable World: its key and its config with the name `createWorld` gives it. */
export interface SpawnableWorld {
  readonly key: string;
  readonly world: WorldConfig;
  readonly lobby: boolean;
}

export interface BootstrapTopology {
  /** Start-up Worlds tagged `server`. */
  readonly servers: readonly WorldConfig[];
  /** `server`-tagged templates, in declaration order. */
  readonly serverTemplates: readonly SpawnableWorld[];
  /** The server templates that are lobbies (ADR 0068). */
  readonly lobbies: readonly SpawnableWorld[];
  /** The Host template (see the top of this file), or null. */
  readonly hostTemplate: SpawnableWorld | null;
  /** True if a link joins two start-up Worlds (play mode then copies the linked clients, not the Host pattern). */
  readonly startUpLinked: boolean;
  /** The start-up client World the Host pattern copies (the first `client`-tagged World, else the first); null without a Host template. */
  readonly hostClient: WorldConfig | null;
  /** The Worlds a dedicated server starts, named as created. */
  readonly serverStart: readonly WorldConfig[];
  /** The lobby the dedicated server runs, and `Lobby.connect("local")` with it: the first World in `serverStart` with a `lobby` config; null if none. */
  readonly serverLobby: WorldConfig | null;
  /** `lobby` configs no dedicated server would run, as sentences located as `validateBootstrap` locates its problems. */
  readonly lobbyProblems: readonly string[];
  /** Start-up Worlds a dedicated server leaves out. */
  readonly skipped: readonly string[];
  /** Links among Worlds the server starts or can spawn: they apply in its Engine. */
  readonly serverLinks: readonly LinkConfig[];
  /** Links from left-out Worlds into Worlds the server starts: where those listen. */
  readonly listenLinks: readonly LinkConfig[];
  /** Links from left-out Worlds into server templates the server doesn't start (ADR 0062): where they listen once created. */
  readonly spawnLinks: readonly LinkConfig[];
  /** Start-up Worlds that connect to another start-up World over a link and aren't connected to. */
  readonly linkedClients: readonly WorldConfig[];
  /** The linked client play mode copies: the first `client`-tagged one, else the first; null if none. */
  readonly copiedClient: WorldConfig | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasTag = (w: { tags?: readonly string[] }, tag: string) => (w.tags ?? DEFAULT_WORLD_TAGS).includes(tag);

const UNTAGGED_LOBBY = 'a World with a "lobby" config must be tagged "server": only server Worlds run lobbies, on the dedicated server and in Lobby.connect("local") (ADR 0256, 0281).';

/** True if a World or template config is tagged `server`. */
export const isServerConfig = (w: { tags?: readonly string[] }): boolean => hasTag(w, "server");

/** Classify a declarative bootstrap; null for none, a code bootstrap (a script path) or a value that isn't a bootstrap config. */
export function bootstrapTopology(setting: BootstrapSetting | undefined): BootstrapTopology | null {
  if (!isRecord(setting) || !Array.isArray(setting.worlds)) return null;
  const config = setting as BootstrapConfig;
  const links = Array.isArray(config.links) ? config.links : [];
  const startUp = new Set(config.worlds.map((w) => w.name));

  const servers = config.worlds.filter(isServerConfig);
  const serverTemplates: SpawnableWorld[] = Object.entries(isRecord(config.templates) ? config.templates : {})
    .filter(([, t]) => isRecord(t) && isServerConfig(t))
    .map(([key, t]) => ({ key, world: { ...t, name: t.name ?? key }, lobby: !!t.lobby }));
  const lobbies = serverTemplates.filter((t) => t.lobby);
  const startUpLinked = links.some((l) => startUp.has(l.from) && startUp.has(l.to));
  const hostTemplate = servers.length === 0 && lobbies.length === 0 ? (serverTemplates.find((t) => !t.lobby) ?? null) : null;
  const hostClient = hostTemplate ? (config.worlds.find((w) => hasTag(w, "client")) ?? config.worlds[0] ?? null) : null;

  const serverStart = servers.length > 0 ? servers : (lobbies.length > 0 ? lobbies : hostTemplate ? [hostTemplate] : []).map((t) => t.world);
  const kept = new Set(serverStart.map((w) => w.name));
  const spawnable = new Set(serverTemplates.map((t) => t.world.name));
  const inServer = (name: string) => kept.has(name) || spawnable.has(name);

  const lobbyProblems: string[] = [];
  config.worlds.forEach((w, i) => {
    if (w.lobby && !isServerConfig(w)) lobbyProblems.push(`bootstrap.worlds[${i}] ("${w.name}"): ${UNTAGGED_LOBBY}`);
  });
  for (const [key, t] of Object.entries(isRecord(config.templates) ? config.templates : {})) {
    if (!isRecord(t) || !t.lobby) continue;
    if (!isServerConfig(t)) lobbyProblems.push(`bootstrap.templates["${key}"]: ${UNTAGGED_LOBBY}`);
    // A start-up World named as the template is that lobby already (the dedicated server's own bootstrap starts it so).
    else if (servers.length > 0 && !startUp.has(typeof t.name === "string" ? t.name : key)) {
      lobbyProblems.push(
        `bootstrap.templates["${key}"]: a dedicated server never starts this lobby, because it starts the start-up server Worlds (${servers.map((w) => `"${w.name}"`).join(", ")}) when there are any. Put the lobby config on one of them, or make them templates.`,
      );
    }
  }

  const listened = new Set(links.map((l) => l.to));
  const replaced = new Set(links.filter((l) => startUp.has(l.from) && startUp.has(l.to) && !listened.has(l.from)).map((l) => l.from));
  const linkedClients = config.worlds.filter((w) => replaced.has(w.name));

  return {
    servers,
    serverTemplates,
    lobbies,
    hostTemplate,
    hostClient,
    startUpLinked,
    serverStart,
    serverLobby: serverStart.find((w) => w.lobby) ?? null,
    lobbyProblems,
    skipped: config.worlds.filter((w) => !isServerConfig(w)).map((w) => w.name),
    serverLinks: links.filter((l) => inServer(l.from) && inServer(l.to)),
    listenLinks: links.filter((l) => !kept.has(l.from) && kept.has(l.to)),
    spawnLinks: links.filter((l) => !inServer(l.from) && !kept.has(l.to) && spawnable.has(l.to)),
    linkedClients,
    copiedClient: linkedClients.find((w) => hasTag(w, "client")) ?? linkedClients[0] ?? null,
  };
}
