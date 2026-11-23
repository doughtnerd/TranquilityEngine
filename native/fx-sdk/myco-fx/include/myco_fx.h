/*
 * Myco audio effect plugins: the DSP ABI 1.0 (ADR 0352 §2, amended by 0358) for C, C++ and Zig authors.
 *
 * Build for wasm32 with no imports (e.g. `clang --target=wasm32 -nostdlib -O3 -Wl,--no-entry -Wl,--export-dynamic
 * -Wl,-z,stack-size=65536 -Wl,--max-memory=<memoryMB * 1048576>`), export these functions and the module's own
 * `memory`. Anything else exported is ignored; any import, a start function, threads, shared memory and relaxed SIMD
 * refuse the module.
 *
 * Rules the host enforces (a breach is a fault: the block passes through dry and the instance is re-created):
 * - `myco_fx_create` may grow memory up to the manifest's memoryMB; `myco_fx_process` never may.
 * - Each process call gets instructionsPerFrame x frames of fuel (default 1,000 per frame, at most 5,000).
 * - Output samples must be finite and within +-64.
 * - Free what destroy releases: the host destroys and re-creates instances in place.
 */
#ifndef MYCO_FX_H
#define MYCO_FX_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The ABI version myco_fx_abi returns: major << 8 | minor. */
#define MYCO_FX_ABI 0x0100u
/* Parameters per block edge. */
#define MYCO_FX_PARAMS 16
/* myco_fx_process flags. */
#define MYCO_FX_PARAMS_CHANGED 1u
#define MYCO_FX_INPUT_SILENT 2u
/* myco_fx_process results. */
#define MYCO_FX_OK 0
#define MYCO_FX_SILENT 1

#if defined(__wasm__)
#define MYCO_FX_EXPORT(name) __attribute__((export_name(#name), visibility("default")))
#else
#define MYCO_FX_EXPORT(name)
#endif

/* The instance's I/O block, at the address myco_fx_io returns: l[max_frames], r[max_frames], then p0[16], p1[16]. */
#define MYCO_FX_IO_L(io, max_frames) ((float *)(io))
#define MYCO_FX_IO_R(io, max_frames) ((float *)(io) + (max_frames))
#define MYCO_FX_IO_P0(io, max_frames) ((float *)(io) + 2 * (max_frames))
#define MYCO_FX_IO_P1(io, max_frames) ((float *)(io) + 2 * (max_frames) + MYCO_FX_PARAMS)

/* Returns MYCO_FX_ABI. */
MYCO_FX_EXPORT(myco_fx_abi) uint32_t myco_fx_abi(void);
/* A new instance of effect `kind` (its index in plugin.json's module), or 0 when refused. May allocate. */
MYCO_FX_EXPORT(myco_fx_create) uint32_t myco_fx_create(uint32_t kind, float sample_rate, uint32_t max_frames);
MYCO_FX_EXPORT(myco_fx_destroy) void myco_fx_destroy(uint32_t kind, uint32_t state);
/* Clears tails and history. */
MYCO_FX_EXPORT(myco_fx_reset) void myco_fx_reset(uint32_t kind, uint32_t state);
/* The instance's I/O block address. */
MYCO_FX_EXPORT(myco_fx_io) uint32_t myco_fx_io(uint32_t kind, uint32_t state);
/* Processes `frames` frames in place on io.l and io.r; p0 holds the parameters at the block's start, p1 at its end
 * (ramp between them). Returns MYCO_FX_OK, or MYCO_FX_SILENT when the output is silent (the tail has finished). */
MYCO_FX_EXPORT(myco_fx_process) int32_t myco_fx_process(uint32_t kind, uint32_t state, uint32_t frames, uint32_t flags);
/* Optional: frames of tail after the input stops. */
MYCO_FX_EXPORT(myco_fx_tail_frames) uint32_t myco_fx_tail_frames(uint32_t kind, uint32_t state);

#ifdef __cplusplus
}
#endif

#endif /* MYCO_FX_H */
