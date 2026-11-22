/* Stub libc header (wasm32-unknown-unknown): malloc/calloc/realloc/free/abort are defined in Rust (src/lib.rs). */
#ifndef SPIKE_STDLIB_H
#define SPIKE_STDLIB_H
#include <stddef.h>
void *malloc(size_t n);
void *calloc(size_t n, size_t size);
void *realloc(void *p, size_t n);
void free(void *p);
void abort(void);
int abs(int x);
#endif
