#!/usr/bin/env node
// Heap-per-entity measurement. Run: `npm run bench:memory` (= node --expose-gc bench/memory.mjs).
// Loads the engine's TypeScript through src/server/tsLoader.mjs, like `npm run export`.
import * as nodeModule from "node:module";

const hooks = new URL("../src/server/tsLoader.mjs", import.meta.url);
if (typeof nodeModule.registerHooks === "function") nodeModule.registerHooks(await import(hooks.href));
else nodeModule.register(hooks.href);
await import("./memory.ts");
