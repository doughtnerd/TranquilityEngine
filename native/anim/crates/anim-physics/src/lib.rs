//! `anim-physics` (ADR 0340, 0345): physical-animation drive targets. From a pose and a ragdoll
//! description it computes joint motor targets and strengths per bone, and blends ragdoll poses
//! back in.
//!
//! It computes targets only; simulation stays in the physics plugin (`myco.ragdoll` reads the
//! targets and drives `BallJoint.drive`, ADR 0345).
//!
//! Internal to the animation core: nothing here is engine public API (ADR 0010).
//!
//! - [`desc`]: the [`RagdollDesc`] (per bone: a body or not, the joint frame, swing and twist
//!   limits, the motor's stiffness, damping and maximum force, a strength multiplier and a pin
//!   weight; the pelvis and its front axis for get-up), its default builder from a skeleton's
//!   joint ranges, and the validated [`Ragdoll`] with each body's parent body;
//! - [`drive`]: [`Ragdoll::drive`], the per-step drive targets from the animated pose and its
//!   predecessor (never allocates);
//! - [`pose`]: body frames ↔ bone frames, and [`pose::bodies_to_local`], the simulated bodies
//!   back as the skeleton's local pose (the graph's physical-pose input);
//! - [`getup`]: which way the pelvis faces, and the get-up state it picks.
//!
//! # Frames
//!
//! Every transform is in the character's **model space** (the entity's frame; +Y up), as the
//! rig's grounder rays are (decision D41): the ragdoll plugin converts to and from world space. A
//! bone's **body frame** sits at the bone's origin (its joint) with rotation `R_bone · J`, `J` the
//! bone's joint frame (identity by default: the ball joint's twist axis is the bone's local +X,
//! as `anim-rig`'s limits, decision D38). A body's **parent body** is its nearest ancestor bone
//! with a body; a body without one is a **root body**, pinned to the animation.

// `!(x > 0.0)` is deliberate: it is true for NaN as well, which `x <= 0.0` is not.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod desc;
pub mod drive;
pub mod getup;
pub mod pose;

pub use desc::{BoneDesc, DescError, FrontAxis, Ragdoll, RagdollDesc, NO_BONE};
pub use drive::{Drive, DriveError, DriveInput, DriveScratch, DRIVE_BODY, DRIVE_ROOT, DRIVE_VELOCITY};
pub use getup::{facing, getup_state, Facing};
