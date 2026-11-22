// Spike B0 (ADR 0338): prints a results file from run.mjs as compact tables.
// Usage: node tools/spikes/fx-plugin/summarize.mjs FILE
import { readFileSync } from "node:fs";

const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const f = (x, d = 0) => (typeof x === "number" ? x.toFixed(d) : String(x));
const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

function engine(name, e) {
  if (!e) return;
  console.log(`\n=== ${name} ${e.version ?? ""} ${e.error ? "ERROR " + e.error : ""}`);
  if (e.env) console.log("env", JSON.stringify(e.env));
  if (e.glue) {
    for (const g of e.glue.filter((g) => g.test !== "glue")) console.log(JSON.stringify(g));
    console.log("variant    kind     strategy     n   perCall  importNop  direct   glue  us/quantum");
    for (const g of e.glue.filter((g) => g.test === "glue")) {
      console.log(
        `${g.variant.padEnd(10)} ${g.kind.padEnd(8)} ${g.strategy.padEnd(11)} ${String(g.instances).padStart(2)} ${f(g.nsPerCall).padStart(8)} ${f(g.nsImportNop).padStart(9)} ${f(g.nsPluginDirect).padStart(7)} ${f(g.nsGlue).padStart(6)} ${f(g.usPerQuantum, 1).padStart(8)}`,
      );
    }
  }
  if (e.fuel) {
    const vs = ["count32", "loop32", "segment32", "loop64", "segment64", "loopload32", "segload32"];
    console.log(`kind     instr/frame  plain ns ${vs.map((v) => v.padStart(10)).join("")}`);
    for (const k of e.fuel) {
      console.log(`${k.kind.padEnd(8)} ${f(k.instructionsPerFrame, 1).padStart(11)} ${f(k.ns_plain).padStart(9)} ${vs.map((v) => pct(k[`slowdown_${v}`]).padStart(10)).join("")}`);
    }
  }
  if (e.compile) for (const c of e.compile) console.log(`compile ${c.module.padEnd(42)} ${String(c.bytes).padStart(8)} B  compile ${f(c.msCompile, 3)} ms  inst ${f(c.msInstantiate, 3)}  first ${f(c.msFirstCall, 3)}  (n=${c.reps})`);
  if (e.faults) {
    for (const fr of [].concat(e.faults)) {
      console.log(`faults [${fr.strategy}] ref ${fr.referenceHash}`);
      for (const m of fr.modes) console.log("  ", JSON.stringify(m));
      console.log("   uncaught", JSON.stringify(fr.uncaught));
      console.log("   recovery", JSON.stringify(fr.recovery));
    }
  }
  if (e.worklet) engine(`${name} / AudioWorkletGlobalScope`, e.worklet);
}

console.log(JSON.stringify(r.machine));
console.log(JSON.stringify(r.static));
engine("node", r.node);
for (const [k, v] of Object.entries(r.browsers ?? {})) engine(k, v);
