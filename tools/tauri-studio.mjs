// Run the Tauri CLI on the standalone Audio Studio app, src-studio-tauri/ (ADR 0341), rather than the editor's
// src-tauri/: `node tools/tauri-studio.mjs dev|build [args…]` (npm run tauri:studio:dev / tauri:studio:build).
// The CLI finds its app folder from TAURI_APP_PATH; setting it here keeps the npm scripts the same on every OS.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node tools/tauri-studio.mjs <dev|build|…> [args…]");
  process.exit(2);
}
const child = spawn("tauri", args, {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32", // npm's .cmd shims need a shell on Windows
  env: { ...process.env, TAURI_APP_PATH: join(root, "src-studio-tauri"), TAURI_FRONTEND_PATH: root },
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
