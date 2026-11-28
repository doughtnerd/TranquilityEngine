#!/usr/bin/env node
// SPIKE (a): runs the export steps from Node the way `npm run export` starts (src/export/cli.mjs): the engine's
// TypeScript is loaded through src/server/tsLoader.mjs, and the project is read by the CLI's own reader (readProject).
//   node spikes/plugin-export-step/runNode.mjs [projectDir] [--debug]
import * as nodeModule from "node:module";

const hooks = new URL("../../src/server/tsLoader.mjs", import.meta.url);
if (typeof nodeModule.registerHooks === "function") nodeModule.registerHooks(await import(hooks.href));
else nodeModule.register(hooks.href);

const { run } = await import("./runNode.ts");
process.exitCode = await run(process.argv.slice(2));
