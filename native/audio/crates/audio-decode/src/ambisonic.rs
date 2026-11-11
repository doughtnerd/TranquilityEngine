//! FuMa to AmbiX conversion in the decoder (ADR 0162, api-and-models §2.4 and §5.1; owner O1):
//! the channel reorder and the SN3D scaling into int16 headroom, applied in the decode loop before
//! the int16 rounding of `read_i16`, per chunk in the worker (`STREAM_OPEN.convention`, C6).
//!
//! Skeleton declared by K2 (task A1); task B2 fills it.
