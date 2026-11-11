//! Ambisonic encoding and rotation (ADR 0162, api-and-models §5.1, architecture §3.1): SN3D/ACN
//! encode of a mono voice at orders 1 to 3 (into a 16-channel bed) and the Ivanic-Ruedenberg
//! rotation of an order-3 sound field (the listener's orientation, a clip's yaw).
//!
//! Skeleton declared by K2 (task A1); task A2 fills it. The baked 16 to 2 decode matrix is in
//! `bed_matrix.rs` (A3), not here. Transcendentals through `libm`; nothing allocates while processing.
