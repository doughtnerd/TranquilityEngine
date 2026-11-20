import { describe, expect, it } from "vitest";
import { withMember } from "./jsonMember";

/** `project.json`'s text with its `bootstrap` set (undefined: removed), as the Worlds panel's section writes it. */
const withBootstrap = (text: string, setting: unknown) => withMember(text, "bootstrap", setting);
const CLIENT_SERVER = {
  worlds: [{ name: "Client", tags: ["client"] }, { name: "Server", tags: ["server"] }],
  links: [{ from: "Client", to: "Server", transport: "loopback" }],
};
const ONE_WORLD = { worlds: [{ name: "Default", tags: ["default"] }] };

describe("withMember: writing one top-level key of project.json", () => {
  const FILE = '{\n  "name": "flappy",\n  "physics": {\n    "gravity": [0, -32]\n  },\n  "autoload": ["a.prefab.json"]\n}\n';

  it("adds the section after the other keys, keeping their text", () => {
    const text = withBootstrap(FILE, CLIENT_SERVER);
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
    expect(JSON.parse(text).bootstrap).toEqual(CLIENT_SERVER);
  });

  it("replaces an existing section and removes it again", () => {
    const once = withBootstrap(FILE, ONE_WORLD);
    const twice = withBootstrap(once, CLIENT_SERVER);
    expect(JSON.parse(twice).bootstrap).toEqual(CLIENT_SERVER);
    expect(withBootstrap(twice, undefined)).toBe(FILE);
  });

  it("removes a section that isn't last, and keeps CRLF line endings", () => {
    const crlf = '{\r\n  "bootstrap": "scripts/B.ts",\r\n  "name": "x"\r\n}\r\n';
    expect(withBootstrap(crlf, undefined)).toBe('{\r\n  "name": "x"\r\n}\r\n');
    const added = withBootstrap('{\r\n  "name": "x"\r\n}\r\n', ONE_WORLD);
    expect(added).not.toMatch(/[^\r]\n/);
    expect(JSON.parse(added).bootstrap.worlds[0].name).toBe("Default");
  });

  it("writes into an empty object", () => {
    expect(JSON.parse(withBootstrap("{}\n", "scripts/B.ts"))).toEqual({ bootstrap: "scripts/B.ts" });
  });

  it("writes a file on one line, keeping it on one line", () => {
    const compact = '{"name":"x","bootstrap":"scripts/A.ts","physics":{"gravity":[0,-32]}}';
    const replaced = withBootstrap(compact, CLIENT_SERVER);
    expect(JSON.parse(replaced)).toEqual({ name: "x", bootstrap: CLIENT_SERVER, physics: { gravity: [0, -32] } });
    expect(replaced).not.toContain("\n");
    expect(withBootstrap(compact, undefined)).toBe('{"name":"x","physics":{"gravity":[0,-32]}}');
    const spaced = '{ "name": "x", "physics": { "gravity": [0, -32] } }\n';
    const added = withBootstrap(spaced, "scripts/B.ts");
    expect(added).toBe('{ "name": "x", "physics": { "gravity": [0, -32] }, "bootstrap": "scripts/B.ts" }\n');
    expect(withBootstrap(added, undefined)).toBe(spaced);
    expect(JSON.parse(withBootstrap('{"bootstrap":"a.ts","name":"x"}', undefined))).toEqual({ name: "x" });
  });

  it("writes a file whose first key shares the brace's line", () => {
    const text = withBootstrap('{ "name": "x",\n  "physics": {}\n}\n', "scripts/B.ts");
    expect(JSON.parse(text)).toEqual({ name: "x", physics: {}, bootstrap: "scripts/B.ts" });
  });
});
