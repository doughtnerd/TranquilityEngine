//! Layout resolution, schema validation and the item IR the emitters share (lead-owned, A0.2-GEN).

use crate::model::*;
use std::collections::HashSet;

/// A field with its resolved byte offset (from the start of its record, body or message).
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub field: Field,
    pub offset: u32,
}

/// Assign offsets in order, honouring `Field::at`; error on overlap or misalignment (a field is
/// aligned to its type's size, measured from the enclosing message or item start). Returns the placed
/// fields and the end offset. `start` is the offset of the first field.
pub fn resolve(start: u32, fields: &[Field]) -> Result<(Vec<Placed>, u32), String> {
    let mut cur = start;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for f in fields {
        if !seen.insert(f.name) {
            return Err(format!("duplicate field name {}", f.name));
        }
        if f.count == 0 {
            return Err(format!("field {} has count 0", f.name));
        }
        let off = f.offset.unwrap_or(cur);
        if off < cur {
            return Err(format!("field {} at {} overlaps the previous field (ends at {})", f.name, off, cur));
        }
        if off % f.ty.bytes() != 0 {
            return Err(format!("field {} at {} is not aligned to {}", f.name, off, f.ty.bytes()));
        }
        let width = f.ty.bytes() as u8 * 8;
        for b in f.bits {
            if b.width == 0 || b.lo as u32 + b.width as u32 > width as u32 {
                return Err(format!("bits {} of {} do not fit in {} bits", b.name, f.name, width));
            }
        }
        out.push(Placed { field: *f, offset: off });
        cur = off + f.bytes();
    }
    Ok((out, cur))
}

/// A group of repeated items inside an `Item`.
#[derive(Clone, Debug)]
pub struct Group {
    pub name: &'static str,
    pub count_field: &'static str,
    pub item: Box<Item>,
}

/// A struct-shaped piece of the wire: a body, a record, a header, or a group item.
#[derive(Clone, Debug)]
pub struct Item {
    /// PascalCase type name.
    pub name: String,
    pub fields: Vec<Placed>,
    /// End of the fixed fields (absolute for bodies and records, relative for group items).
    pub fixed_end: u32,
    pub group: Option<Group>,
}

impl Item {
    /// Fields that are the count of this item's group: derived on write, not stored.
    pub fn is_derived(&self, name: &str) -> bool {
        self.group.as_ref().map_or(false, |g| g.count_field == name)
    }
    /// Fields stored in the generated struct.
    pub fn stored(&self) -> impl Iterator<Item = &Placed> {
        self.fields.iter().filter(move |p| !self.is_derived(p.field.name))
    }
}

/// Build an item starting at `start` with an optional repeated group.
pub fn build_item(name: &str, start: u32, fields: &[Field], tail: Option<&Repeat>) -> Result<Item, String> {
    let (placed, end) = resolve(start, fields).map_err(|e| format!("{name}: {e}"))?;
    let group = match tail {
        None => None,
        Some(r) => {
            if !placed.iter().any(|p| p.field.name == r.count_field && p.field.count == 1) {
                return Err(format!("{name}: count field {} of group {} not found", r.count_field, r.name));
            }
            let item = build_item(&format!("{name}{}", pascal(r.name)), 0, r.item, r.then)?;
            if item.fixed_end == 0 {
                return Err(format!("{name}: group {} has empty items", r.name));
            }
            Some(Group { name: r.name, count_field: r.count_field, item: Box::new(item) })
        }
    };
    Ok(Item { name: name.to_string(), fields: placed, fixed_end: end, group })
}

/// The tail's group, if it is a `Repeat`.
pub fn repeat_of(tail: &Tail) -> Option<&'static Repeat> {
    match tail {
        Tail::Repeat(r) => Some(r),
        _ => None,
    }
}

/// `SET_PARAMS` and `setParams` to `SetParams`.
pub fn pascal(s: &str) -> String {
    if s.contains('_') || s.chars().all(|c| !c.is_lowercase()) {
        s.split('_')
            .filter(|p| !p.is_empty())
            .map(|p| {
                let lower = p.to_lowercase();
                let mut c = lower.chars();
                c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
            })
            .collect()
    } else {
        let mut c = s.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    }
}

/// `arenaUsedKB` to `arena_used_kb`, `dirX` to `dir_x`, `SET_PARAMS` to `set_params`.
pub fn snake(s: &str) -> String {
    let ch: Vec<char> = s.chars().collect();
    let mut out = String::new();
    for (i, &c) in ch.iter().enumerate() {
        if c.is_uppercase() && i > 0 && ch[i - 1] != '_' {
            let prev = ch[i - 1];
            let next_lower = ch.get(i + 1).map_or(false, |n| n.is_lowercase());
            if prev.is_lowercase() || prev.is_ascii_digit() || (prev.is_uppercase() && next_lower) {
                out.push('_');
            }
        }
        out.extend(c.to_lowercase());
    }
    out
}

/// `SCREAMING_SNAKE` from any identifier-ish name (non-alphanumerics become `_`).
pub fn screaming(s: &str) -> String {
    snake(s).chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect()
}

/// Every opcode record's item (head not included), start 12.
pub fn opcode_item(op: &Opcode) -> Result<Item, String> {
    build_item(&pascal(op.name), 12, op.payload.fields, repeat_of(&op.payload.tail))
}

/// A kind's body item, start 16 (the envelope is counted in offsets).
pub fn kind_item(k: &Kind) -> Result<Item, String> {
    build_item(&pascal(k.name), 16, k.body.fields, repeat_of(&k.body.tail))
}

/// Validate the whole schema: kind and opcode ids and names unique, `total_bytes` equal to the
/// computed size, the STATUS header exactly `header_bytes` and gap-free with the section count fields
/// present, every group count resolving, error codes negative, envelope and head shapes as the
/// emitters and codec expect.
pub fn validate(schema: &Schema) -> Result<(), String> {
    let (env, env_end) = resolve(0, schema.envelope)?;
    let names: Vec<&str> = env.iter().map(|p| p.field.name).collect();
    if names != ["magic", "version", "kind", "seq", "bodyBytes"] || env_end != 16 {
        return Err(format!("envelope must be magic, version, kind, seq, bodyBytes in 16 bytes (got {names:?}, {env_end} B)"));
    }
    let (head, head_end) = resolve(0, schema.record_head)?;
    let names: Vec<&str> = head.iter().map(|p| p.field.name).collect();
    if names != ["opcode", "words", "voiceId", "frameOffset"] || head_end != 12 {
        return Err(format!("record head must be opcode, words, voiceId, frameOffset in 12 bytes (got {names:?})"));
    }
    let (bh, bh_end) = resolve(16, schema.batch_header)?;
    let names: Vec<&str> = bh.iter().map(|p| p.field.name).collect();
    if names != ["firstFrame", "count", "flags"] || bh_end != 32 {
        return Err(format!("batch header must be firstFrame, count, flags in 16 bytes (got {names:?})"));
    }
    resolve(0, schema.hrir_header)?;

    let mut ids = HashSet::new();
    let mut nm = HashSet::new();
    if schema.kinds.is_empty() {
        return Err("no kinds".into());
    }
    for k in schema.kinds {
        if !ids.insert(k.id) || !nm.insert(k.name) {
            return Err(format!("duplicate kind {} ({})", k.name, k.id));
        }
        kind_item(k)?;
    }
    let mut ids = HashSet::new();
    let mut nm = HashSet::new();
    if schema.opcodes.is_empty() {
        return Err("no opcodes".into());
    }
    for op in schema.opcodes {
        if !ids.insert(op.id) || !nm.insert(op.name) {
            return Err(format!("duplicate opcode {} ({})", op.name, op.id));
        }
        let item = opcode_item(op)?;
        if let Some(want) = op.total_bytes {
            if item.group.is_some() || item.fixed_end != want {
                return Err(format!("opcode {}: spec total {} B, schema {} B", op.name, want, item.fixed_end));
            }
        } else if item.group.is_none() && op.sent_in_m1 {
            return Err(format!("opcode {} has no total_bytes and no group", op.name));
        }
    }

    let st = &schema.status;
    let mut cur = 16;
    for f in st.fields {
        let off = f.offset.ok_or_else(|| format!("status field {} needs .at(offset)", f.name))?;
        if off != cur {
            return Err(format!("status field {} at {}, expected {} (no gaps)", f.name, off, cur));
        }
        cur += f.bytes();
    }
    resolve(16, st.fields)?;
    if cur != st.header_bytes {
        return Err(format!("status header is {cur} B, spec says {}", st.header_bytes));
    }
    for s in st.sections {
        let cf = st.fields.iter().find(|f| f.name == s.count_field).ok_or_else(|| format!("section {}: no count field {}", s.name, s.count_field))?;
        if cf.count != 1 || cf.ty == Ty::F32 || cf.ty == Ty::F64 {
            return Err(format!("section {}: count field {} must be an integer scalar", s.name, s.count_field));
        }
        resolve(0, s.item)?;
        if s.item.is_empty() || s.max == 0 {
            return Err(format!("section {} is empty or has max 0", s.name));
        }
    }
    for e in schema.errors {
        if e.value >= 0 {
            return Err(format!("error code {} must be negative", e.name));
        }
    }
    Ok(())
}
