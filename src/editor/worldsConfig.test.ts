import { describe, expect, it } from "vitest";
import type { SystemCatalogEntry } from "../engine/core/systems";
import {
  EditHistory,
  addLink,
  addTemplate,
  addWorld,
  defaultModel,
  groupProblems,
  extraOptionKeys,
  isSpawnableName,
  linkOptionsFor,
  optionText,
  parseOptionText,
  setLinkOption,
  linkableNames,
  lobbyLinks,
  mentions,
  modelProblems,
  modelToConfig,
  readBootstrap,
  remove,
  rename,
  selectSystem,
  setSystem,
  systemStatus,
  transportChoices,
  updateConfig,
  withBootstrap,
  type WorldsModel,
  withReplicationSetting,
} from "./worldsConfig";

const CATALOG: SystemCatalogEntry[] = [
  { name: "engine.UpdateScripts", phase: "update", worlds: ["*"], builtin: true },
  { name: "game.Scroll", phase: "update", worlds: ["default", "local"], builtin: false },
  { name: "net.Replicate", phase: "lateUpdate", worlds: ["server"], builtin: false },
];
const [scripts, scroll, replicate] = CATALOG;

const clientServer = (): WorldsModel => ({
  worlds: [{ name: "Client", tags: ["client"] }, { name: "Server", tags: ["server"] }],
  links: [{ from: "Client", to: "Server", transport: "loopback" }],
  templates: [],
});

describe("reading and writing the bootstrap section", () => {
  it("shows the default bootstrap's World for a project without one, not yet written out", () => {
    expect(readBootstrap(undefined)).toEqual({ kind: "graph", explicit: false, model: defaultModel() });
    expect(defaultModel().worlds).toEqual([{ name: "Default", tags: ["default", "local"] }]);
  });

  it("round-trips a config, templates included, keeping keys it doesn't edit", () => {
    const config = {
      worlds: [{ name: "Client", tags: ["client"] }, { name: "Server", tags: ["server"], tickRate: 30 }],
      links: [{ from: "Client", to: "Server", transport: "websocket", options: { url: "ws://x" } }],
      templates: { Match: { tags: ["server"], scenes: ["scenes/match.scene.json"] } },
    };
    const view = readBootstrap(config);
    expect(view.kind).toBe("graph");
    if (view.kind !== "graph") return;
    expect(view.explicit).toBe(true);
    expect(view.model.templates).toEqual([{ key: "Match", config: config.templates.Match }]);
    expect(modelToConfig(view.model)).toEqual(config);
  });

  it("leaves out empty links and templates", () => {
    expect(modelToConfig(defaultModel())).toEqual({ worlds: [{ name: "Default", tags: ["default", "local"] }] });
  });

  it("reports code bootstraps and sections too malformed to edit", () => {
    expect(readBootstrap("scripts/Bootstrap.ts")).toEqual({ kind: "code", path: "scripts/Bootstrap.ts" });
    const broken = readBootstrap({ worlds: "Default" });
    expect(broken.kind).toBe("broken");
    expect(broken.kind === "broken" && broken.problems[0]).toMatch(/bootstrap\.worlds must be a list/);
  });
});

describe("editing", () => {
  it("adds Worlds and templates with unique names", () => {
    let m = addWorld(addWorld(defaultModel()));
    expect(m.worlds.map((w) => w.name)).toEqual(["Default", "World", "World 2"]);
    expect(m.worlds[1].tags).toEqual([]);
    m = addTemplate(addTemplate(m, "Match"), "Match");
    expect(m.templates.map((t) => t.key)).toEqual(["Match", "Match 2"]);
  });

  it("renaming a World keeps its links pointing at it", () => {
    const m = rename(clientServer(), { kind: "world", index: 1 }, "Host");
    expect(m.worlds[1].name).toBe("Host");
    expect(m.links).toEqual([{ from: "Client", to: "Host", transport: "loopback" }]);
    expect(modelProblems(m, CATALOG)).toEqual([]);
  });

  it("renaming onto another World's name is a problem, and links stay with the other World", () => {
    const m = rename(addWorld(clientServer(), "Spare"), { kind: "world", index: 2 }, "Server");
    expect(m.links[0].to).toBe("Server");
    const problems = groupProblems(modelProblems(m, CATALOG));
    expect(problems.worlds.get(2)).toEqual(['another World is already named "Server"; World names must be unique.']);
  });

  it("removing a World removes its links", () => {
    const m = remove(clientServer(), { kind: "world", index: 1 });
    expect(m.worlds.map((w) => w.name)).toEqual(["Client"]);
    expect(m.links).toEqual([]);
  });

  it("updates settings in project.json's key order, and undefined goes back to the default", () => {
    let m = updateConfig(clientServer(), { kind: "world", index: 0 }, { input: true, tickRate: 30 });
    expect(Object.keys(m.worlds[0])).toEqual(["name", "tags", "tickRate", "input"]);
    m = updateConfig(m, { kind: "world", index: 0 }, { tickRate: undefined });
    expect(m.worlds[0]).toEqual({ name: "Client", tags: ["client"], input: true });
  });

  it("offers known transports before they're registered, without repeats", () => {
    expect(transportChoices(["loopback"], ["custom"])).toEqual(["loopback", "websocket", "custom"]);
  });
});

describe("system checklist", () => {
  it("says why each system runs or doesn't", () => {
    const server = { tags: ["server"] };
    expect(systemStatus(server, scripts)).toEqual({ runs: true, reason: "every World (engine)" });
    expect(systemStatus(server, replicate)).toEqual({ runs: true, reason: "added by tag `server`" });
    expect(systemStatus(server, scroll)).toEqual({ runs: false, reason: "not for this World's tags" });
    expect(systemStatus({}, scroll)).toEqual({ runs: true, reason: "added by tag `default`" }); // default tags
    expect(systemStatus({ tags: ["server"], systems: { include: ["game.Scroll"] } }, scroll)).toEqual({ runs: true, reason: "included here" });
    expect(systemStatus({ tags: ["server"], systems: { exclude: ["engine.UpdateScripts"] } }, scripts)).toEqual({ runs: false, reason: "excluded here" });
  });

  it("toggling writes include and exclude minimally", () => {
    const server = { tags: ["server"] };
    expect(selectSystem(server, scroll, true)).toEqual({ include: ["game.Scroll"] });
    expect(selectSystem(server, replicate, false)).toEqual({ exclude: ["net.Replicate"] });
    expect(selectSystem(server, replicate, true)).toBeUndefined(); // the tags already run it
    // Turning back to what the tags say removes the entry, and the empty selection with it.
    expect(selectSystem({ tags: ["server"], systems: { include: ["game.Scroll"] } }, scroll, false)).toBeUndefined();
    expect(selectSystem({ tags: ["server"], systems: { include: ["game.Scroll"], exclude: ["net.Replicate"] } }, replicate, true)).toEqual({ include: ["game.Scroll"] });
  });

  it("setSystem edits the World's config", () => {
    const m = setSystem(clientServer(), { kind: "world", index: 1 }, scripts, false);
    expect(m.worlds[1]).toEqual({ name: "Server", tags: ["server"], systems: { exclude: ["engine.UpdateScripts"] } });
    const back = setSystem(m, { kind: "world", index: 1 }, scripts, true);
    expect(back.worlds[1]).toEqual({ name: "Server", tags: ["server"] });
  });
});

describe("validation", () => {
  it("sorts validateBootstrap's problems by World, template and link, without their location prefix", () => {
    let m = updateConfig(clientServer(), { kind: "world", index: 1 }, { tickRate: -1, systems: { include: ["nope"] } });
    m = addLink(m, { from: "Client", to: "Nowhere", transport: "loopback" });
    m = addTemplate(m, "Match");
    m = updateConfig(m, { kind: "template", index: 0 }, { timeScale: -2 });
    const g = groupProblems(modelProblems(m, CATALOG));
    expect(g.worlds.get(1)).toEqual([
      "tickRate must be a positive number (got -1).",
      'systems.include names an unknown system: "nope". Known systems: engine.UpdateScripts, game.Scroll, net.Replicate.',
    ]);
    expect(g.links.get(1)).toEqual(['to names the World "Nowhere", which neither bootstrap.worlds nor bootstrap.templates lists.']);
    expect(g.templates.get("Match")).toEqual(["timeScale must be 0 (paused) or more (got -2)."]);
    expect(g.general).toEqual([]);
  });

  it("reports duplicate template names, which a record would hide", () => {
    const m = rename(addTemplate(addTemplate(defaultModel(), "A"), "B"), { kind: "template", index: 1 }, "A");
    expect(groupProblems(modelProblems(m, CATALOG)).templates.get("A")).toEqual(['another template is already named "A"; template names must be unique.']);
  });

  it("keeps problems about the whole section general", () => {
    const g = groupProblems(modelProblems({ worlds: [], links: [], templates: [] }, CATALOG));
    expect(g.general).toEqual(["bootstrap.worlds must list at least one World."]);
  });
});

describe("panel undo history", () => {
  it("undoes and redoes, and a new edit clears redo", () => {
    const h = new EditHistory(0);
    h.push("one", 1);
    h.push("two", 2);
    expect(h.undoLabel).toBe("two");
    expect(h.undo()).toBe(1);
    expect(h.redoLabel).toBe("two");
    h.push("three", 3);
    expect(h.redo()).toBeNull();
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
    expect(h.undo()).toBeNull();
  });
});

describe("writing project.json", () => {
  const FILE = '{\n  "name": "flappy",\n  "physics": {\n    "gravity": [0, -32]\n  },\n  "autoload": ["a.prefab.json"]\n}\n';

  it("adds the section after the other keys, keeping their text", () => {
    const text = withBootstrap(FILE, modelToConfig(clientServer()));
    expect(text.startsWith(FILE.slice(0, FILE.lastIndexOf("\n}")))).toBe(true);
    expect(text).toContain(
      [
        '  "bootstrap": {',
        '    "worlds": [',
        "      {",
        '        "name": "Client",',
        '        "tags": ["client"]',
        "      },",
      ].join("\n"),
    );
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text).bootstrap).toEqual(modelToConfig(clientServer()));
  });

  it("replaces an existing section and removes it again", () => {
    const once = withBootstrap(FILE, modelToConfig(defaultModel()));
    const twice = withBootstrap(once, modelToConfig(clientServer()));
    expect(JSON.parse(twice).bootstrap).toEqual(modelToConfig(clientServer()));
    expect(withBootstrap(twice, undefined)).toBe(FILE);
  });

  it("removes a section that isn't last, and keeps CRLF line endings", () => {
    const crlf = '{\r\n  "bootstrap": "scripts/B.ts",\r\n  "name": "x"\r\n}\r\n';
    expect(withBootstrap(crlf, undefined)).toBe('{\r\n  "name": "x"\r\n}\r\n');
    const added = withBootstrap('{\r\n  "name": "x"\r\n}\r\n', modelToConfig(defaultModel()));
    expect(added).not.toMatch(/[^\r]\n/);
    expect(JSON.parse(added).bootstrap.worlds[0].name).toBe("Default");
  });

  it("writes into an empty object", () => {
    expect(JSON.parse(withBootstrap("{}\n", "scripts/B.ts"))).toEqual({ bootstrap: "scripts/B.ts" });
  });
});

describe("Spawnable Worlds (ADR 0062)", () => {
  /** Arena's shape: a start-up client linked to a Spawnable server. */
  const arena = (): WorldsModel => ({
    worlds: [{ name: "Client", tags: ["client"] }],
    links: [{ from: "Client", to: "Server", transport: "loopback" }],
    templates: [{ key: "Server", config: { tags: ["server"] } }, { key: "Bot", config: { name: "Robot", tags: ["client"] } }],
  });

  it("offers start-up and Spawnable World names to links, and validates links to them", () => {
    expect(linkableNames(arena())).toEqual(["Client", "Server", "Robot"]);
    expect(isSpawnableName(arena(), "Server")).toBe(true);
    expect(isSpawnableName(arena(), "Client")).toBe(false);
    expect(modelProblems(arena(), CATALOG)).toEqual([]);
  });

  it("renaming a Spawnable World moves its links; one with its own World name keeps them", () => {
    const m = rename(arena(), { kind: "template", index: 0 }, "Host");
    expect(m.links).toEqual([{ from: "Client", to: "Host", transport: "loopback" }]);
    const withBotLink = addLink(arena(), { from: "Robot", to: "Server", transport: "loopback" });
    expect(rename(withBotLink, { kind: "template", index: 1 }, "Droid").links).toEqual(withBotLink.links);
  });

  it("removing a Spawnable World removes its links", () => {
    expect(remove(arena(), { kind: "template", index: 0 }).links).toEqual([]);
  });

  it("finds the scripts that mention a World in quotes", () => {
    const scripts = [
      { path: "scripts/data.ts", text: 'export const SERVER_WORLD = "Server";' },
      { path: "scripts/menu.ts", text: "Engine.createWorld(SERVER_WORLD);" },
      { path: "scripts/other.ts", text: "const servers = 'Servers';" },
    ];
    expect(mentions(scripts, "Server")).toEqual(["scripts/data.ts"]);
    expect(mentions(scripts, "")).toEqual([]);
    expect(mentions(scripts, ["Nope", "Server"])).toEqual(["scripts/data.ts"]); // a template's key or its World name
  });
});

describe("lobby links (ADR 0068)", () => {
  // King of Pirates' bootstrap: a menu World, and Lobby, Match and MatchClient templates; no declared links.
  const pirates = {
    worlds: [{ name: "Menu", scenes: ["scenes/menu.scene.json"] }],
    templates: {
      Lobby: { tags: ["server", "lobby"], renders: false, input: false, lobby: { matchTemplate: "Match", clientTemplate: "MatchClient" } },
      Match: { tags: ["server", "match"], renders: false, input: false },
      MatchClient: { tags: ["client", "match-client"] },
    },
  };

  it("shows the menu joining the lobby, the lobby creating matches and match clients joining them", () => {
    const view = readBootstrap(pirates);
    if (view.kind !== "graph") throw new Error("expected a graph");
    expect(lobbyLinks(view.model)).toEqual([
      { from: "Menu", to: "Lobby", label: "joins lobby" },
      { from: "Lobby", to: "Match", label: "creates matches" },
      { from: "MatchClient", to: "Match", label: "joins match" },
    ]);
  });

  it("leaves out pairs a declared link covers, missing templates, and projects without a lobby", () => {
    const view = readBootstrap({ ...pirates, links: [{ from: "Menu", to: "Lobby", transport: "loopback" }], templates: { ...pirates.templates, Lobby: { ...pirates.templates.Lobby, lobby: { matchTemplate: "Nope" } } } });
    if (view.kind !== "graph") throw new Error("expected a graph");
    expect(lobbyLinks(view.model)).toEqual([]);
    const arena = readBootstrap({ worlds: [{ name: "Client", tags: ["client"] }], templates: { Server: { tags: ["server"] } }, links: [{ from: "Client", to: "Server", transport: "loopback" }] });
    if (arena.kind !== "graph") throw new Error("expected a graph");
    expect(lobbyLinks(arena.model)).toEqual([]);
  });
});


describe("link options", () => {
  const base = () => clientServer();

  it("setLinkOption adds, changes and removes, dropping options when the last goes", () => {
    let m = setLinkOption(base(), 0, "latencyMs", 80);
    expect(m.links[0]).toEqual({ from: "Client", to: "Server", transport: "loopback", options: { latencyMs: 80 } });
    m = setLinkOption(m, 0, "loss", 0.1);
    m = setLinkOption(m, 0, "latencyMs", 90);
    expect(m.links[0].options).toEqual({ latencyMs: 90, loss: 0.1 });
    m = setLinkOption(m, 0, "latencyMs", undefined);
    expect(m.links[0].options).toEqual({ loss: 0.1 });
    m = setLinkOption(m, 0, "loss", "");
    expect(m.links[0]).toEqual({ from: "Client", to: "Server", transport: "loopback" });
    expect("options" in m.links[0]).toBe(false);
  });

  it("keeps unknown keys, other links and the original model", () => {
    const start = base();
    const two = addLink(start, { from: "Client", to: "Server", transport: "websocket", options: { custom: [1, 2] } });
    const m = setLinkOption(two, 1, "url", "ws://x");
    expect(m.links[1].options).toEqual({ custom: [1, 2], url: "ws://x" });
    expect(m.links[0]).toBe(two.links[0]);
    expect(setLinkOption(m, 1, "url", undefined).links[1].options).toEqual({ custom: [1, 2] });
    expect(two.links[1].options).toEqual({ custom: [1, 2] });
    expect(setLinkOption(start, 5, "x", 1)).toBe(start);
  });

  it("offers the options of the link's transport and lists the others as extra", () => {
    expect(linkOptionsFor("loopback").map((o) => o.key)).toContain("latencyMs");
    expect(linkOptionsFor("loopback").map((o) => o.key)).not.toContain("port");
    expect(linkOptionsFor("websocket").map((o) => o.key)).toContain("port");
    expect(linkOptionsFor("websocket").map((o) => o.key)).not.toContain("loss");
    expect(extraOptionKeys({ from: "a", to: "b", transport: "loopback", options: { port: 1, loss: 0.5, foo: 1 } })).toEqual(["port", "foo"]);
  });

  it("parses unknown values as JSON when possible", () => {
    expect(parseOptionText("5")).toBe(5);
    expect(parseOptionText("true")).toBe(true);
    expect(parseOptionText("hello")).toBe("hello");
    expect(parseOptionText("  ")).toBeUndefined();
    expect(optionText("hello")).toBe("hello");
    expect(optionText([1])).toBe("[1]");
  });

  it("reports bad values against their link", () => {
    let m = base();
    for (const [k, v] of [["latencyMs", -1], ["loss", 2], ["interpolationMs", "fast"], ["maxConnections", 1.5], ["address", 4]] as const) m = setLinkOption(m, 0, k, v);
    const g = groupProblems(modelProblems(m, CATALOG));
    expect(g.links.get(0)).toHaveLength(5);
    expect(g.links.get(0)!.some((p) => p.includes("options.latencyMs"))).toBe(true);
    const ws = setLinkOption({ ...clientServer(), links: [{ from: "Client", to: "Server", transport: "websocket" }] }, 0, "port", 70000);
    expect(groupProblems(modelProblems(ws, CATALOG)).links.get(0)![0]).toContain("at most 65535");
    const ok = setLinkOption(setLinkOption(base(), 0, "latencyMs", 50), 0, "loss", 0.2);
    expect(groupProblems(modelProblems(ok, CATALOG)).links.size).toBe(0);
  });
});

describe("replication settings (ADR 0101)", () => {
  it("sets and removes one setting, dropping replication when none is left", () => {
    const one = withReplicationSetting(undefined, "sendRate", 20);
    expect(one).toEqual({ sendRate: 20 });
    const both = withReplicationSetting(one, "maxSnapshotBytes", 1200);
    expect(both).toEqual({ sendRate: 20, maxSnapshotBytes: 1200 });
    expect(withReplicationSetting(both, "sendRate", undefined)).toEqual({ maxSnapshotBytes: 1200 });
    expect(withReplicationSetting({ sendRate: 20 }, "sendRate", undefined)).toBeUndefined();
  });
});
