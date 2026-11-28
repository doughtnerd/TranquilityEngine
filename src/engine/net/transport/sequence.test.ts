// ADR 0471: unreliable sequence numbers, through the module every transport numbers its unreliable messages with.
// Wrap-around is checked here: reaching it through a transport would take 2³² sends.
import { describe, expect, it } from "vitest";
import { readSeq, SEQUENCE_BYTES, UnreliableSequence, withSeq, writeSeq } from "./sequence";

/** A sequence whose next number to send is `n` (by taking the ones before; only the low numbers are cheap). */
function sendingFrom(n: number): UnreliableSequence {
  const s = new UnreliableSequence();
  for (let i = 0; i < n; i++) s.next();
  return s;
}

describe("unreliable sequence numbers (ADR 0471)", () => {
  it("numbers sends from 0, and peeks without taking", () => {
    const s = new UnreliableSequence();
    expect(s.peek()).toBe(0);
    expect(s.peek()).toBe(0);
    expect([s.next(), s.next(), s.peek(), s.next()]).toEqual([0, 1, 2, 2]);
    expect(sendingFrom(3).next()).toBe(3);
  });

  it("delivers the first number whatever it is, then only newer ones", () => {
    const r = new UnreliableSequence();
    expect(r.accept(7)).toBe(true);
    expect(r.accept(7)).toBe(false);
    expect(r.accept(3)).toBe(false);
    expect(r.accept(8)).toBe(true);
    expect(r.accept(100)).toBe(true);
    expect(r.accept(99)).toBe(false);
  });

  it("orders numbers across the 32-bit wrap (serial number arithmetic)", () => {
    const r = new UnreliableSequence();
    expect(r.accept(0xfffffffe)).toBe(true);
    expect(r.accept(0xffffffff)).toBe(true);
    expect(r.accept(0)).toBe(true); // wrapped: newer
    expect(r.accept(0xffffffff)).toBe(false); // from before the wrap: stale
    expect(r.accept(1)).toBe(true);
    // Up to 2³¹ − 1 ahead is newer; 2³¹ ahead is not.
    expect(r.accept(1 + 0x7fffffff)).toBe(true);
    expect(r.accept(1)).toBe(false);
    expect(r.accept((1 + 0x7fffffff + 0x80000000) >>> 0)).toBe(false);
  });

  it("delivers, in order, each number a sender takes across the wrap", () => {
    const r = new UnreliableSequence();
    const sent: number[] = [];
    let seq = 0xfffffffd;
    for (let i = 0; i < 5; i++) {
      sent.push(seq);
      seq = (seq + 1) >>> 0;
    }
    expect(sent.map((n) => r.accept(n))).toEqual([true, true, true, true, true]);
    expect(sent).toEqual([0xfffffffd, 0xfffffffe, 0xffffffff, 0, 1]);
  });

  it("puts a number on the wire as 4 bytes, big-endian, at any offset of any view", () => {
    expect(SEQUENCE_BYTES).toBe(4);
    const backing = new Uint8Array(12);
    const view = backing.subarray(3, 11);
    writeSeq(view, 2, 0x01020304);
    expect([...backing]).toEqual([0, 0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0]);
    expect(readSeq(view, 2)).toBe(0x01020304);
    expect(readSeq(backing, 5)).toBe(0x01020304);
    const msg = withSeq(0xfffffffe, new Uint8Array([9, 8]));
    expect([...msg]).toEqual([0xff, 0xff, 0xff, 0xfe, 9, 8]);
    expect(readSeq(msg, 0)).toBe(0xfffffffe);
  });
});
