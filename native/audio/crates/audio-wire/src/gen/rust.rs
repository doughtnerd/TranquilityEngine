//! Rust emitter (lead-owned, A0.2-GEN): writes `src/generated.rs`.
//!
//! Surface: `pub const` for every schema constant; `pub mod kind`, `pub mod op`; one module per enum;
//! error codes as `ERR_*: i32`; bit masks as `<RECORD>_<FIELD>_<BIT>`; one plain struct per record,
//! body, header and group item, each with
//! `write(&self, out: &mut [u8], base: usize) -> Result<usize, i32>` (bytes written; opcode records
//! write their head, bodies write only the body at the spec's absolute offsets, so `base` is the
//! message start) and `read(buf: &[u8], base: usize) -> Result<(Self, usize), i32>` (value and bytes
//! consumed). Group counts are derived on write and not stored. `StatusBlock` writes and reads a whole
//! STATUS message. Errors are the `ERR_*` codes; nothing here panics or reads out of bounds.

use super::layout::*;
use crate::model::*;

const KEYWORDS: &[&str] = &[
    "type", "loop", "ref", "mod", "match", "move", "mut", "fn", "in", "as", "if", "else", "for", "while", "where", "use", "pub",
    "self", "super", "static", "struct", "trait", "true", "false", "impl", "enum", "const", "crate", "dyn", "extern", "let",
    "return", "unsafe", "async", "await", "box", "do", "final", "macro", "override", "priv", "try", "typeof", "unsized",
    "virtual", "yield", "abstract", "become",
];

fn ident(name: &str) -> String {
    let s = snake(name);
    if KEYWORDS.contains(&s.as_str()) {
        format!("{s}_")
    } else {
        s
    }
}

fn rty(t: Ty) -> &'static str {
    match t {
        Ty::U8 => "u8",
        Ty::U16 => "u16",
        Ty::U32 => "u32",
        Ty::I32 => "i32",
        Ty::F32 => "f32",
        Ty::F64 => "f64",
    }
}

fn field_ty(f: &Field) -> String {
    if f.count == 1 {
        rty(f.ty).to_string()
    } else {
        format!("[{}; {}]", rty(f.ty), f.count)
    }
}

fn doc(out: &mut String, indent: &str, text: &str) {
    if !text.is_empty() {
        out.push_str(&format!("{indent}/// {text}\n"));
    }
}

fn write_line(p: &Placed, access: &str) -> String {
    let f = &p.field;
    let t = rty(f.ty);
    if f.count == 1 {
        format!("        put_{t}(out, base + {}, {access});\n", p.offset)
    } else {
        format!(
            "        for i in 0..{n} {{ put_{t}(out, base + {o} + i * {sz}, {access}[i]); }}\n",
            n = f.count,
            o = p.offset,
            sz = f.ty.bytes()
        )
    }
}

fn read_expr(p: &Placed) -> String {
    let f = &p.field;
    let t = rty(f.ty);
    if f.count == 1 {
        format!("get_{t}(buf, base + {})", p.offset)
    } else {
        format!(
            "{{ let mut a = [0 as {t}; {n}]; for i in 0..{n} {{ a[i] = get_{t}(buf, base + {o} + i * {sz}); }} a }}",
            n = f.count,
            o = p.offset,
            sz = f.ty.bytes()
        )
    }
}

/// Emit the struct, `write` and `read` of an item and (first) its group items.
/// `head`: opcode id to write/check in the record head (the item also stores `voice_id`, `frame_offset`).
fn emit_item(out: &mut String, it: &Item, head: Option<(u16, &str)>, text: &str) {
    if let Some(g) = &it.group {
        emit_item(out, &g.item, None, "");
    }
    doc(out, "", text);
    out.push_str("#[derive(Clone, Debug, Default, PartialEq)]\npub struct ");
    out.push_str(&it.name);
    out.push_str(" {\n");
    if head.is_some() {
        out.push_str("    pub voice_id: u32,\n    pub frame_offset: u32,\n");
    }
    for p in it.stored() {
        doc(out, "    ", p.field.doc);
        out.push_str(&format!("    pub {}: {},\n", ident(p.field.name), field_ty(&p.field)));
    }
    if let Some(g) = &it.group {
        out.push_str(&format!("    pub {}: Vec<{}>,\n", ident(g.name), g.item.name));
    }
    for a in &it.arrays {
        doc(out, "    ", a.doc);
        out.push_str(&format!("    pub {}: Vec<{}>,\n", ident(a.name), rty(a.ty)));
    }
    out.push_str("}\n\n");

    out.push_str(&format!("impl {} {{\n    pub const FIXED_END: usize = {};\n", it.name, it.fixed_end));
    if let Some((id, opname)) = head {
        out.push_str(&format!("    pub const OPCODE: u16 = {id}; // {opname}\n"));
    }
    // write
    out.push_str("    pub fn write(&self, out: &mut [u8], base: usize) -> Result<usize, i32> {\n");
    out.push_str("        if base + Self::FIXED_END > out.len() {\n            return Err(ERR_OVERSIZE);\n        }\n");
    for p in &it.fields {
        if it.is_derived(p.field.name) {
            let (list, max) = match it.array_of(p.field.name) {
                Some(a) => (a.name, a.max),
                None => {
                    let g = it.group.as_ref().unwrap();
                    (g.name, g.max)
                }
            };
            let t = rty(p.field.ty);
            if max > 0 {
                out.push_str(&format!("        if self.{}.len() > {max} {{\n            return Err(ERR_OVERSIZE);\n        }}\n", ident(list)));
            }
            out.push_str(&format!(
                "        put_{t}(out, base + {}, {t}::try_from(self.{}.len()).map_err(|_| ERR_OVERSIZE)?);\n",
                p.offset,
                ident(list)
            ));
        } else {
            out.push_str(&write_line(p, &format!("self.{}", ident(p.field.name))));
        }
    }
    out.push_str("        let mut cur = base + Self::FIXED_END;\n");
    if let Some(g) = &it.group {
        out.push_str(&format!("        for item in &self.{} {{\n            cur += item.write(out, cur)?;\n        }}\n", ident(g.name)));
    }
    for a in &it.arrays {
        let t = rty(a.ty);
        let sz = a.ty.bytes();
        out.push_str(&format!(
            "        let padded = (self.{n}.len() * {sz} + 3) & !3;\n        if cur + padded > out.len() {{\n            return Err(ERR_OVERSIZE);\n        }}\n        for (i, v) in self.{n}.iter().enumerate() {{\n            put_{t}(out, cur + i * {sz}, *v);\n        }}\n        out[cur + self.{n}.len() * {sz}..cur + padded].fill(0);\n        cur += padded;\n",
            n = ident(a.name)
        ));
    }
    if head.is_some() {
        out.push_str(
            "        let total = cur - base;\n        if total % 4 != 0 || total / 4 > u16::MAX as usize {\n            return Err(ERR_OVERSIZE);\n        }\n",
        );
        out.push_str(&format!(
            "        put_u16(out, base + RecordHead::OPCODE_AT, Self::OPCODE);\n        put_u16(out, base + RecordHead::WORDS_AT, (total / 4) as u16);\n        put_u32(out, base + RecordHead::VOICE_ID_AT, self.voice_id);\n        put_u32(out, base + RecordHead::FRAME_OFFSET_AT, self.frame_offset);\n"
        ));
    }
    out.push_str("        Ok(cur - base)\n    }\n");
    // read
    out.push_str("    pub fn read(buf: &[u8], base: usize) -> Result<(Self, usize), i32> {\n");
    if head.is_some() {
        out.push_str(
            "        let (head, _) = RecordHead::read(buf, base)?;\n        if head.opcode != Self::OPCODE {\n            return Err(ERR_MALFORMED);\n        }\n        let limit = base + head.words as usize * 4;\n        if limit > buf.len() {\n            return Err(ERR_TRUNCATED);\n        }\n",
        );
    } else {
        out.push_str("        let limit = buf.len();\n");
    }
    out.push_str("        Self::read_to(buf, base, limit)\n    }\n");
    out.push_str("    fn read_to(buf: &[u8], base: usize, limit: usize) -> Result<(Self, usize), i32> {\n");
    out.push_str("        if base.checked_add(Self::FIXED_END).map_or(true, |e| e > limit) {\n            return Err(ERR_TRUNCATED);\n        }\n");
    if head.is_some() {
        out.push_str("        let (head, _) = RecordHead::read(buf, base)?;\n");
    }
    for p in &it.fields {
        out.push_str(&format!("        let {} = {};\n", ident(p.field.name), read_expr(p)));
    }
    out.push_str("        let mut cur = base + Self::FIXED_END;\n");
    if let Some(g) = &it.group {
        let cnt = ident(g.count_field);
        if g.max > 0 {
            out.push_str(&format!("        if {cnt} as usize > {} {{\n            return Err(ERR_MALFORMED);\n        }}\n", g.max));
        }
        out.push_str(&format!(
            "        let count = {cnt} as usize;\n        if count.checked_mul({}).map_or(true, |n| n > limit - cur) {{\n            return Err(ERR_TRUNCATED);\n        }}\n",
            g.item.fixed_end
        ));
        out.push_str(&format!("        let mut {} = Vec::with_capacity(count);\n", ident(g.name)));
        out.push_str(&format!(
            "        for _ in 0..count {{\n            let (item, n) = {}::read_to(buf, cur, limit)?;\n            cur += n;\n            {}.push(item);\n        }}\n",
            g.item.name,
            ident(g.name)
        ));
    }
    for a in &it.arrays {
        let t = rty(a.ty);
        let sz = a.ty.bytes();
        let cnt = ident(a.count_field);
        if a.max > 0 {
            out.push_str(&format!("        if {cnt} as usize > {} {{\n            return Err(ERR_MALFORMED);\n        }}\n", a.max));
        }
        out.push_str(&format!(
            "        let padded = ({cnt} as usize).checked_mul({sz}).and_then(|n| n.checked_add(3)).map(|n| n & !3).ok_or(ERR_TRUNCATED)?;\n        if padded > limit - cur {{\n            return Err(ERR_TRUNCATED);\n        }}\n        let mut {n} = Vec::with_capacity({cnt} as usize);\n        for i in 0..{cnt} as usize {{\n            {n}.push(get_{t}(buf, cur + i * {sz}));\n        }}\n        cur += padded;\n",
            n = ident(a.name)
        ));
    }
    if head.is_some() {
        out.push_str("        if cur > limit {\n            return Err(ERR_MALFORMED);\n        }\n        let cur = limit; // appended words of a newer minor are skipped\n");
    }
    out.push_str("        Ok((Self {\n");
    if head.is_some() {
        out.push_str("            voice_id: head.voice_id,\n            frame_offset: head.frame_offset,\n");
    }
    for p in it.stored() {
        out.push_str(&format!("            {},\n", ident(p.field.name)));
    }
    if let Some(g) = &it.group {
        out.push_str(&format!("            {},\n", ident(g.name)));
    }
    for a in &it.arrays {
        out.push_str(&format!("            {},\n", ident(a.name)));
    }
    out.push_str("        }, cur - base))\n    }\n}\n\n");
}

fn emit_bits(out: &mut String, owner: &str, fields: &[Field]) {
    for f in fields {
        for b in f.bits {
            let name = format!("{}_{}_{}", screaming(owner), screaming(f.name), screaming(b.name));
            let t = rty(f.ty);
            let mask: u64 = ((1u64 << b.width) - 1) << b.lo;
            if b.width == 1 {
                doc(out, "", b.doc);
                out.push_str(&format!("pub const {name}: {t} = {mask:#x};\n"));
            } else {
                doc(out, "", b.doc);
                out.push_str(&format!("pub const {name}_SHIFT: u32 = {};\npub const {name}_MASK: {t} = {mask:#x};\n", b.lo));
            }
        }
    }
}

const HELPERS: &str = r#"#[inline]
fn put_u8(out: &mut [u8], off: usize, v: u8) { out[off] = v; }
#[inline]
fn put_u16(out: &mut [u8], off: usize, v: u16) { out[off..off + 2].copy_from_slice(&v.to_le_bytes()); }
#[inline]
fn put_u32(out: &mut [u8], off: usize, v: u32) { out[off..off + 4].copy_from_slice(&v.to_le_bytes()); }
#[inline]
fn put_i32(out: &mut [u8], off: usize, v: i32) { out[off..off + 4].copy_from_slice(&v.to_le_bytes()); }
#[inline]
fn put_f32(out: &mut [u8], off: usize, v: f32) { out[off..off + 4].copy_from_slice(&v.to_le_bytes()); }
#[inline]
fn put_f64(out: &mut [u8], off: usize, v: f64) { out[off..off + 8].copy_from_slice(&v.to_le_bytes()); }
#[inline]
fn get_u8(buf: &[u8], off: usize) -> u8 { buf[off] }
#[inline]
fn get_u16(buf: &[u8], off: usize) -> u16 { u16::from_le_bytes(buf[off..off + 2].try_into().unwrap()) }
#[inline]
fn get_u32(buf: &[u8], off: usize) -> u32 { u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) }
#[inline]
fn get_i32(buf: &[u8], off: usize) -> i32 { i32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) }
#[inline]
fn get_f32(buf: &[u8], off: usize) -> f32 { f32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) }
#[inline]
fn get_f64(buf: &[u8], off: usize) -> f64 { f64::from_le_bytes(buf[off..off + 8].try_into().unwrap()) }

"#;

pub fn emit(schema: &Schema, hash_hex: &str) -> Result<String, String> {
    let mut o = String::new();
    o.push_str("// @generated by `gen_wire` (task A0.2, contract K1). Do not edit: change the schema and rerun\n");
    o.push_str("// `cargo run --manifest-path native/audio/crates/audio-wire/Cargo.toml --bin gen_wire`.\n");
    o.push_str("#![allow(clippy::all, dead_code, unused_mut)]\n\n");
    o.push_str(&format!("/// First 16 bytes of the schema's SHA-256 (hex: {hash_hex}).\npub const SCHEMA_HASH: [u8; 16] = [\n"));
    for i in 0..16 {
        o.push_str(&format!("    0x{},\n", &hash_hex[i * 2..i * 2 + 2]));
    }
    o.push_str("];\npub const SCHEMA_HASH_HEX: &str = \"");
    o.push_str(hash_hex);
    o.push_str("\";\n\n");

    for c in schema.constants {
        doc(&mut o, "", c.doc);
        if c.name.starts_with("ERR_") {
            o.push_str(&format!("pub const {}: i32 = {};\n", c.name, c.value));
        } else if c.value > u32::MAX as u64 {
            o.push_str(&format!("pub const {}: u64 = {:#x};\n", c.name, c.value));
        } else {
            o.push_str(&format!("pub const {}: u32 = {:#x};\n", c.name, c.value));
        }
    }
    o.push('\n');
    for e in schema.errors {
        doc(&mut o, "", e.doc);
        o.push_str(&format!("pub const ERR_{}: i32 = {};\n", e.name, e.value));
    }
    o.push_str("\npub mod kind {\n");
    for k in schema.kinds {
        o.push_str(&format!("    pub const {}: u16 = {};\n", k.name, k.id));
    }
    o.push_str("}\n\npub mod op {\n");
    for p in schema.opcodes {
        o.push_str(&format!("    pub const {}: u16 = {:#04x};\n", p.name, p.id));
    }
    o.push_str("}\n\n");
    for e in schema.enums {
        doc(&mut o, "", e.doc);
        o.push_str(&format!("pub mod {} {{\n", snake(e.name)));
        for (n, v, d) in e.variants {
            doc(&mut o, "    ", d);
            o.push_str(&format!("    pub const {}: u32 = {};\n", screaming(n), v));
        }
        o.push_str("}\n\n");
    }

    o.push_str(HELPERS);

    // Envelope, record head, batch header, HRIR header.
    let (env, _) = resolve(0, schema.envelope)?;
    let env_item = Item::plain("Envelope", env, 16);
    emit_item(&mut o, &env_item, None, "The 16-byte envelope of every message.");
    o.push_str("impl Envelope {\n    /// An envelope for `kind` with this version, `seq` and `body_bytes`.\n    pub fn new(kind: u16, seq: u32, body_bytes: u32) -> Envelope {\n        Envelope { magic: MAGIC, version: ((VERSION_MAJOR << 8) | VERSION_MINOR) as u16, kind, seq, body_bytes }\n    }\n}\n\n");

    let (head, _) = resolve(0, schema.record_head)?;
    let head_item = Item::plain("RecordHead", head.clone(), 12);
    emit_item(&mut o, &head_item, None, "The 12-byte head of every command record.");
    o.push_str("impl RecordHead {\n");
    for p in &head {
        o.push_str(&format!("    pub const {}_AT: usize = {};\n", screaming(p.field.name), p.offset));
    }
    o.push_str("}\n\n");

    let batch_item = build_item("BatchHeader", 16, schema.batch_header, None)?;
    emit_item(&mut o, &batch_item, None, "Body header of BATCH (kind 1) and REPLAY (kind 12); records follow.");
    emit_bits(&mut o, "BATCH_HEADER", schema.batch_header);
    let hrir = build_item("HrirHeader", 0, schema.hrir_header, None)?;
    emit_item(&mut o, &hrir, None, "First-chunk header of a format = 2 (HRIR) CLIP_CHUNK payload.");
    for b in schema.blob_headers {
        emit_bits(&mut o, &screaming(b.name), b.fields);
        emit_item(&mut o, &build_item(b.name, 0, b.fields, None)?, None, b.doc);
    }

    for k in schema.kinds {
        emit_bits(&mut o, k.name, k.body.fields);
        if k.name == "STATUS" || k.body.fields.is_empty() || matches!(k.body.tail, Tail::Records) {
            continue;
        }
        emit_item(&mut o, &kind_item(k)?, None, k.doc);
    }
    for p in schema.opcodes {
        emit_bits(&mut o, p.name, p.payload.fields);
        if !p.sent {
            continue;
        }
        emit_item(&mut o, &opcode_item(p)?, Some((p.id, p.name)), p.doc);
    }
    emit_status(&mut o, schema)?;
    Ok(o)
}

fn emit_status(o: &mut String, schema: &Schema) -> Result<(), String> {
    let st = &schema.status;
    emit_bits(o, "STATUS", st.fields);
    let counts: Vec<&str> = st.sections.iter().map(|s| s.count_field).collect();
    let (placed, _) = resolve(16, st.fields)?;
    for s in st.sections {
        if s.item.len() > 1 {
            let it = build_item(&format!("Status{}Item", pascal(s.name)), 0, s.item, None)?;
            emit_item(o, &it, None, s.doc);
        }
    }
    o.push_str("/// A whole STATUS message (kind 9), envelope included.\n#[derive(Clone, Debug, Default, PartialEq)]\npub struct StatusBlock {\n");
    for p in placed.iter().filter(|p| !counts.contains(&p.field.name)) {
        doc(o, "    ", p.field.doc);
        o.push_str(&format!("    pub {}: {},\n", ident(p.field.name), field_ty(&p.field)));
    }
    for s in st.sections {
        let ty = if s.item.len() == 1 { rty(s.item[0].ty).to_string() } else { format!("Status{}Item", pascal(s.name)) };
        doc(o, "    ", s.doc);
        o.push_str(&format!("    /// At most {} per block.\n    pub {}: Vec<{}>,\n", s.max, ident(s.name), ty));
    }
    o.push_str("}\n\nimpl StatusBlock {\n");
    // write
    o.push_str("    /// Write the whole message at `base` (envelope first); returns the bytes written.\n");
    o.push_str("    pub fn write(&self, out: &mut [u8], base: usize, seq: u32) -> Result<usize, i32> {\n");
    o.push_str(&format!("        if base + {} > out.len() {{\n            return Err(ERR_OVERSIZE);\n        }}\n", st.header_bytes));
    for p in &placed {
        if let Some(s) = st.sections.iter().find(|s| s.count_field == p.field.name) {
            let t = rty(p.field.ty);
            o.push_str(&format!(
                "        if self.{n}.len() > {m} {{\n            return Err(ERR_OVERSIZE);\n        }}\n        put_{t}(out, base + {off}, self.{n}.len() as {t});\n",
                n = ident(s.name),
                m = s.max,
                off = p.offset
            ));
        } else {
            o.push_str(&write_line(p, &format!("self.{}", ident(p.field.name))));
        }
    }
    o.push_str(&format!("        let mut cur = base + {};\n", st.header_bytes));
    for s in st.sections {
        let isz: u32 = s.item.iter().map(|f| f.bytes()).sum();
        o.push_str(&format!(
            "        if cur + self.{n}.len() * {isz} > out.len() {{\n            return Err(ERR_OVERSIZE);\n        }}\n",
            n = ident(s.name)
        ));
        if s.item.len() == 1 {
            let t = rty(s.item[0].ty);
            o.push_str(&format!("        for v in &self.{} {{\n            put_{t}(out, cur, *v);\n            cur += {isz};\n        }}\n", ident(s.name)));
        } else {
            o.push_str(&format!("        for v in &self.{} {{\n            v.write(out, cur)?;\n            cur += {isz};\n        }}\n", ident(s.name)));
        }
    }
    o.push_str("        Envelope::new(kind::STATUS, seq, (cur - base - 16) as u32).write(out, base)?;\n        Ok(cur - base)\n    }\n");
    // read
    o.push_str("    /// Read a whole STATUS message at `base`; the envelope is checked for magic, major and kind.\n");
    o.push_str("    pub fn read(buf: &[u8], base: usize) -> Result<(Self, usize), i32> {\n");
    o.push_str(&format!("        if base.checked_add({}).map_or(true, |e| e > buf.len()) {{\n            return Err(ERR_TRUNCATED);\n        }}\n", st.header_bytes));
    o.push_str("        let (env, _) = Envelope::read(buf, base)?;\n        if env.magic != MAGIC {\n            return Err(ERR_BAD_MAGIC);\n        }\n        if (env.version >> 8) as u32 != VERSION_MAJOR {\n            return Err(ERR_VERSION_MISMATCH);\n        }\n        if env.kind != kind::STATUS {\n            return Err(ERR_MALFORMED);\n        }\n");
    // The body must hold the whole header: `limit - cur` below can't underflow (a short bodyBytes is
    // refused, never a panic).
    o.push_str(&format!("        let limit = base.checked_add(16 + env.body_bytes as usize).filter(|l| *l <= buf.len() && *l >= base + {}).ok_or(ERR_TRUNCATED)?;\n", st.header_bytes));
    for p in &placed {
        o.push_str(&format!("        let {} = {};\n", ident(p.field.name), read_expr(p)));
    }
    o.push_str(&format!("        let mut cur = base + {};\n", st.header_bytes));
    for s in st.sections {
        let isz: u32 = s.item.iter().map(|f| f.bytes()).sum();
        let c = ident(s.count_field);
        o.push_str(&format!(
            "        if {c} as usize > {m} || ({c} as usize) * {isz} > limit - cur {{\n            return Err(ERR_OVERSIZE);\n        }}\n        let mut {n} = Vec::with_capacity({c} as usize);\n",
            m = s.max,
            n = ident(s.name)
        ));
        if s.item.len() == 1 {
            let t = rty(s.item[0].ty);
            o.push_str(&format!("        for _ in 0..{c} {{\n            {n}.push(get_{t}(buf, cur));\n            cur += {isz};\n        }}\n", n = ident(s.name)));
        } else {
            let tn = format!("Status{}Item", pascal(s.name));
            o.push_str(&format!("        for _ in 0..{c} {{\n            let (v, n) = {tn}::read(buf, cur)?;\n            {nm}.push(v);\n            cur += n;\n        }}\n", nm = ident(s.name)));
        }
    }
    o.push_str("        Ok((Self {\n");
    for p in placed.iter().filter(|p| !counts.contains(&p.field.name)) {
        o.push_str(&format!("            {},\n", ident(p.field.name)));
    }
    for s in st.sections {
        o.push_str(&format!("            {},\n", ident(s.name)));
    }
    o.push_str("        }, limit - base))\n    }\n}\n");
    Ok(())
}
