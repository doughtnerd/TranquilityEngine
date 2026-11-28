// node lazy-overhead.mjs (run from the repo root; shells out to `vite build` so vite.shared.ts loads): builds a tiny entry with N trivial dynamic-import launch steps (N = 0, 1, 5, 20) through
// Vite with typescriptTranspile() and oxc:false, and prints total bytes vs N. Also N steps in ONE module (baseline).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("./out/lazy", import.meta.url));
const stepSrc = (i) => `// step ${i}\nexport interface Ctx { log: string[] }\nexport async function run(ctx: Ctx): Promise<void> {\n  ctx.log.push("step-${i}:" + (ctx.log.length * ${i + 7}));\n}\n`;
const entrySrc = (n, lazy) =>
  lazy
    ? `const ctx = { log: [] as string[] };\nconst steps = [${Array.from({ length: n }, (_, i) => `() => import("./step${i}")`).join(", ")}];\nfor (const load of steps) await (await load()).run(ctx);\nconsole.log(ctx.log.join(","));\n`
    : `const ctx = { log: [] as string[] };\n${Array.from({ length: n }, (_, i) => `ctx.log.push("step-${i}:" + (ctx.log.length * ${i + 7}));`).join("\n")}\nconsole.log(ctx.log.join(","));\n`;
const gz = (b) => gzipSync(b, { level: 9 }).length;
const br = (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

async function one(n, lazy) {
  const dir = join(root, `${lazy ? "lazy" : "inline"}${n}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n && lazy; i++) writeFileSync(join(dir, `step${i}.ts`), stepSrc(i));
  writeFileSync(join(dir, "main.ts"), entrySrc(n, lazy));
  const shared = fileURLToPath(new URL("../../vite.shared.ts", import.meta.url));
  writeFileSync(join(dir, "vite.config.ts"), `import { typescriptTranspile } from ${JSON.stringify(shared)};
export default { root: ${JSON.stringify(dir)}, logLevel: "silent", plugins: [typescriptTranspile()], oxc: false, base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, rollupOptions: { input: ${JSON.stringify(join(dir, "main.ts"))} }, modulePreload: { polyfill: false } } };\n`);
  execFileSync("npx", ["vite", "build", "--config", join(dir, "vite.config.ts")], { stdio: "inherit" });
  const files = readdirSync(join(dir, "dist", "assets")).map((f) => join(dir, "dist", "assets", f));
  let raw = 0, g = 0, b = 0;
  for (const f of files) { const buf = readFileSync(f); raw += buf.length; g += gz(buf); b += br(buf); }
  const entry = files.find((f) => /main/.test(f));
  console.log(`${lazy ? "lazy  " : "inline"} N=${String(n).padStart(2)}  files=${files.length}  raw=${raw}  gzip=${g}  brotli=${b}  entry-raw=${statSync(entry).size}`);
}
for (const n of [0, 1, 5, 20]) { await one(n, false); if (n > 0) await one(n, true); }
