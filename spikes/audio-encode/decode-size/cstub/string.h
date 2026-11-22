/* Stub libc header for compiling libopus for wasm32-unknown-unknown (no libc): Rust's compiler_builtins provides these. */
#ifndef SPIKE_STRING_H
#define SPIKE_STRING_H
#include <stddef.h>
void *memcpy(void *d, const void *s, size_t n);
void *memmove(void *d, const void *s, size_t n);
void *memset(void *d, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);
#endif
