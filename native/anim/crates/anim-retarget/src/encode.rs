//! The profile's boundary encoding: how TypeScript (Phase B) passes a custom `*.skelprofile.json`
//! into the core. A flat little-endian byte layout, parsed with validation; anything malformed
//! or breaking a [`Profile::validate`] rule is refused, never patched.
//!
//! # Layout
//!
//! | size | field |
//! |---|---|
//! | 8 | magic `"MYCOPROF"` |
//! | 4 | u32 version ([`VERSION`]) |
//! | 2 | u16 role count (1..=[`MAX_ROLES`]) |
//! | 2 | u16 chain count (0..=[`MAX_CHAINS`]) |
//! | 2 | u16 root role, or `0xFFFF` |
//! | 2 | u16 hips role, or `0xFFFF` |
//! | 1 + n | profile name: u8 byte length, UTF-8 bytes (may be empty) |
//! | per role | u8 name length (1..=255), UTF-8 name; u16 mirror role; u8 flip (0 none, 1 X, 2 Y, 3 Z, `0xFF` derive from the rest pose); u8 flags (bit 0: a joint range follows, bit 1: required; other bits 0); with bit 0, f32 × 4 range (swing Y, swing Z, twist min, twist max, degrees) |
//! | per chain | u8 name length (1..=255), UTF-8 name; u8 kind ([`ChainKind`] 0..=6); u8 flags (bit 0: IK; other bits 0); u16 role count (≥ 1); u16 × count role indices |
//!
//! The bytes end exactly after the last chain.

use crate::profile::{
    Chain, ChainKind, Profile, ProfileError, Role, MAX_CHAINS, MAX_NAME, MAX_ROLES,
};
use anim_format::skeleton::JointRange;
use anim_pose::mirror::Flip;

/// The magic bytes.
pub const MAGIC: [u8; 8] = *b"MYCOPROF";
/// The layout version this build reads and writes.
pub const VERSION: u32 = 1;
/// The flip byte meaning "derive from the rest pose".
pub const FLIP_AUTO: u8 = 0xFF;

const ROLE_RANGE: u8 = 1;
const ROLE_REQUIRED: u8 = 2;
const CHAIN_IK: u8 = 1;

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize, what: &'static str) -> Result<&'a [u8], ProfileError> {
        if self.b.len() - self.at < n {
            return Err(ProfileError::Malformed(what, self.at));
        }
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    fn u8(&mut self, what: &'static str) -> Result<u8, ProfileError> {
        Ok(self.take(1, what)?[0])
    }
    fn u16(&mut self, what: &'static str) -> Result<u16, ProfileError> {
        let s = self.take(2, what)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self, what: &'static str) -> Result<u32, ProfileError> {
        let s = self.take(4, what)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn f32(&mut self, what: &'static str) -> Result<f32, ProfileError> {
        Ok(f32::from_bits(self.u32(what)?))
    }
    fn name(&mut self, what: &'static str, allow_empty: bool) -> Result<String, ProfileError> {
        let at = self.at;
        let n = self.u8(what)? as usize;
        if n == 0 && !allow_empty {
            return Err(ProfileError::Malformed(what, at));
        }
        let s = self.take(n, what)?;
        core::str::from_utf8(s)
            .map(str::to_string)
            .map_err(|_| ProfileError::Malformed("name is not UTF-8", at))
    }
}

/// Parses and validates an encoded profile.
pub fn decode(bytes: &[u8]) -> Result<Profile, ProfileError> {
    let mut r = Reader { b: bytes, at: 0 };
    if r.take(8, "magic")? != MAGIC {
        return Err(ProfileError::Malformed("magic", 0));
    }
    if r.u32("version")? != VERSION {
        return Err(ProfileError::Malformed("version", 8));
    }
    let role_count = r.u16("role count")? as usize;
    let chain_count = r.u16("chain count")? as usize;
    if role_count == 0 || role_count > MAX_ROLES {
        return Err(ProfileError::Malformed("role count", 12));
    }
    if chain_count > MAX_CHAINS {
        return Err(ProfileError::Malformed("chain count", 14));
    }
    let root = r.u16("root role")?;
    let hips = r.u16("hips role")?;
    let name = r.name("profile name", true)?;
    let mut roles = Vec::with_capacity(role_count);
    for _ in 0..role_count {
        let name = r.name("role name", false)?;
        let mirror = r.u16("role mirror")?;
        let at = r.at;
        let flip = match r.u8("role flip")? {
            FLIP_AUTO => None,
            v => Some(Flip::from_u8(v).ok_or(ProfileError::Malformed("role flip", at))?),
        };
        let at = r.at;
        let flags = r.u8("role flags")?;
        if flags & !(ROLE_RANGE | ROLE_REQUIRED) != 0 {
            return Err(ProfileError::Malformed("unknown role flags", at));
        }
        let range = if flags & ROLE_RANGE != 0 {
            Some(JointRange {
                swing_y: r.f32("range")?,
                swing_z: r.f32("range")?,
                twist_min: r.f32("range")?,
                twist_max: r.f32("range")?,
            })
        } else {
            None
        };
        roles.push(Role {
            name,
            mirror,
            flip,
            range,
            required: flags & ROLE_REQUIRED != 0,
        });
    }
    let mut chains = Vec::with_capacity(chain_count);
    for _ in 0..chain_count {
        let name = r.name("chain name", false)?;
        let at = r.at;
        let kind = ChainKind::from_u8(r.u8("chain kind")?)
            .ok_or(ProfileError::Malformed("chain kind", at))?;
        let at = r.at;
        let flags = r.u8("chain flags")?;
        if flags & !CHAIN_IK != 0 {
            return Err(ProfileError::Malformed("unknown chain flags", at));
        }
        let at = r.at;
        let n = r.u16("chain role count")? as usize;
        if n == 0 || n > role_count {
            return Err(ProfileError::Malformed("chain role count", at));
        }
        let mut cr = Vec::with_capacity(n);
        for _ in 0..n {
            cr.push(r.u16("chain role")?);
        }
        chains.push(Chain {
            name,
            kind,
            roles: cr,
            ik: flags & CHAIN_IK != 0,
        });
    }
    if r.at != bytes.len() {
        return Err(ProfileError::Malformed("trailing bytes", r.at));
    }
    let p = Profile {
        name,
        roles,
        chains,
        root,
        hips,
    };
    p.validate()?;
    Ok(p)
}

/// Encodes a profile (validated first, so a profile that [`decode`] would refuse is refused).
pub fn encode(p: &Profile) -> Result<Vec<u8>, ProfileError> {
    p.validate()?;
    let mut o = Vec::new();
    o.extend_from_slice(&MAGIC);
    o.extend_from_slice(&VERSION.to_le_bytes());
    o.extend_from_slice(&(p.roles.len() as u16).to_le_bytes());
    o.extend_from_slice(&(p.chains.len() as u16).to_le_bytes());
    o.extend_from_slice(&p.root.to_le_bytes());
    o.extend_from_slice(&p.hips.to_le_bytes());
    let name = |o: &mut Vec<u8>, s: &str| {
        debug_assert!(s.len() <= MAX_NAME);
        o.push(s.len() as u8);
        o.extend_from_slice(s.as_bytes());
    };
    name(&mut o, &p.name);
    for r in &p.roles {
        name(&mut o, &r.name);
        o.extend_from_slice(&r.mirror.to_le_bytes());
        o.push(r.flip.map_or(FLIP_AUTO, |f| f as u8));
        let mut flags = 0;
        if r.range.is_some() {
            flags |= ROLE_RANGE;
        }
        if r.required {
            flags |= ROLE_REQUIRED;
        }
        o.push(flags);
        if let Some(g) = &r.range {
            for v in [g.swing_y, g.swing_z, g.twist_min, g.twist_max] {
                o.extend_from_slice(&v.to_le_bytes());
            }
        }
    }
    for c in &p.chains {
        name(&mut o, &c.name);
        o.push(c.kind as u8);
        o.push(if c.ik { CHAIN_IK } else { 0 });
        o.extend_from_slice(&(c.roles.len() as u16).to_le_bytes());
        for &r in &c.roles {
            o.extend_from_slice(&r.to_le_bytes());
        }
    }
    Ok(o)
}
