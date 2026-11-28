// ADR 0461: every reader of hex colour text goes through the one codec, so the short and alpha forms read the same
// wherever a colour is written. Each check goes through the caller's own interface, and each failed before the codec.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Color, Engine, GameObject, SceneManager, SpriteRenderer, evaluateGradient } from "../../myco";
import { linearColor } from "../render/shaderGraph/compile";
import { parseHexColor } from "../scene/particles";
import { hexToLinear } from "../sky/skyFormat";
import { srgbToLinear } from "../core/colorSpace";

const close = (actual: ArrayLike<number>, expected: readonly number[]) => expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 6));

afterEach(() => {
  vi.restoreAllMocks();
  Assets.clearSources();
});

describe("hex colours read the same everywhere (ADR 0461)", () => {
  it("Color.from reads #rgba and throws for text that isn't a colour instead of giving NaN", () => {
    const c = Color.from("#f008");
    close([c.r, c.g, c.b, c.a], [1, 0, 0, 0x88 / 255]); // was #ff0000 with alpha 1 (only 3/6/8 digits)
    expect(() => Color.from("red")).toThrow(/isn't a colour/); // was Color(NaN, NaN, NaN, 1)
  });

  it("particles read #abc as #aabbcc, not white", () => {
    close(parseHexColor("#abc"), [0xaa / 255, 0xbb / 255, 0xcc / 255, 1]);
    close(parseHexColor("#f008"), [1, 0, 0, 0x88 / 255]);
    expect(parseHexColor("nope")).toEqual([1, 1, 1, 1]); // its own fallback
  });

  it("a gradient reads #abc as #aabbcc, not white, and a key's alpha digits leave its colour alone", () => {
    close(evaluateGradient({ colors: [[0, "#abc"]], alphas: [] }, 0), [0xaa / 255, 0xbb / 255, 0xcc / 255, 1]);
    close(evaluateGradient({ colors: [[0, "#ff000080"]], alphas: [] }, 0), [1, 0, 0, 1]); // alpha keys hold opacity
    close(evaluateGradient({ colors: [[0, "#ff0000zz"]], alphas: [] }, 0), [1, 1, 1, 1]); // not a colour: white (was red)
  });

  it("the shader graph reads #rgba (it was white)", () => {
    close(linearColor("#f008"), [1, 0, 0, 0x88 / 255]);
    close(linearColor("#abc"), [srgbToLinear(0xaa / 255), srgbToLinear(0xbb / 255), srgbToLinear(0xcc / 255), 1]);
  });

  it("a sky reads #abc as #aabbcc, not black, and keeps black for bad text", () => {
    close(hexToLinear("#abc"), [srgbToLinear(0xaa / 255), srgbToLinear(0xbb / 255), srgbToLinear(0xcc / 255)]);
    expect(hexToLinear("blue")).toEqual([0, 0, 0]);
  });

  it("a scene's colour field that isn't a colour warns and keeps the default instead of loading NaN", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    Assets.addSource(
      Assets.fromObject({
        "s.json": {
          format: "myco.scene@5",
          nodes: [
            { id: "a", name: "A", components: [{ type: "engine.Transform" }, { type: "engine.SpriteRenderer", data: { color: "red" } }] },
            { id: "b", name: "B", components: [{ type: "engine.Transform" }, { type: "engine.SpriteRenderer", data: { color: "#0f08" } }] },
          ],
        },
      }),
    );
    const engine = await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    const color = (name: string) => GameObject.findObjectsOfType(SpriteRenderer).find((s) => s.gameObject.name === name)!.color;
    const a = color("A");
    expect([a.r, a.g, a.b, a.a]).toEqual([1, 1, 1, 1]);
    expect(warn.mock.calls.some(([m]) => String(m).includes('field "color" expects a colour'))).toBe(true);
    const b = color("B");
    close([b.r, b.g, b.b, b.a], [0, 1, 0, 0x88 / 255]);
    engine.dispose();
  });
});
