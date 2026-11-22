import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex, textHash } from "./textHash";

describe("sha256Hex", () => {
  it("matches the FIPS 180-4 test vectors", () => {
    expect(sha256Hex(new TextEncoder().encode(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("matches Node's SHA-256 across block boundaries and non-ASCII text", () => {
    for (const text of ["x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "On est en retard.", "日本語のテキスト 🎮", "العربية"]) {
      expect(sha256Hex(new TextEncoder().encode(text))).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});

describe("textHash", () => {
  it("is the first 16 hex digits of the text's SHA-256", () => {
    expect(textHash("abc")).toBe("ba7816bf8f01cfea");
    expect(textHash("We're late.")).toMatch(/^[0-9a-f]{16}$/);
    expect(textHash("We're late.")).not.toBe(textHash("We are late."));
  });
});
