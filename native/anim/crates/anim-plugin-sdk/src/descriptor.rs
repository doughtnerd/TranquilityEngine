//! The descriptor blob: the node kinds a module provides and each one's parameter schema.
//!
//! [`crate::abi::DESCRIBE`] returns a pointer to it. The schema matches the built-in nodes' (ADR
//! 0352's one node catalogue: name, kind, unit, range, default, animatable), so the graph editor
//! generates third-party node cards the same way. The SDK builds the blob at compile time
//! ([`encode`], from each [`crate::Node`]'s [`NodeDesc`]); the loader reads it with
//! [`Descriptor::parse`], which checks everything [`encode`] guarantees.
//!
//! # Layout, version 1 (little-endian, no padding)
//!
//! Header, 16 bytes:
//!
//! | offset | type | field |
//! |---|---|---|
//! | 0 | `[u8; 4]` | magic [`MAGIC`] (`MYND`) |
//! | 4 | u16 | ABI version ([`crate::abi::ABI_VERSION`]) |
//! | 6 | u16 | node count (1 ..= [`MAX_NODES`]) |
//! | 8 | u32 | total length in bytes, header included |
//! | 12 | u32 | reserved, 0 |
//!
//! Then one record per node, each followed by its parameter records:
//!
//! | offset | type | field |
//! |---|---|---|
//! | 0 | u32 | kind: the id [`crate::abi::EVALUATE`] receives; unique in the module, stable across versions (graphs store it) |
//! | 4 | u8 | pose inputs (0 ..= [`crate::abi::MAX_INPUTS`]) |
//! | 5 | u8 | flags: [`NODE_NEEDS_SKELETON`] |
//! | 6 | u16 | parameter count (0 ..= [`MAX_PARAMS`]) |
//! | 8 | u32 | per-instance state bytes (0 ..= [`crate::abi::MAX_STATE_BYTES`]) |
//! | 12 | u8 | name length `n` |
//! | 13 | `n` bytes | name ([`valid_name`]), unique in the module |
//!
//! A parameter record:
//!
//! | offset | type | field |
//! |---|---|---|
//! | 0 | u8 | kind ([`ParamKind`]; the same ids as `anim-format`'s `ParamType`) |
//! | 1 | u8 | flags: [`PARAM_ANIMATABLE`] |
//! | 2 | u8 | unit ([`Unit`]) |
//! | 3 | u8 | name length `n` |
//! | 4 | u32 | minimum: `f32` bits for float, vec2 and vec3 (per component); `i32` for int; 0 for bool and quat |
//! | 8 | u32 | maximum, as the minimum |
//! | 12 | `[u32; 4]` | default, in the kind's words ([`ParamKind::words`]); unused words 0 |
//! | 28 | `n` bytes | name ([`valid_name`]), unique in the node |
//!
//! Ranges hold `min <= default <= max` (every component), and float values are finite.

use crate::abi::{ABI_VERSION, MAX_INPUTS, MAX_STATE_BYTES};

/// The blob's first four bytes.
pub const MAGIC: [u8; 4] = *b"MYND";
/// Header bytes.
pub const HEADER_BYTES: usize = 16;
/// Node record bytes before the name.
pub const NODE_FIXED_BYTES: usize = 13;
/// Parameter record bytes before the name.
pub const PARAM_FIXED_BYTES: usize = 28;
/// Nodes per module.
pub const MAX_NODES: usize = 256;
/// Parameters per node.
pub const MAX_PARAMS: usize = 64;
/// Bytes per node or parameter name.
pub const MAX_NAME_BYTES: usize = 64;

/// Node flag: the node reads the skeleton's parent indices (`parents` is passed).
pub const NODE_NEEDS_SKELETON: u8 = 1;
const NODE_FLAGS: u8 = NODE_NEEDS_SKELETON;
/// Parameter flag: tracks and computed parameters may drive it per frame (0352).
pub const PARAM_ANIMATABLE: u8 = 1;
const PARAM_FLAGS: u8 = PARAM_ANIMATABLE;

/// A parameter's value type; ids match `anim-format`'s `ParamType` (which also has `Node`, a node
/// reference third-party nodes can't take).
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ParamKind {
    /// One `f32`.
    Float = 0,
    /// One `i32`.
    Int = 1,
    /// 0 or 1.
    Bool = 2,
    /// Two `f32`.
    Vec2 = 3,
    /// Three `f32`.
    Vec3 = 4,
    /// Four `f32`, `x y z w`, a unit quaternion.
    Quat = 5,
}

impl ParamKind {
    /// The kind stored as `v`.
    pub const fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => ParamKind::Float,
            1 => ParamKind::Int,
            2 => ParamKind::Bool,
            3 => ParamKind::Vec2,
            4 => ParamKind::Vec3,
            5 => ParamKind::Quat,
            _ => return None,
        })
    }

    /// `u32` words a value takes in a parameter block.
    pub const fn words(self) -> usize {
        match self {
            ParamKind::Float | ParamKind::Int | ParamKind::Bool => 1,
            ParamKind::Vec2 => 2,
            ParamKind::Vec3 => 3,
            ParamKind::Quat => 4,
        }
    }

    /// Whether the value's words are `f32`s.
    pub const fn is_float(self) -> bool {
        matches!(
            self,
            ParamKind::Float | ParamKind::Vec2 | ParamKind::Vec3 | ParamKind::Quat
        )
    }
}

/// The unit a parameter is shown in (the editor's cards label and format by it).
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Unit {
    /// A plain number.
    None = 0,
    /// Seconds.
    Seconds = 1,
    /// Metres.
    Meters = 2,
    /// Degrees.
    Degrees = 3,
    /// Radians.
    Radians = 4,
    /// A 0–1 weight or ratio.
    Ratio = 5,
    /// Percent.
    Percent = 6,
    /// Hertz (cycles per second).
    Hertz = 7,
    /// Metres per second.
    MetersPerSecond = 8,
    /// Degrees per second.
    DegreesPerSecond = 9,
    /// A multiplier (×).
    Multiplier = 10,
}

impl Unit {
    /// The unit stored as `v`.
    pub const fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Unit::None,
            1 => Unit::Seconds,
            2 => Unit::Meters,
            3 => Unit::Degrees,
            4 => Unit::Radians,
            5 => Unit::Ratio,
            6 => Unit::Percent,
            7 => Unit::Hertz,
            8 => Unit::MetersPerSecond,
            9 => Unit::DegreesPerSecond,
            10 => Unit::Multiplier,
            _ => return None,
        })
    }
}

/// One parameter's schema. Build it with the `const` constructors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParamDesc {
    pub name: &'static str,
    pub kind: ParamKind,
    pub unit: Unit,
    /// [`PARAM_ANIMATABLE`] or 0.
    pub flags: u8,
    /// Minimum and maximum words (see the layout table).
    pub min: u32,
    pub max: u32,
    /// The default, in the kind's words.
    pub default: [u32; 4],
}

impl ParamDesc {
    const fn new(
        name: &'static str,
        kind: ParamKind,
        unit: Unit,
        min: u32,
        max: u32,
        default: [u32; 4],
    ) -> Self {
        Self {
            name,
            kind,
            unit,
            flags: 0,
            min,
            max,
            default,
        }
    }

    /// A float in `[min, max]`.
    pub const fn float(name: &'static str, unit: Unit, min: f32, max: f32, default: f32) -> Self {
        Self::new(
            name,
            ParamKind::Float,
            unit,
            min.to_bits(),
            max.to_bits(),
            [default.to_bits(), 0, 0, 0],
        )
    }

    /// An integer in `[min, max]`.
    pub const fn int(name: &'static str, min: i32, max: i32, default: i32) -> Self {
        Self::new(
            name,
            ParamKind::Int,
            Unit::None,
            min as u32,
            max as u32,
            [default as u32, 0, 0, 0],
        )
    }

    /// A boolean.
    pub const fn bool(name: &'static str, default: bool) -> Self {
        Self::new(
            name,
            ParamKind::Bool,
            Unit::None,
            0,
            0,
            [default as u32, 0, 0, 0],
        )
    }

    /// A 2-vector whose components lie in `[min, max]`.
    pub const fn vec2(
        name: &'static str,
        unit: Unit,
        min: f32,
        max: f32,
        default: [f32; 2],
    ) -> Self {
        let d = [default[0].to_bits(), default[1].to_bits(), 0, 0];
        Self::new(name, ParamKind::Vec2, unit, min.to_bits(), max.to_bits(), d)
    }

    /// A 3-vector whose components lie in `[min, max]`.
    pub const fn vec3(
        name: &'static str,
        unit: Unit,
        min: f32,
        max: f32,
        default: [f32; 3],
    ) -> Self {
        let d = [
            default[0].to_bits(),
            default[1].to_bits(),
            default[2].to_bits(),
            0,
        ];
        Self::new(name, ParamKind::Vec3, unit, min.to_bits(), max.to_bits(), d)
    }

    /// A rotation (`x y z w`).
    pub const fn quat(name: &'static str, default: [f32; 4]) -> Self {
        let d = [
            default[0].to_bits(),
            default[1].to_bits(),
            default[2].to_bits(),
            default[3].to_bits(),
        ];
        Self::new(name, ParamKind::Quat, Unit::None, 0, 0, d)
    }

    /// Marks the parameter animatable.
    pub const fn animatable(mut self) -> Self {
        self.flags |= PARAM_ANIMATABLE;
        self
    }

    /// Whether tracks may drive it.
    pub const fn is_animatable(&self) -> bool {
        self.flags & PARAM_ANIMATABLE != 0
    }
}

/// One node kind's description. [`crate::Node::DESC`] builds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeDesc {
    pub kind: u32,
    pub name: &'static str,
    pub inputs: u8,
    /// [`NODE_NEEDS_SKELETON`] or 0.
    pub flags: u8,
    pub params: &'static [ParamDesc],
    pub state_bytes: u32,
}

/// `u32` words of one instance's parameter block.
pub const fn param_words(params: &[ParamDesc]) -> usize {
    let mut n = 0;
    let mut i = 0;
    while i < params.len() {
        n += params[i].kind.words();
        i += 1;
    }
    n
}

/// The first word of parameter `index` in a block.
pub const fn param_offset(params: &[ParamDesc], index: usize) -> usize {
    let mut n = 0;
    let mut i = 0;
    while i < index {
        n += params[i].kind.words();
        i += 1;
    }
    n
}

/// Whether `name` is a valid node or parameter name: 1 ..= [`MAX_NAME_BYTES`] bytes of ASCII
/// letters, digits and `_`, not starting with a digit.
pub const fn valid_name(name: &[u8]) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_BYTES || name[0].is_ascii_digit() {
        return false;
    }
    let mut i = 0;
    while i < name.len() {
        let c = name[i];
        if !(c.is_ascii_alphanumeric() || c == b'_') {
            return false;
        }
        i += 1;
    }
    true
}

const fn bytes_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

const fn finite(bits: u32) -> bool {
    f32::from_bits(bits).is_finite()
}

/// Checks one parameter's range and default: `None` when valid, else the problem.
const fn param_problem(
    kind: ParamKind,
    min: u32,
    max: u32,
    default: [u32; 4],
) -> Option<DescriptorError> {
    let words = kind.words();
    let mut w = words;
    while w < 4 {
        if default[w] != 0 {
            return Some(DescriptorError::BadDefault);
        }
        w += 1;
    }
    match kind {
        ParamKind::Float | ParamKind::Vec2 | ParamKind::Vec3 => {
            if !finite(min) || !finite(max) || f32::from_bits(min) > f32::from_bits(max) {
                return Some(DescriptorError::BadRange);
            }
            let mut i = 0;
            while i < words {
                let d = default[i];
                if !finite(d)
                    || f32::from_bits(d) < f32::from_bits(min)
                    || f32::from_bits(d) > f32::from_bits(max)
                {
                    return Some(DescriptorError::BadDefault);
                }
                i += 1;
            }
        }
        ParamKind::Int => {
            if (min as i32) > (max as i32) {
                return Some(DescriptorError::BadRange);
            }
            let d = default[0] as i32;
            if d < min as i32 || d > max as i32 {
                return Some(DescriptorError::BadDefault);
            }
        }
        ParamKind::Bool => {
            if min != 0 || max != 0 {
                return Some(DescriptorError::BadRange);
            }
            if default[0] > 1 {
                return Some(DescriptorError::BadDefault);
            }
        }
        ParamKind::Quat => {
            if min != 0 || max != 0 {
                return Some(DescriptorError::BadRange);
            }
            let mut i = 0;
            while i < 4 {
                if !finite(default[i]) {
                    return Some(DescriptorError::BadDefault);
                }
                i += 1;
            }
        }
    }
    None
}

/// Checks a node list the way [`Descriptor::parse`] checks a blob: `None` when valid.
pub const fn nodes_problem(nodes: &[NodeDesc]) -> Option<DescriptorError> {
    if nodes.is_empty() || nodes.len() > MAX_NODES {
        return Some(DescriptorError::BadNodeCount);
    }
    let mut n = 0;
    while n < nodes.len() {
        let node = &nodes[n];
        if !valid_name(node.name.as_bytes()) {
            return Some(DescriptorError::BadName);
        }
        if node.inputs > MAX_INPUTS {
            return Some(DescriptorError::TooManyInputs);
        }
        if node.flags & !NODE_FLAGS != 0 {
            return Some(DescriptorError::UnknownFlags);
        }
        if node.state_bytes > MAX_STATE_BYTES {
            return Some(DescriptorError::StateTooLarge);
        }
        if node.params.len() > MAX_PARAMS {
            return Some(DescriptorError::TooManyParams);
        }
        let mut m = 0;
        while m < n {
            if nodes[m].kind == node.kind {
                return Some(DescriptorError::DuplicateKind);
            }
            if bytes_eq(nodes[m].name.as_bytes(), node.name.as_bytes()) {
                return Some(DescriptorError::DuplicateName);
            }
            m += 1;
        }
        let mut p = 0;
        while p < node.params.len() {
            let param = &node.params[p];
            if !valid_name(param.name.as_bytes()) {
                return Some(DescriptorError::BadName);
            }
            if param.flags & !PARAM_FLAGS != 0 {
                return Some(DescriptorError::UnknownFlags);
            }
            if let Some(e) = param_problem(param.kind, param.min, param.max, param.default) {
                return Some(e);
            }
            let mut q = 0;
            while q < p {
                if bytes_eq(node.params[q].name.as_bytes(), param.name.as_bytes()) {
                    return Some(DescriptorError::DuplicateName);
                }
                q += 1;
            }
            p += 1;
        }
        n += 1;
    }
    None
}

/// The encoded length of `nodes`' blob.
pub const fn encoded_len(nodes: &[NodeDesc]) -> usize {
    let mut len = HEADER_BYTES;
    let mut n = 0;
    while n < nodes.len() {
        len += NODE_FIXED_BYTES + nodes[n].name.len();
        let mut p = 0;
        while p < nodes[n].params.len() {
            len += PARAM_FIXED_BYTES + nodes[n].params[p].name.len();
            p += 1;
        }
        n += 1;
    }
    len
}

const fn put(out: &mut [u8], at: usize, bytes: &[u8]) -> usize {
    let mut i = 0;
    while i < bytes.len() {
        out[at + i] = bytes[i];
        i += 1;
    }
    at + bytes.len()
}

/// Encodes `nodes` into a blob of `N` = [`encoded_len`]`(nodes)` bytes. Panics (a compile error
/// in a `static`) when `nodes` breaks a rule [`Descriptor::parse`] checks.
pub const fn encode<const N: usize>(nodes: &[NodeDesc]) -> [u8; N] {
    if let Some(e) = nodes_problem(nodes) {
        panic!("{}", e.message());
    }
    assert!(N == encoded_len(nodes), "descriptor length");
    let mut out = [0u8; N];
    let mut at = put(&mut out, 0, &MAGIC);
    at = put(&mut out, at, &(ABI_VERSION as u16).to_le_bytes());
    at = put(&mut out, at, &(nodes.len() as u16).to_le_bytes());
    at = put(&mut out, at, &(N as u32).to_le_bytes());
    at = put(&mut out, at, &0u32.to_le_bytes());
    let mut n = 0;
    while n < nodes.len() {
        let node = &nodes[n];
        at = put(&mut out, at, &node.kind.to_le_bytes());
        at = put(&mut out, at, &[node.inputs, node.flags]);
        at = put(&mut out, at, &(node.params.len() as u16).to_le_bytes());
        at = put(&mut out, at, &node.state_bytes.to_le_bytes());
        at = put(&mut out, at, &[node.name.len() as u8]);
        at = put(&mut out, at, node.name.as_bytes());
        let mut p = 0;
        while p < node.params.len() {
            let param = &node.params[p];
            at = put(
                &mut out,
                at,
                &[
                    param.kind as u8,
                    param.flags,
                    param.unit as u8,
                    param.name.len() as u8,
                ],
            );
            at = put(&mut out, at, &param.min.to_le_bytes());
            at = put(&mut out, at, &param.max.to_le_bytes());
            let mut w = 0;
            while w < 4 {
                at = put(&mut out, at, &param.default[w].to_le_bytes());
                w += 1;
            }
            at = put(&mut out, at, param.name.as_bytes());
            p += 1;
        }
        n += 1;
    }
    out
}

/// Why a blob (or a node list) was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DescriptorError {
    /// Shorter than its header or its records, or its length field disagrees.
    Truncated,
    /// The magic isn't [`MAGIC`].
    BadMagic,
    /// An ABI version other than [`ABI_VERSION`].
    UnsupportedVersion,
    /// Reserved bytes aren't 0.
    BadReserved,
    /// No nodes, or more than [`MAX_NODES`].
    BadNodeCount,
    /// A name breaks [`valid_name`].
    BadName,
    /// Two nodes share a kind.
    DuplicateKind,
    /// Two nodes, or two parameters of one node, share a name.
    DuplicateName,
    /// More than [`crate::abi::MAX_INPUTS`] inputs.
    TooManyInputs,
    /// More than [`MAX_PARAMS`] parameters.
    TooManyParams,
    /// More than [`crate::abi::MAX_STATE_BYTES`] state bytes.
    StateTooLarge,
    /// A flag bit this version doesn't define.
    UnknownFlags,
    /// A parameter kind this version doesn't define.
    UnknownParamKind,
    /// A unit this version doesn't define.
    UnknownUnit,
    /// `min > max`, a non-finite bound, or bounds on a kind that has none.
    BadRange,
    /// A default outside its range, non-finite, or with non-zero unused words.
    BadDefault,
    /// Bytes after the last record.
    TrailingBytes,
}

impl DescriptorError {
    /// A one-line description.
    pub const fn message(self) -> &'static str {
        match self {
            DescriptorError::Truncated => "descriptor: truncated or wrong length",
            DescriptorError::BadMagic => "descriptor: bad magic",
            DescriptorError::UnsupportedVersion => "descriptor: unsupported ABI version",
            DescriptorError::BadReserved => "descriptor: reserved bytes not zero",
            DescriptorError::BadNodeCount => "descriptor: node count must be 1..=256",
            DescriptorError::BadName => "descriptor: names are 1..=64 ASCII letters, digits or '_', not starting with a digit",
            DescriptorError::DuplicateKind => "descriptor: two nodes share a kind",
            DescriptorError::DuplicateName => "descriptor: duplicate node or parameter name",
            DescriptorError::TooManyInputs => "descriptor: more than 8 pose inputs",
            DescriptorError::TooManyParams => "descriptor: more than 64 parameters",
            DescriptorError::StateTooLarge => "descriptor: state larger than 64 KiB",
            DescriptorError::UnknownFlags => "descriptor: unknown flag bits",
            DescriptorError::UnknownParamKind => "descriptor: unknown parameter kind",
            DescriptorError::UnknownUnit => "descriptor: unknown unit",
            DescriptorError::BadRange => "descriptor: bad parameter range",
            DescriptorError::BadDefault => "descriptor: bad parameter default",
            DescriptorError::TrailingBytes => "descriptor: bytes after the last record",
        }
    }
}

impl core::fmt::Display for DescriptorError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.message())
    }
}

/// A byte cursor over the blob.
#[derive(Clone, Copy)]
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], DescriptorError> {
        let end = self.at.checked_add(n).ok_or(DescriptorError::Truncated)?;
        let s = self
            .bytes
            .get(self.at..end)
            .ok_or(DescriptorError::Truncated)?;
        self.at = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, DescriptorError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, DescriptorError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32, DescriptorError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn name(&mut self, len: u8) -> Result<&'a str, DescriptorError> {
        let b = self.take(len as usize)?;
        if !valid_name(b) {
            return Err(DescriptorError::BadName);
        }
        // valid_name accepts ASCII only, so this can't fail.
        core::str::from_utf8(b).map_err(|_| DescriptorError::BadName)
    }
}

/// A node record read from a blob.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeView<'a> {
    pub kind: u32,
    pub name: &'a str,
    pub inputs: u8,
    pub flags: u8,
    pub state_bytes: u32,
    param_count: u16,
    params_at: usize,
    bytes: &'a [u8],
}

impl<'a> NodeView<'a> {
    /// Parameter count.
    pub fn param_count(&self) -> usize {
        self.param_count as usize
    }

    /// The parameters, in declared (block) order.
    pub fn params(&self) -> ParamIter<'a> {
        ParamIter {
            cursor: Cursor {
                bytes: self.bytes,
                at: self.params_at,
            },
            left: self.param_count,
        }
    }

    /// `u32` words of one instance's parameter block.
    pub fn param_words(&self) -> usize {
        self.params().checked().map(|p| p.kind.words()).sum()
    }

    /// Whether `parents` is passed.
    pub fn needs_skeleton(&self) -> bool {
        self.flags & NODE_NEEDS_SKELETON != 0
    }
}

/// A parameter record read from a blob.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParamView<'a> {
    pub name: &'a str,
    pub kind: ParamKind,
    pub unit: Unit,
    pub flags: u8,
    pub min: u32,
    pub max: u32,
    pub default: [u32; 4],
}

impl ParamView<'_> {
    /// Whether tracks may drive it.
    pub fn is_animatable(&self) -> bool {
        self.flags & PARAM_ANIMATABLE != 0
    }
}

fn read_param<'a>(c: &mut Cursor<'a>) -> Result<ParamView<'a>, DescriptorError> {
    let kind = ParamKind::from_u8(c.u8()?).ok_or(DescriptorError::UnknownParamKind)?;
    let flags = c.u8()?;
    if flags & !PARAM_FLAGS != 0 {
        return Err(DescriptorError::UnknownFlags);
    }
    let unit = Unit::from_u8(c.u8()?).ok_or(DescriptorError::UnknownUnit)?;
    let name_len = c.u8()?;
    let min = c.u32()?;
    let max = c.u32()?;
    let default = [c.u32()?, c.u32()?, c.u32()?, c.u32()?];
    let name = c.name(name_len)?;
    if let Some(e) = param_problem(kind, min, max, default) {
        return Err(e);
    }
    Ok(ParamView {
        name,
        kind,
        unit,
        flags,
        min,
        max,
        default,
    })
}

fn read_node<'a>(c: &mut Cursor<'a>) -> Result<NodeView<'a>, DescriptorError> {
    let kind = c.u32()?;
    let inputs = c.u8()?;
    let flags = c.u8()?;
    let param_count = c.u16()?;
    let state_bytes = c.u32()?;
    let name_len = c.u8()?;
    let name = c.name(name_len)?;
    if inputs > MAX_INPUTS {
        return Err(DescriptorError::TooManyInputs);
    }
    if flags & !NODE_FLAGS != 0 {
        return Err(DescriptorError::UnknownFlags);
    }
    if param_count as usize > MAX_PARAMS {
        return Err(DescriptorError::TooManyParams);
    }
    if state_bytes > MAX_STATE_BYTES {
        return Err(DescriptorError::StateTooLarge);
    }
    let params_at = c.at;
    let node = NodeView {
        kind,
        name,
        inputs,
        flags,
        state_bytes,
        param_count,
        params_at,
        bytes: c.bytes,
    };
    for (i, p) in node.params().enumerate() {
        let p = p?;
        if node
            .params()
            .take(i)
            .any(|q| q.map(|q| q.name == p.name).unwrap_or(false))
        {
            return Err(DescriptorError::DuplicateName);
        }
    }
    // Skip past the parameters (they were read and checked above).
    for _ in 0..param_count {
        read_param(c)?;
    }
    Ok(node)
}

/// Iterates a node's parameters. Yields `Err` only for a blob [`Descriptor::parse`] didn't accept.
#[derive(Clone)]
pub struct ParamIter<'a> {
    cursor: Cursor<'a>,
    left: u16,
}

impl<'a> Iterator for ParamIter<'a> {
    type Item = Result<ParamView<'a>, DescriptorError>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.left == 0 {
            return None;
        }
        self.left -= 1;
        Some(read_param(&mut self.cursor))
    }
}

impl<'a> ParamIter<'a> {
    /// The parameters of a parsed descriptor, which can't fail.
    pub fn checked(self) -> impl Iterator<Item = ParamView<'a>> {
        self.map_while(Result::ok)
    }
}

/// A parsed, checked descriptor blob. Borrowing, no allocation.
#[derive(Clone, Copy, Debug)]
pub struct Descriptor<'a> {
    bytes: &'a [u8],
    node_count: u16,
}

impl<'a> Descriptor<'a> {
    /// The blob's total length from its first [`HEADER_BYTES`] bytes, after checking the magic and
    /// version: how many bytes the host copies out of the module's memory.
    pub fn total_len(header: &[u8]) -> Result<usize, DescriptorError> {
        let mut c = Cursor {
            bytes: header,
            at: 0,
        };
        if c.take(4)? != MAGIC {
            return Err(DescriptorError::BadMagic);
        }
        if c.u16()? != ABI_VERSION as u16 {
            return Err(DescriptorError::UnsupportedVersion);
        }
        c.u16()?;
        let len = c.u32()? as usize;
        if len < HEADER_BYTES {
            return Err(DescriptorError::Truncated);
        }
        Ok(len)
    }

    /// Parses and checks a whole blob (exactly its total length).
    pub fn parse(bytes: &'a [u8]) -> Result<Self, DescriptorError> {
        let len = Self::total_len(bytes)?;
        if len != bytes.len() {
            return Err(if len > bytes.len() {
                DescriptorError::Truncated
            } else {
                DescriptorError::TrailingBytes
            });
        }
        let mut c = Cursor { bytes, at: 6 };
        let node_count = c.u16()?;
        c.u32()?;
        if c.u32()? != 0 {
            return Err(DescriptorError::BadReserved);
        }
        if node_count == 0 || node_count as usize > MAX_NODES {
            return Err(DescriptorError::BadNodeCount);
        }
        let first = c.at;
        for i in 0..node_count {
            let node = read_node(&mut c)?;
            let mut prev = Cursor { bytes, at: first };
            for _ in 0..i {
                let other = read_node(&mut prev)?;
                if other.kind == node.kind {
                    return Err(DescriptorError::DuplicateKind);
                }
                if other.name == node.name {
                    return Err(DescriptorError::DuplicateName);
                }
            }
        }
        if c.at != bytes.len() {
            return Err(DescriptorError::TrailingBytes);
        }
        Ok(Self { bytes, node_count })
    }

    /// Node count.
    pub fn node_count(&self) -> usize {
        self.node_count as usize
    }

    /// The nodes, in declared order.
    pub fn nodes(&self) -> impl Iterator<Item = NodeView<'a>> + 'a {
        let mut c = Cursor {
            bytes: self.bytes,
            at: HEADER_BYTES,
        };
        // parse() checked every record, so reading can't fail.
        (0..self.node_count).map_while(move |_| read_node(&mut c).ok())
    }

    /// The node of `kind`.
    pub fn node(&self, kind: u32) -> Option<NodeView<'a>> {
        self.nodes().find(|n| n.kind == kind)
    }

    /// The blob's bytes.
    pub fn bytes(&self) -> &'a [u8] {
        self.bytes
    }
}
