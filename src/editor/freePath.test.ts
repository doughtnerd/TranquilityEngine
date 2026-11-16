import { describe, expect, it } from "vitest";
import { numberedName } from "./freePath";

describe("numberedName", () => {
  it("numbers before the extension", () => {
    expect(numberedName("a.png", 0)).toBe("a.png");
    expect(numberedName("a.png", 1)).toBe("a (1).png");
    expect(numberedName("x.scene.json", 2)).toBe("x (2).scene.json");
  });
});
