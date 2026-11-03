import { describe, expect, it } from "vitest";
import { Environment } from "../render/components";
import { environmentKind } from "../render/environmentMap";

describe("environment", () => {
  it("classifies environment image paths", () => {
    expect(environmentKind("sky/studio.hdr")).toBe("hdr");
    expect(environmentKind("sky/STUDIO.EXR")).toBe("exr");
    expect(environmentKind("sky/day.png")).toBe("ldr");
    expect(environmentKind("sky/day.jpeg")).toBe("ldr");
    expect(environmentKind("sky/day.gif")).toBeNull();
    expect(environmentKind("sky/model.fbx")).toBeNull();
  });

  it("has the documented defaults", () => {
    const e = new Environment();
    expect(e.map).toBe("");
    expect(e.intensity).toBe(1);
    expect(e.skybox).toBe(true);
    expect(e.skyboxIntensity).toBe(1);
    expect(e.skyboxBlur).toBe(0);
    expect(e.rotation).toBe(0);
  });
});
