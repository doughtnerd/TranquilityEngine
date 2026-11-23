/* Stub libc header for the decoder's libopus (ADR 0351 A7) (wasm32-unknown-unknown): malloc/calloc/realloc/free/abort are defined in Rust (audio-decode src/opus.rs). */
#ifndef MYCO_OPUSDEC_STDLIB_H
#define MYCO_OPUSDEC_STDLIB_H
#include <stddef.h>
void *malloc(size_t n);
void *calloc(size_t n, size_t size);
void *realloc(void *p, size_t n);
void free(void *p);
void abort(void);
int abs(int x);
#endif
