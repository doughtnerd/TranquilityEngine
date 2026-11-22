/* Stub libc header for the decoder's libopus (ADR 0337 A7) for compiling libopus for wasm32-unknown-unknown (no libc): Rust's compiler_builtins provides these. */
#ifndef MYCO_OPUSDEC_STRING_H
#define MYCO_OPUSDEC_STRING_H
#include <stddef.h>
void *memcpy(void *d, const void *s, size_t n);
void *memmove(void *d, const void *s, size_t n);
void *memset(void *d, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);
#endif
