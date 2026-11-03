import { describe, expect, it } from "vitest";
import { formatSceneJSON, nodeTexts, originalLayout } from "./format";

const raw = import.meta.glob("../../../samples/flappy/{scenes,prefabs}/*.json", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const files = Object.entries(raw).map(([key, text]) => ({ name: key.split("/").pop()!, text: text.replace(/\r\n/g, "\n") }));

describe("scene file formatting (ADR 0026)", () => {
  it.each(files.map((f) => [f.name, f.text]))("re-saves %s unchanged", (_name, text) => {
    expect(formatSceneJSON(JSON.parse(text), originalLayout(text))).toBe(text);
  });

  it("rewrites only the node that changed", () => {
    const text = files.find((f) => f.name === "main.scene.json")!.text;
    const file = JSON.parse(text);
    file.nodes.find((n: { id: string }) => n.id === "ceiling").components[0].data.position = [0, 12, 0];
    const out = formatSceneJSON(file, originalLayout(text));
    const before = text.split("\n"), after = out.split("\n");
    expect(after.length).toBe(before.length);
    const changed = after.filter((line, i) => line !== before[i]);
    expect(changed).toEqual(['        { "type": "engine.Transform", "data": { "position": [0, 12, 0] } },']);
  });

  it("formats new content Prettier-style: inline when it fits, broken when it doesn't", () => {
    const out = formatSceneJSON({
      format: "myco.scene@1",
      nodes: [
        { id: "a", name: "A" },
        { id: "b", components: [{ type: "game.Long", data: { text: "x".repeat(120) } }] },
      ],
    });
    expect(out).toBe(
      [
        "{",
        '  "format": "myco.scene@1",',
        '  "nodes": [',
        '    { "id": "a", "name": "A" },',
        "    {",
        '      "id": "b",',
        '      "components": [',
        "        {",
        '          "type": "game.Long",',
        '          "data": {',
        `            "text": "${"x".repeat(120)}"`,
        "          }",
        "        }",
        "      ]",
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("finds each top-level node's source text", () => {
    const texts = nodeTexts('{ "nodes": [ { "id": "a", "s": "}{" }, {"id":"b"} ], "x": { "nodes": [{ "id": "c" }] } }');
    expect([...texts.keys()]).toEqual(["a", "b"]);
    expect(texts.get("a")).toBe('{ "id": "a", "s": "}{" }');
  });
});
