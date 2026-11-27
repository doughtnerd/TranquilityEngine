@echo off
rem Windows: Cargo runs this as RUSTC_WRAPPER (ADR 0432); rustc-wrapper.mjs does the work.
node "%~dp0rustc-wrapper.mjs" %*
