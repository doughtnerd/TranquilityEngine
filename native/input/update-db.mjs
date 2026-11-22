#!/usr/bin/env node
// `node native/input/update-db.mjs`: refreshes the vendored SDL controller database
// (crates/input-map/db/gamecontrollerdb.txt) and its licence from SDL_GameControllerDB's main
// branch (https://github.com/mdqinc/SDL_GameControllerDB, zlib licence). Then run
// `cargo test` here and `npm run build:input`, and commit the database with the rebuilt wasm.
import { writeFileSync } from "node:fs";

const base = "https://raw.githubusercontent.com/mdqinc/SDL_GameControllerDB/master/";
const files = { "gamecontrollerdb.txt": "gamecontrollerdb.txt", LICENSE: "LICENSE.txt" };

for (const [remote, local] of Object.entries(files)) {
  const response = await fetch(base + remote);
  if (!response.ok) throw new Error(`${base}${remote}: HTTP ${response.status}`);
  const text = (await response.text()).replace(/\r\n/g, "\n");
  writeFileSync(new URL(`crates/input-map/db/${local}`, import.meta.url), text);
  console.log(`[update-db] ${local}: ${text.length} bytes`);
}
