// Tests for the worker's music encoded cache (ADR 0166 R16; architecture §4.2; contract C8). Skipped cases are the
// spec of leaf L-D1ca: un-skip and fill each body against `MusicCache` (pure, no wasm).
import { describe, it } from "vitest";

describe("MusicCache (L-D1ca)", () => {
  it.skip("hold with bytes then lookup returns the same buffer; an unknown path or instance is a miss (null)", () => {});
  it.skip("hold without bytes on a held path adds a reference and keeps the bytes", () => {});
  it.skip("hold without bytes on an unheld path keeps nothing (lookup stays null)", () => {});
  it.skip("refcount by path: two opens of one path need two releases before the path counts as closed", () => {});
  it.skip("a closed path stays held (lookup hits) until the instance is released or the budget evicts it", () => {});
  it.skip("a second prime of the same segment: after release of every member, lookup still hits for each path", () => {});
  it.skip("instances are separate: the same path in two instances is held twice; releaseInstance(a) leaves b's bytes", () => {});
  it.skip("releaseInstance drops every reference and byte of the instance, open or closed", () => {});
  it.skip("over budget, unprotected closed paths are evicted, least recently closed first", () => {});
  it.skip("lookup does not reorder eviction (order is by close time, not by use)", () => {});
  it.skip("a path with an open reference is never evicted, protected or not", () => {});
  it.skip("protected paths (playing, primed, candidate successors) are never evicted; protect replaces the previous set", () => {});
  it.skip("a path that stops being protected becomes evictable at the next over-budget check", () => {});
  it.skip("a path re-opened after closing leaves the eviction queue and re-enters at its new close time", () => {});
  it.skip("protected files alone over budget: nothing protected is evicted and warn fires once per instance (encodedOverBudget)", () => {});
  it.skip("the over-budget warning fires once per instance, not on every later hold or protect while still over", () => {});
  it.skip("setBudget lower evicts at once down to it; higher keeps everything; non-finite or negative is ignored", () => {});
  it.skip("budget counts bytes once per held buffer and bytesHeld matches the sum after evictions", () => {});
  it.skip("eviction is a miss, not an error: lookup after eviction returns null (main resends with bytes)", () => {});
});
