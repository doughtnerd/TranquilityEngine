// ADR 0337 spike A0/S1: the browser's WASI shim for the encoder reactor (no dependency). It covers exactly the six
// imports the wasm32-wasip1 build asks for: fd_write (stdout/stderr to the console), random_get, clock_time_get,
// environ_get/environ_sizes_get (empty environment) and proc_exit. Anything else would fail at instantiation.
export function wasiShim() {
  let memory = null;
  const view = () => new DataView(memory.buffer);
  const lines = { 1: "", 2: "" };
  const decoder = new TextDecoder();
  class ProcExit extends Error {
    constructor(code) { super(`proc_exit(${code})`); this.code = code; }
  }
  const imports = {
    fd_write(fd, iovs, iovsLen, nwritten) {
      const v = view();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        if (fd === 1 || fd === 2) lines[fd] += decoder.decode(new Uint8Array(memory.buffer, ptr, len));
        total += len;
      }
      for (const f of [1, 2]) {
        const parts = lines[f].split("\n");
        lines[f] = parts.pop();
        for (const p of parts) (f === 1 ? console.log : console.error)(p);
      }
      v.setUint32(nwritten, total, true);
      return fd === 1 || fd === 2 ? 0 : 8; // EBADF for any other descriptor
    },
    random_get(ptr, len) {
      crypto.getRandomValues(new Uint8Array(memory.buffer, ptr, len));
      return 0;
    },
    clock_time_get(_id, _precision, out) {
      // Monotonic and realtime both from performance (ns); the encoder only measures intervals.
      view().setBigUint64(out, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)), true);
      return 0;
    },
    environ_sizes_get(count, size) {
      view().setUint32(count, 0, true);
      view().setUint32(size, 0, true);
      return 0;
    },
    environ_get() {
      return 0;
    },
    proc_exit(code) {
      throw new ProcExit(code);
    },
  };
  return { imports: { wasi_snapshot_preview1: imports }, bind(instance) { memory = instance.exports.memory; }, ProcExit };
}
