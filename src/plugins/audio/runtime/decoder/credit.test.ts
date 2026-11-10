import { describe, expect, it } from "vitest";
import { CreditAccumulator, CreditWindow, STREAM_CHUNK_FRAMES, STREAM_CREDIT_FRAMES, STREAM_WINDOW_FRAMES } from "./credit";

describe("stream credits (B3)", () => {
  it("the window holds eight chunks, and a credit frees room for one more", () => {
    const w = new CreditWindow();
    let sent = 0;
    while (w.canSend()) {
      w.sent(STREAM_CHUNK_FRAMES);
      sent++;
    }
    expect(sent).toBe(STREAM_WINDOW_FRAMES / STREAM_CHUNK_FRAMES);
    w.credit(STREAM_CREDIT_FRAMES - 1);
    expect(w.canSend()).toBe(false);
    w.credit(1);
    expect(w.canSend()).toBe(true);
    w.credit(1e9);
    expect(w.outstanding).toBe(0);
    w.sent(100);
    w.reset();
    expect(w.outstanding).toBe(0);
  });

  it("the shell credits every 4,096 consumed frames", () => {
    const a = new CreditAccumulator();
    expect(a.add(4000)).toBe(false);
    expect(a.add(0)).toBe(false);
    expect(a.add(200)).toBe(true);
    expect(a.take()).toBe(4200);
    expect(a.pending).toBe(0);
  });
});
