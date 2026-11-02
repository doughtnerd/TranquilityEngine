#!/usr/bin/env node
// The `tranquility-server` command (T14): runs src/server/main.ts from source. See main.ts for
// usage. The engine is TypeScript with standard decorators, so the hooks in tsLoader.mjs compile
// it with the `typescript` package as it loads.
import * as nodeModule from "node:module";

const hooks = new URL("./tsLoader.mjs", import.meta.url);
if (typeof nodeModule.registerHooks === "function") nodeModule.registerHooks(await import(hooks.href));
else nodeModule.register(hooks.href);
process.setSourceMapsEnabled?.(true); // stack traces show the TypeScript

const { main } = await import("./main.ts");
const code = await main(process.argv.slice(2));
if (code !== undefined) process.exitCode = code;
