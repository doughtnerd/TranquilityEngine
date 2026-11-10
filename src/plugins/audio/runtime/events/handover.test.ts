// ADR 0158 E3.3: PendingCoreBackend hand-over (loop, group, bindings) and the backend-switch re-send.
import { describe, it } from "vitest";

describe("PendingVoice", () => {
  it.skip("records setLoop without a TsAutomation warning while the core loads", () => {});
  it.skip("keeps group, loop and bindings across handOver (real CoreBackend on the loopback host)", () => {});
  it.skip("applies nothing twice; voices are resolved by id", () => {});
});
describe("backend switch re-send", () => {
  it.skip("a running instance re-sends its voices on the new backend", () => {});
});
