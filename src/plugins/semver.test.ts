import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, satisfies } from "./semver";

const cmp = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));

describe("semver pre-release precedence (semver.org item 11)", () => {
  it("orders the spec's example chain", () => {
    const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i + 1 < chain.length; i++) {
      expect(cmp(chain[i]!, chain[i + 1]!)).toBe(-1);
      expect(cmp(chain[i + 1]!, chain[i]!)).toBe(1);
    }
  });

  it("compares numeric identifiers as numbers", () => {
    expect(cmp("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(cmp("1.0.0-alpha.10", "1.0.0-alpha.10")).toBe(0);
    expect(satisfies("1.0.0-alpha.10", ">=1.0.0-alpha.2")).toBe(true);
  });
});
