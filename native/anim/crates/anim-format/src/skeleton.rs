//! `myco.skel@1`: a skeleton (ADR 0371), in the [container] layout.
//!
//! Magic `"MYCOSKEL"`, version [`FORMAT_VERSION`], no header flags (0).
//!
//! # Sections
//!
//! | kind | name | align | count | record | required |
//! |---|---|---|---|---|---|
//! | 1 | `STRINGS` | 4 | strings | [string table](crate::strings) | yes |
//! | 2 | `INFO` | 4 | 1 | 16 B | yes |
//! | 3 | `BONES` | 16 | bones | 96 B | yes |
//! | 4 | `ROLES` | 4 | bones | 2 B (u16) | no |
//! | 5 | `JOINT_RANGES` | 4 | bones | 16 B | no |
//! | 6 | `MIRROR` | 4 | bones | 4 B (u32) | no |
//!
//! Optional per-bone sections, when present, have exactly one entry per bone.
//!
//! ## `INFO` (16 bytes)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u32 | skeleton name string id, or `NONE` |
//! | 4 | u32 | skeleton profile string id (the profile asset the roles index), or `NONE` |
//! | 8 | u32 | mirror axis: 0 x, 1 y, 2 z (the plane `MIRROR` reflects across) |
//! | 12 | u32 | bone count (= `BONES` count) |
//!
//! ## `BONES` (96 bytes each; parents before children; at most [`MAX_BONES`])
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | u32 | name string id |
//! | 4 | u16 | parent bone index, or `0xFFFF` ([`NO_PARENT`]) for a root; always less than the bone's own index (parents first, as `anim-math`'s `local_to_model` requires) |
//! | 6 | u16 | reserved (0) |
//! | 8 | f32 x 3 | rest local translation |
//! | 20 | f32 x 4 | rest local rotation (x, y, z, w) |
//! | 36 | f32 x 3 | rest local scale |
//! | 48 | f32 x 12 | inverse bind matrix, 3x4 row-major: three vec4 rows `[r00 r01 r02 tx]`, `[r10 r11 r12 ty]`, `[r20 r21 r22 tz]`, translation in the 4th column (the core's bone-matrix layout) |
//!
//! ## `ROLES`
//!
//! u16 per bone: the profile role index, or `0xFFFF` for none. A role appears on at most one bone.
//!
//! ## `JOINT_RANGES` (16 bytes each, degrees)
//!
//! | off | type | field |
//! |---|---|---|
//! | 0 | f32 | swing limit about Y, in \[0, 180\] |
//! | 4 | f32 | swing limit about Z, in \[0, 180\] |
//! | 8 | f32 | twist minimum, in \[-180, 180\] |
//! | 12 | f32 | twist maximum, in \[twist min, 180\] |
//!
//! ## `MIRROR`
//!
//! u32 per bone: the bone's left/right counterpart (itself for centre bones). The map is an
//! involution: `mirror[mirror[i]] == i`.

use crate::bytes::*;
use crate::container::{self, records, Container, FormatSpec, Layout, SectionEntry, SectionSpec};
use crate::error::{FormatError, Result};
use crate::strings::{self, StringTable};

/// Magic bytes.
pub const MAGIC: [u8; 8] = *b"MYCOSKEL";
/// The format's name.
pub const FORMAT: &str = "myco.skel@1";
/// The format version this build reads and writes.
pub const FORMAT_VERSION: u32 = 1;
/// The "no role" value of `ROLES`.
pub const NO_ROLE: u16 = 0xFFFF;
/// The "root" parent value (equal to `anim-math`'s `NO_PARENT`).
pub const NO_PARENT: u16 = 0xFFFF;
/// The most bones a skeleton holds (bone indices are u16; `0xFFFF` means none).
pub const MAX_BONES: usize = 0xFFFF;

/// Section kinds.
pub mod section {
    /// String table.
    pub const STRINGS: u32 = 1;
    /// Skeleton info.
    pub const INFO: u32 = 2;
    /// Bones.
    pub const BONES: u32 = 3;
    /// Profile role per bone.
    pub const ROLES: u32 = 4;
    /// Joint ranges per bone.
    pub const JOINT_RANGES: u32 = 5;
    /// Left/right mirror map.
    pub const MIRROR: u32 = 6;
}

const INFO_LEN: usize = 16;
const BONE_LEN: usize = 96;
const RANGE_LEN: usize = 16;

static SPEC: FormatSpec = FormatSpec {
    magic: MAGIC,
    version: FORMAT_VERSION,
    known_flags: 0,
    sections: &[
        SectionSpec {
            kind: section::STRINGS,
            name: "STRINGS",
            align: 4,
            layout: Layout::Custom,
            required: true,
        },
        SectionSpec {
            kind: section::INFO,
            name: "INFO",
            align: 4,
            layout: Layout::Records(INFO_LEN),
            required: true,
        },
        SectionSpec {
            kind: section::BONES,
            name: "BONES",
            align: 16,
            layout: Layout::Records(BONE_LEN),
            required: true,
        },
        SectionSpec {
            kind: section::ROLES,
            name: "ROLES",
            align: 4,
            layout: Layout::Records(2),
            required: false,
        },
        SectionSpec {
            kind: section::JOINT_RANGES,
            name: "JOINT_RANGES",
            align: 4,
            layout: Layout::Records(RANGE_LEN),
            required: false,
        },
        SectionSpec {
            kind: section::MIRROR,
            name: "MIRROR",
            align: 4,
            layout: Layout::Records(4),
            required: false,
        },
    ],
};

/// One bone.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bone {
    /// Name string id.
    pub name: u32,
    /// Parent index (less than this bone's), or [`NO_PARENT`].
    pub parent: u16,
    /// Rest local translation.
    pub translation: [f32; 3],
    /// Rest local rotation (x, y, z, w).
    pub rotation: [f32; 4],
    /// Rest local scale.
    pub scale: [f32; 3],
    /// Inverse bind matrix, 3x4 row-major.
    pub inverse_bind: [f32; 12],
}

/// One bone's joint range, in degrees.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JointRange {
    /// Swing limit about Y.
    pub swing_y: f32,
    /// Swing limit about Z.
    pub swing_z: f32,
    /// Twist minimum.
    pub twist_min: f32,
    /// Twist maximum.
    pub twist_max: f32,
}

/// The owned model of a `myco.skel@1` file.
#[derive(Clone, Debug, PartialEq)]
pub struct Skeleton {
    /// Name string id, or `NONE`.
    pub name: u32,
    /// Profile string id, or `NONE`.
    pub profile: u32,
    /// 0 x, 1 y, 2 z.
    pub mirror_axis: u32,
    /// The string table.
    pub strings: Vec<String>,
    /// Bones, parents first.
    pub bones: Vec<Bone>,
    /// Profile role per bone ([`NO_ROLE`] for none).
    pub roles: Option<Vec<u16>>,
    /// Joint range per bone.
    pub joint_ranges: Option<Vec<JointRange>>,
    /// Mirror counterpart per bone.
    pub mirror: Option<Vec<u32>>,
}

impl Skeleton {
    /// Writes the file (parsed back before it is returned).
    pub fn write(&self) -> Result<Vec<u8>> {
        let mut w = container::Writer::new(&SPEC, 0);
        w.section(
            section::STRINGS,
            self.strings.len(),
            strings::write(&self.strings)?,
        )?;
        let mut o = Out::default();
        o.u32s(&[
            self.name,
            self.profile,
            self.mirror_axis,
            to_u32("bones", self.bones.len())?,
        ]);
        w.section(section::INFO, 1, o.finish())?;
        let mut o = Out::default();
        for b in &self.bones {
            o.u32(b.name);
            o.u16(b.parent);
            o.u16(0);
            o.f32s(&b.translation);
            o.f32s(&b.rotation);
            o.f32s(&b.scale);
            o.f32s(&b.inverse_bind);
        }
        w.section(section::BONES, self.bones.len(), o.finish())?;
        if let Some(roles) = &self.roles {
            let mut o = Out::default();
            roles.iter().for_each(|&r| o.u16(r));
            w.section(section::ROLES, roles.len(), o.finish())?;
        }
        if let Some(ranges) = &self.joint_ranges {
            let mut o = Out::default();
            for r in ranges {
                o.f32s(&[r.swing_y, r.swing_z, r.twist_min, r.twist_max]);
            }
            w.section(section::JOINT_RANGES, ranges.len(), o.finish())?;
        }
        if let Some(m) = &self.mirror {
            let mut o = Out::default();
            o.u32s(m);
            w.section(section::MIRROR, m.len(), o.finish())?;
        }
        let bytes = w.finish()?;
        SkeletonView::parse(&bytes)?;
        Ok(bytes)
    }
}

/// The bone and its reserved u16.
fn read_bone(mut r: Rd<'_>) -> (Bone, u16) {
    let name = r.u32();
    let parent = r.u16();
    let reserved = r.u16();
    let b = Bone {
        name,
        parent,
        translation: r.f32s(),
        rotation: r.f32s(),
        scale: r.f32s(),
        inverse_bind: r.f32s(),
    };
    (b, reserved)
}

fn read_range(mut r: Rd<'_>) -> JointRange {
    JointRange {
        swing_y: r.f32(),
        swing_z: r.f32(),
        twist_min: r.f32(),
        twist_max: r.f32(),
    }
}

/// A validated, zero-copy view of a `myco.skel@1` buffer.
#[derive(Clone, Copy)]
pub struct SkeletonView<'a> {
    c: Container<'a>,
    strings: StringTable<'a>,
    info: [u32; 4],
}

impl<'a> SkeletonView<'a> {
    /// Parses and validates `bytes`.
    pub fn parse(bytes: &'a [u8]) -> Result<Self> {
        let c = container::parse(&SPEC, bytes)?;
        let strings =
            StringTable::parse(c.count(section::STRINGS) as u32, c.data(section::STRINGS))?;
        if c.count(section::INFO) != 1 {
            return Err(FormatError::BadCount {
                what: "INFO records",
                count: c.count(section::INFO) as u64,
                expected: 1,
            });
        }
        let info = Rd::new(c.data(section::INFO)).u32s::<4>();
        let v = SkeletonView { c, strings, info };
        v.validate()?;
        Ok(v)
    }

    fn validate(&self) -> Result<()> {
        let c = &self.c;
        let n = c.count(section::BONES);
        self.strings.check("skeleton name", self.info[0])?;
        self.strings.check("profile", self.info[1])?;
        if self.info[2] > 2 {
            return Err(FormatError::InvalidValue {
                what: "mirror axis",
                value: self.info[2],
            });
        }
        if self.info[3] as usize != n {
            return Err(FormatError::BadCount {
                what: "INFO bone count",
                count: self.info[3] as u64,
                expected: n as u64,
            });
        }
        if n > MAX_BONES {
            return Err(FormatError::BadCount {
                what: "bones",
                count: n as u64,
                expected: MAX_BONES as u64,
            });
        }
        for (i, r) in records(c.data(section::BONES), BONE_LEN).enumerate() {
            let (b, reserved) = read_bone(r);
            check_zero("bone reserved", reserved as u32)?;
            check_index("bone name", b.name, self.strings.len())?;
            if b.parent != NO_PARENT && b.parent as usize >= i {
                return Err(FormatError::Inconsistent {
                    what: "bone parent not before the bone",
                });
            }
            check_all_finite("rest translation", &b.translation)?;
            check_all_finite("rest rotation", &b.rotation)?;
            check_all_finite("rest scale", &b.scale)?;
            check_all_finite("inverse bind", &b.inverse_bind)?;
        }
        for (kind, name) in [
            (section::ROLES, "ROLES"),
            (section::JOINT_RANGES, "JOINT_RANGES"),
            (section::MIRROR, "MIRROR"),
        ] {
            if let Some(s) = c.get(kind) {
                if s.entry.count as usize != n {
                    return Err(FormatError::BadCount {
                        what: name,
                        count: s.entry.count as u64,
                        expected: n as u64,
                    });
                }
            }
        }
        if c.get(section::ROLES).is_some() {
            let mut roles: Vec<u16> = self.roles().filter(|&r| r != NO_ROLE).collect();
            roles.sort_unstable();
            if roles.windows(2).any(|w| w[0] == w[1]) {
                return Err(FormatError::Inconsistent {
                    what: "a profile role on two bones",
                });
            }
        }
        for r in records(c.data(section::JOINT_RANGES), RANGE_LEN) {
            let j = read_range(r);
            let ok = (0.0..=180.0).contains(&j.swing_y)
                && (0.0..=180.0).contains(&j.swing_z)
                && (-180.0..=180.0).contains(&j.twist_min)
                && (j.twist_min..=180.0).contains(&j.twist_max);
            if !ok {
                return Err(FormatError::BadFloat {
                    what: "joint range",
                });
            }
        }
        if let Some(s) = c.get(section::MIRROR) {
            let m = U32s::new(s.data);
            for (i, j) in m.iter().enumerate() {
                check_index("mirror bone", j, n)?;
                if m.get(j as usize) != Some(i as u32) {
                    return Err(FormatError::Inconsistent {
                        what: "mirror map is not an involution",
                    });
                }
            }
        }
        Ok(())
    }

    /// Name string id.
    pub fn name(&self) -> u32 {
        self.info[0]
    }
    /// Profile string id.
    pub fn profile(&self) -> u32 {
        self.info[1]
    }
    /// Mirror axis (0 x, 1 y, 2 z).
    pub fn mirror_axis(&self) -> u32 {
        self.info[2]
    }
    /// The string table.
    pub fn strings(&self) -> StringTable<'a> {
        self.strings
    }
    /// A section's table entry, if present.
    pub fn section(&self, kind: u32) -> Option<SectionEntry> {
        self.c.entry(kind)
    }
    /// The number of bones.
    pub fn bone_count(&self) -> usize {
        self.c.count(section::BONES)
    }
    /// Bone `i`.
    pub fn bone(&self, i: usize) -> Option<Bone> {
        container::record(self.c.data(section::BONES), BONE_LEN, i).map(|r| read_bone(r).0)
    }
    /// Bone `i`'s parent, or `None` for a root (or past the end).
    pub fn parent(&self, i: usize) -> Option<usize> {
        let p = self.bone(i)?.parent;
        (p != NO_PARENT).then_some(p as usize)
    }
    /// The role of each bone (empty when absent).
    pub fn roles(&self) -> impl Iterator<Item = u16> + 'a {
        self.c
            .data(section::ROLES)
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
    }
    /// Bone `i`'s role, or `None` when the section is absent or the bone has none.
    pub fn role(&self, i: usize) -> Option<u16> {
        let a = i.checked_mul(2)?;
        let b = self.c.data(section::ROLES).get(a..a.checked_add(2)?)?;
        Some(u16::from_le_bytes([b[0], b[1]])).filter(|&r| r != NO_ROLE)
    }
    /// Bone `i`'s joint range, if the section is present.
    pub fn joint_range(&self, i: usize) -> Option<JointRange> {
        container::record(self.c.data(section::JOINT_RANGES), RANGE_LEN, i).map(read_range)
    }
    /// The mirror map, if present.
    pub fn mirror(&self) -> Option<U32s<'a>> {
        self.c.get(section::MIRROR).map(|s| U32s::new(s.data))
    }
    /// The owned model.
    pub fn to_skeleton(&self) -> Skeleton {
        let c = &self.c;
        Skeleton {
            name: self.name(),
            profile: self.profile(),
            mirror_axis: self.mirror_axis(),
            strings: self.strings.to_vec(),
            bones: (0..self.bone_count())
                .filter_map(|i| self.bone(i))
                .collect(),
            roles: c.get(section::ROLES).map(|_| self.roles().collect()),
            joint_ranges: c.get(section::JOINT_RANGES).map(|_| {
                (0..self.bone_count())
                    .filter_map(|i| self.joint_range(i))
                    .collect()
            }),
            mirror: self.mirror().map(|m| m.to_vec()),
        }
    }
}
