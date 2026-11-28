/** Page entry: exposes every spike test as `window.tests[name](...args)`; run.mjs calls them. */
import { t2Dispose, t2Scenario } from "./test2";
import { t3Cascades, t3Perf, t3Views } from "./test3";
import { t1Parity, t1SelectorProbe, t1Timing, type Variant } from "./test1";

const tests: Record<string, (...a: never[]) => Promise<unknown>> = {
  "1-timing": ((v: Variant, frames?: number) => t1Timing(v, frames)) as never,
  "1-parity": ((v: Variant, both?: boolean) => t1Parity(v, both)) as never,
  "2-scenario": ((sc: "baseline" | "sharedVB" | "sharedGeo", skinned?: boolean) => t2Scenario(sc, skinned)) as never,
  "2-dispose": () => t2Dispose(),
  "3-views": () => t3Views(),
  "3-cascades": ((m: "all" | "perCascade" | "perCascade-emptyLayer", e?: number) => t3Cascades(m, e)) as never,
  "3-perf": ((f?: number) => t3Perf(f)) as never,
  "1-selectorProbe": () => t1SelectorProbe(),
};
(window as unknown as { tests: typeof tests }).tests = tests;
(window as unknown as { ready: boolean }).ready = true;
