#!/bin/sh
# Builds the Rust `meshopt` 0.7.0 crate (vendors meshoptimizer 1.3) to wasm32-unknown-unknown.
# Out of the box this FAILS on clang 18 (the crate's include_wasm32 stub headers lack floorf/log2f/ceilf/frexpf/ldexpf...),
# and the link FAILS without operator new/delete (provided in src/lib.rs). The -D flags below map the libm calls to clang builtins.
set -e
cd "$(dirname "$0")"
F="-Dfloorf=__builtin_floorf -Dlog2f=__builtin_log2f -Dceilf=__builtin_ceilf -Dfrexpf=__builtin_frexpf -Dldexpf=__builtin_ldexpf -Dpowf=__builtin_powf -Dexpf=__builtin_expf -Dsinf=__builtin_sinf -Dcosf=__builtin_cosf -Datan2f=__builtin_atan2f -Dfmodf=__builtin_fmodf -Dlogf=__builtin_logf -Droundf=__builtin_roundf -Dtruncf=__builtin_truncf"
export CFLAGS_wasm32_unknown_unknown="$F" CXXFLAGS_wasm32_unknown_unknown="$F"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/claude-0/cargo-target}"
cargo build --release --target wasm32-unknown-unknown
ls -l "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/mw.wasm"
