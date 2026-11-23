// The meter pass moved to src/engine/wasm/meter.js (ADR 0352 §6, "Deprecates"): the audio build and the plugin
// validator share it there, with its fuel mode. This file re-exports it for the tools and tests that still import it.
export { COUNTER_EXPORT, FUEL_EXPORT, METER_VERSION, meter, readModule } from "../../src/engine/wasm/meter.js";
