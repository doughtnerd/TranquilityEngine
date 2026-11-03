#!/usr/bin/env node
// `npm run export` (ADR 0041): runs src/export/main.ts from source. See main.ts for usage. Like
// `myco-server`, it loads the engine's TypeScript through the hooks in src/server/tsLoader.mjs.
import * as nodeModule from "node:module";

const hooks = new URL("../server/tsLoader.mjs", import.meta.url);
if (typeof nodeModule.registerHooks === "function") nodeModule.registerHooks(await import(hooks.href));
else nodeModule.register(hooks.href);
process.setSourceMapsEnabled?.(true);

const { main } = await import("./main.ts");
process.exitCode = await main(process.argv.slice(2));
