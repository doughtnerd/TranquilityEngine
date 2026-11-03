import { describe, expect, it } from "vitest";
import { FrameMonitor, guessTier, tierForGuess, type DeviceInfo, type TierGuess } from "../render/qualityDetect";

// Automatic quality detection (ADR 0055): the GPU guess, mapping onto tiers, and the frame monitor.

describe("guessTier", () => {
  const cases: [string, DeviceInfo, TierGuess][] = [
    ["swiftshader", { gpu: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", cores: 16, memoryGB: 8 }, "lowest"],
    ["llvmpipe", { gpu: "llvmpipe (LLVM 15.0.7, 256 bits)" }, "lowest"],
    ["intel uhd", { gpu: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)", cores: 8, memoryGB: 8 }, "low"],
    ["intel uhd small memory", { gpu: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)", memoryGB: 2 }, "lowest"],
    ["mali", { gpu: "Mali-G78", cores: 8, memoryGB: 8 }, "low"],
    ["mali small memory", { gpu: "Mali-G78", memoryGB: 2 }, "lowest"],
    ["apple m2", { gpu: "Apple M2", cores: 8, memoryGB: 8 }, "low"],
    ["apple m3 max", { gpu: "Apple M3 Max", cores: 16, memoryGB: 8 }, "highest"],
    ["apple m3 max few cores", { gpu: "Apple M3 Max", cores: 4, memoryGB: 8 }, "default"],
    ["rtx strong", { gpu: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)", cores: 16, memoryGB: 8 }, "highest"],
    ["rtx modest", { gpu: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)", cores: 6, memoryGB: 8 }, "default"],
    ["rtx low memory", { gpu: "NVIDIA GeForce GTX 1050", cores: 16, memoryGB: 4 }, "default"],
    ["rtx memory unknown, many cores", { gpu: "NVIDIA GeForce RTX 4090", cores: 24 }, "highest"],
    ["rtx memory unknown, 8 cores", { gpu: "NVIDIA GeForce RTX 4090", cores: 8 }, "default"],
    ["radeon rx", { gpu: "AMD Radeon RX 6800 XT", cores: 8, memoryGB: 8 }, "highest"],
    ["unknown", { gpu: "Some Mystery GPU", cores: 8, memoryGB: 8 }, "default"],
    ["unknown, 2 cores", { gpu: "Some Mystery GPU", cores: 2 }, "lowest"],
    ["missing", {}, "default"],
    ["missing, 2 cores", { cores: 2 }, "lowest"],
  ];
  it.each(cases)("%s", (_name, info, guess) => {
    const r = guessTier(info);
    expect(r.guess).toBe(guess);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe("tierForGuess", () => {
  it("maps onto four tiers", () => {
    const tiers = ["low", "medium", "high", "ultra"];
    expect(tierForGuess("lowest", tiers, "high")).toBe("low");
    expect(tierForGuess("low", tiers, "high")).toBe("medium");
    expect(tierForGuess("default", tiers, "high")).toBe("high");
    expect(tierForGuess("highest", tiers, "high")).toBe("ultra");
  });
  it("maps onto two tiers", () => {
    const tiers = ["low", "high"];
    expect(tierForGuess("lowest", tiers, "high")).toBe("low");
    expect(tierForGuess("low", tiers, "high")).toBe("high");
    expect(tierForGuess("default", tiers, "high")).toBe("high");
    expect(tierForGuess("highest", tiers, "high")).toBe("high");
  });
  it("maps onto one tier", () => {
    for (const g of ["lowest", "low", "default", "highest"] as const) expect(tierForGuess(g, ["only"], "only")).toBe("only");
  });
});

/** Feed `seconds` of frames of length `dt`, returning the results seen. */
function feed(m: FrameMonitor, seconds: number, dt: number): string[] {
  const out: string[] = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) out.push(m.frame(dt));
  return out;
}

describe("FrameMonitor", () => {
  it("steady fast frames only watch, then finish", () => {
    const m = new FrameMonitor({ targetFps: 60 });
    const r = feed(m, 20, 1 / 60);
    expect(new Set(r)).toEqual(new Set(["watching", "done"]));
    expect(r[r.length - 1]).toBe("done");
    expect(m.frame(1 / 60)).toBe("done");
  });

  it("steady slow frames step down after the settle, and again only after another settle", () => {
    const m = new FrameMonitor({ targetFps: 60 });
    const dt = 1 / 20;
    // Nothing during the 3 s settle.
    expect(feed(m, 2.9, dt)).not.toContain("stepDown");
    let t = 2.9;
    let down = -1;
    for (let i = 0; i < 100 && down < 0; i++, t += dt) if (m.frame(dt) === "stepDown") down = t;
    expect(down).toBeGreaterThanOrEqual(3);
    expect(down).toBeLessThan(4.5);
    m.steppedDown();
    // Still slow, but the settle (3 s) comes first.
    expect(feed(m, 2.9, dt)).not.toContain("stepDown");
    expect(feed(m, 2, dt)).toContain("stepDown");
  });

  it("ignores hitches", () => {
    const m = new FrameMonitor({ targetFps: 60 });
    feed(m, 3.5, 1 / 60);
    for (let i = 0; i < 40; i++) expect(m.frame(0.5)).toBe("watching");
    expect(feed(m, 2, 1 / 60)).not.toContain("stepDown");
  });

  it("never steps down when at the lowest, and finishes", () => {
    const m = new FrameMonitor({ targetFps: 60 });
    m.setAtLowest(true);
    const r = feed(m, 20, 1 / 15);
    expect(r).not.toContain("stepDown");
    expect(r[r.length - 1]).toBe("done");
  });
});
