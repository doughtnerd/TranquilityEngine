// Runs a `cargo test --target wasm32-unknown-unknown` test binary in Node, so anim-math's tests
// (including the bit-for-bit SoA-vs-scalar and golden-hash checks) run on the simd128 path:
//
//   CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER="node $PWD/crates/anim-math/wasm-test-runner.mjs" \
//     cargo test -p anim-math --target wasm32-unknown-unknown
//
// from native/anim/ (the path must be absolute: cargo runs tests from the crate folder). libtest
// on wasm32-unknown-unknown has no stdout, so this prints only the verdict: the harness's `main`
// returns when every test passed and traps (`unreachable`, from the panic abort) when one fails.
// The binary imports nothing.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const file = process.argv[2];
const module = await WebAssembly.compile(readFileSync(file));
const instance = await WebAssembly.instantiate(module, {});
try {
  const code = instance.exports.main(0, 0);
  if (code !== 0) {
    console.error(`${basename(file)}: exit code ${code}`);
    process.exit(1);
  }
  console.log(`${basename(file)}: all tests passed (wasm32, simd128)`);
} catch (error) {
  console.error(`${basename(file)}: a test failed (${error.message})`);
  process.exit(1);
}
