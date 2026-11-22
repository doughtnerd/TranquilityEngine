/* Stub libc header for the decoder's libopus (ADR 0337 A7) (wasm32-unknown-unknown). libopus's FIXED_POINT decoder needs no libm at run time; the few
 * float helpers it declares map to clang builtins (lowered to wasm instructions where they exist). */
#ifndef MYCO_OPUSDEC_MATH_H
#define MYCO_OPUSDEC_MATH_H
#define floor(x) __builtin_floor(x)
#define floorf(x) __builtin_floorf(x)
#define ceil(x) __builtin_ceil(x)
#define sqrt(x) __builtin_sqrt(x)
#define sqrtf(x) __builtin_sqrtf(x)
#define fabs(x) __builtin_fabs(x)
#define fabsf(x) __builtin_fabsf(x)
#define lrintf(x) ((long)__builtin_rintf(x))
#define lrint(x) ((long)__builtin_rint(x))
float expf(float);
float logf(float);
float powf(float, float);
float cosf(float);
float sinf(float);
double exp(double);
double log(double);
double pow(double, double);
double cos(double);
double sin(double);
#define M_PI 3.141592653589793
#endif
