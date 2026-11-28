// Bundle the spike page with esbuild from the repo's node_modules (Babylon imported module by module).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, "dist"), { recursive: true });
copyFileSync(join(here, "index.html"), join(here, "dist", "index.html"));
await build({
  entryPoints: [join(here, "main.ts")],
  bundle: true,
  format: "esm",
  outfile: join(here, "dist", "bundle.js"),
  target: "es2022",
  sourcemap: false,
  logLevel: "warning",
});
