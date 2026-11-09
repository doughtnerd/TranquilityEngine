//! Interpretive encoder over the schema (lead-owned, A0.2-GEN): the independent path the vectors and
//! the self-checks use. Conventions per subject are in `crate::vector`. It walks the schema tables
//! directly and shares no code with the emitters except `layout::resolve`.

use super::layout::resolve;
use crate::model::*;
use crate::vector::{Subject, VectorCase};

type Vals<'a> = Vec<(&'a str, &'a Value)>;

fn lookup<'a>(vals: &Vals<'a>, name: &str) -> Option<&'a Value> {
    vals.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
}

fn put_scalar(buf: &mut Vec<u8>, off: usize, ty: Ty, v: &Value, what: &str) -> Result<(), String> {
    let n = ty.bytes() as usize;
    if buf.len() < off + n {
        buf.resize(off + n, 0);
    }
    let bytes: Vec<u8> = match (ty, v) {
        (Ty::U8, Value::U(x)) if *x <= u8::MAX as u64 => vec![*x as u8],
        (Ty::U16, Value::U(x)) if *x <= u16::MAX as u64 => (*x as u16).to_le_bytes().to_vec(),
        (Ty::U32, Value::U(x)) if *x <= u32::MAX as u64 => (*x as u32).to_le_bytes().to_vec(),
        (Ty::I32, Value::I(x)) if i32::try_from(*x).is_ok() => (*x as i32).to_le_bytes().to_vec(),
        (Ty::I32, Value::U(x)) if *x <= i32::MAX as u64 => (*x as i32).to_le_bytes().to_vec(),
        (Ty::F32, Value::F(x)) => (*x as f32).to_le_bytes().to_vec(),
        (Ty::F64, Value::F(x)) => x.to_le_bytes().to_vec(),
        (Ty::F32, Value::U(x)) => (*x as f32).to_le_bytes().to_vec(),
        (Ty::F64, Value::U(x)) => (*x as f64).to_le_bytes().to_vec(),
        _ => return Err(format!("{what}: value {v:?} does not fit {ty:?}")),
    };
    buf[off..off + n].copy_from_slice(&bytes);
    Ok(())
}

fn put_field(buf: &mut Vec<u8>, off: usize, f: &Field, v: &Value, what: &str) -> Result<(), String> {
    if f.count == 1 {
        return put_scalar(buf, off, f.ty, v, what);
    }
    match v {
        Value::Arr(a) if a.len() == f.count as usize => {
            for (i, x) in a.iter().enumerate() {
                put_scalar(buf, off + i * f.ty.bytes() as usize, f.ty, x, what)?;
            }
            Ok(())
        }
        _ => Err(format!("{what}: expected an array of {}", f.count)),
    }
}

fn rec_vals<'a>(v: &'a Value) -> Result<Vals<'a>, String> {
    match v {
        Value::Rec(r) => Ok(r.iter().map(|(n, v)| (n.as_str(), v)).collect()),
        _ => Err(format!("expected a record, got {v:?}")),
    }
}

/// Encode `fields` at `base` (offsets from `start`); `derived` names are filled from `counts`.
/// Returns the end offset. Strict: a missing value is an error except for `reserved`; so is an
/// unknown name left over.
fn encode_fields(
    buf: &mut Vec<u8>,
    base: usize,
    start: u32,
    fields: &[Field],
    vals: &Vals,
    derived: &[(&str, u64)],
    what: &str,
) -> Result<usize, String> {
    let (placed, end) = resolve(start, fields)?;
    for p in &placed {
        let off = base + (p.offset - start) as usize;
        if let Some((_, c)) = derived.iter().find(|(n, _)| *n == p.field.name) {
            put_scalar(buf, off, p.field.ty, &Value::U(*c), what)?;
            continue;
        }
        match lookup(vals, p.field.name) {
            Some(v) => put_field(buf, off, &p.field, v, &format!("{what}.{}", p.field.name))?,
            None if p.field.name == "reserved" => {
                if buf.len() < off + p.field.bytes() as usize {
                    buf.resize(off + p.field.bytes() as usize, 0);
                }
            }
            None => return Err(format!("{what}: missing value for {}", p.field.name)),
        }
    }
    let end_abs = base + (end - start) as usize;
    if buf.len() < end_abs {
        buf.resize(end_abs, 0);
    }
    Ok(end_abs)
}

fn check_unknown(vals: &Vals, known: &[&str], extra: &[&str], what: &str) -> Result<(), String> {
    for (n, _) in vals {
        if !known.contains(n) && !extra.contains(n) {
            return Err(format!("{what}: unknown value name {n}"));
        }
    }
    Ok(())
}

/// Encode a counted group (and nested groups) starting at `cur`; returns the end offset.
fn encode_repeat(buf: &mut Vec<u8>, mut cur: usize, r: &Repeat, items: &Value, what: &str) -> Result<usize, String> {
    let Value::Arr(items) = items else { return Err(format!("{what}.{}: expected an array", r.name)) };
    for (i, it) in items.iter().enumerate() {
        let w = format!("{what}.{}[{i}]", r.name);
        let vals = rec_vals(it)?;
        let nested_count = match r.then {
            Some(n) => match lookup(&vals, n.name) {
                Some(Value::Arr(a)) => Some((n.count_field, a.len() as u64)),
                _ => return Err(format!("{w}: missing group {}", n.name)),
            },
            None => None,
        };
        let derived: Vec<(&str, u64)> = nested_count.into_iter().collect();
        let mut known: Vec<&str> = r.item.iter().map(|f| f.name).collect();
        let extra: Vec<&str> = r.then.map(|n| n.name).into_iter().collect();
        known.retain(|k| !derived.iter().any(|(d, _)| d == k));
        check_unknown(&vals, &known, &extra, &w)?;
        cur = encode_fields(buf, cur, 0, r.item, &vals, &derived, &w)?;
        if let Some(n) = r.then {
            cur = encode_repeat(buf, cur, n, lookup(&vals, n.name).unwrap(), &w)?;
        }
    }
    Ok(cur)
}

/// Encode one body (fixed fields at `start`, then the tail). Returns the end offset. `bytes_payload`
/// is appended for `Tail::Bytes`.
fn encode_body(buf: &mut Vec<u8>, base: usize, start: u32, body: &Body, vals: &Vals, what: &str, skip: &[&str]) -> Result<usize, String> {
    let rep = match body.tail {
        Tail::Repeat(r) => Some(r),
        _ => None,
    };
    let derived: Vec<(&str, u64)> = match rep {
        Some(r) => match lookup(vals, r.name) {
            Some(Value::Arr(a)) => vec![(r.count_field, a.len() as u64)],
            _ => return Err(format!("{what}: missing group {}", r.name)),
        },
        None => vec![],
    };
    let mut known: Vec<&str> = body.fields.iter().map(|f| f.name).collect();
    known.retain(|k| !derived.iter().any(|(d, _)| d == k));
    let mut extra: Vec<&str> = skip.to_vec();
    if let Some(r) = rep {
        extra.push(r.name);
    }
    if matches!(body.tail, Tail::Bytes) {
        extra.push("payload");
    }
    check_unknown(vals, &known, &extra, what)?;
    let mut cur = encode_fields(buf, base, start, body.fields, vals, &derived, what)?;
    if let Some(r) = rep {
        cur = encode_repeat(buf, cur, r, lookup(vals, r.name).unwrap(), what)?;
    }
    if matches!(body.tail, Tail::Bytes) {
        if let Some(Value::Arr(a)) = lookup(vals, "payload") {
            for x in a {
                let Value::U(b) = x else { return Err(format!("{what}: payload must be bytes")) };
                if *b > 255 {
                    return Err(format!("{what}: payload byte {b} > 255"));
                }
                buf.push(*b as u8);
            }
            cur = buf.len();
        }
    }
    Ok(cur)
}

fn envelope(schema: &Schema, buf: &mut Vec<u8>, kind: u16, seq: &Value, body_bytes: usize) -> Result<(), String> {
    let c = |n: &str| schema.constants.iter().find(|c| c.name == n).map(|c| c.value).ok_or(format!("constant {n} missing"));
    let version = (c("VERSION_MAJOR")? << 8) | c("VERSION_MINOR")?;
    let vals: Vec<(&str, Value)> = vec![
        ("magic", Value::U(c("MAGIC")?)),
        ("version", Value::U(version)),
        ("kind", Value::U(kind as u64)),
        ("seq", seq.clone()),
        ("bodyBytes", Value::U(body_bytes as u64)),
    ];
    let refs: Vals = vals.iter().map(|(n, v)| (*n, v)).collect();
    encode_fields(buf, 0, 0, schema.envelope, &refs, &[], "envelope").map(|_| ())
}

fn find_op<'a>(schema: &'a Schema, name: &str) -> Result<&'a Opcode, String> {
    schema.opcodes.iter().find(|o| o.name == name).ok_or(format!("no opcode {name}"))
}

/// Encode one record, head included, appending to `buf` at its current length.
fn encode_record(schema: &Schema, buf: &mut Vec<u8>, op: &Opcode, vals: &Vals, what: &str) -> Result<(), String> {
    let base = buf.len();
    let end = encode_body(buf, base, 12, &op.payload, vals, what, &["voiceId", "frameOffset", "op"])?;
    let total = end - base;
    if total % 4 != 0 {
        return Err(format!("{what}: record is {total} B, not whole words"));
    }
    let head: Vec<(&str, Value)> = vec![
        ("opcode", Value::U(op.id as u64)),
        ("words", Value::U((total / 4) as u64)),
        ("voiceId", lookup(vals, "voiceId").cloned().ok_or(format!("{what}: missing voiceId"))?),
        ("frameOffset", lookup(vals, "frameOffset").cloned().ok_or(format!("{what}: missing frameOffset"))?),
    ];
    let refs: Vals = head.iter().map(|(n, v)| (*n, v)).collect();
    encode_fields(buf, base, 0, schema.record_head, &refs, &[], what)?;
    Ok(())
}

fn find_kind<'a>(schema: &'a Schema, name: &str) -> Result<&'a Kind, String> {
    schema.kinds.iter().find(|k| k.name == name).ok_or(format!("no kind {name}"))
}

/// Encode a vector case to bytes (computed fields filled in).
pub fn encode(schema: &Schema, case: &VectorCase) -> Result<Vec<u8>, String> {
    let what = case.name;
    let vals: Vals = case.values.iter().map(|(n, v)| (*n, v)).collect();
    let mut buf = Vec::new();
    match &case.subject {
        Subject::Envelope => {
            check_unknown(&vals, &["magic", "version", "kind", "seq", "bodyBytes"], &[], what)?;
            encode_fields(&mut buf, 0, 0, schema.envelope, &vals, &[], what)?;
        }
        Subject::HrirHeader => {
            check_unknown(&vals, &schema.hrir_header.iter().map(|f| f.name).collect::<Vec<_>>(), &[], what)?;
            encode_fields(&mut buf, 0, 0, schema.hrir_header, &vals, &[], what)?;
        }
        Subject::Opcode(name) => {
            let op = find_op(schema, name)?;
            encode_record(schema, &mut buf, op, &vals, what)?;
        }
        Subject::Kind(name) => {
            let k = find_kind(schema, name)?;
            if matches!(k.body.tail, Tail::Records) || k.name == "STATUS" {
                return Err(format!("{what}: use Subject::Batch / Subject::Status for {name}"));
            }
            let seq = lookup(&vals, "seq").ok_or(format!("{what}: missing seq"))?;
            let end = encode_body(&mut buf, 0, 16, &k.body, &vals, what, &["seq"])?;
            envelope(schema, &mut buf, k.id, seq, end - 16)?;
        }
        Subject::Batch(name) => {
            let k = find_kind(schema, name)?;
            if !matches!(k.body.tail, Tail::Records) {
                return Err(format!("{what}: {name} is not a batch kind"));
            }
            let seq = lookup(&vals, "seq").ok_or(format!("{what}: missing seq"))?;
            let Some(Value::Arr(records)) = lookup(&vals, "records") else { return Err(format!("{what}: missing records")) };
            check_unknown(&vals, &["firstFrame", "flags"], &["seq", "records"], what)?;
            let hv: Vec<(&str, Value)> = vec![
                ("firstFrame", lookup(&vals, "firstFrame").cloned().ok_or("missing firstFrame")?),
                ("count", Value::U(records.len() as u64)),
                ("flags", lookup(&vals, "flags").cloned().ok_or("missing flags")?),
            ];
            let hrefs: Vals = hv.iter().map(|(n, v)| (*n, v)).collect();
            encode_fields(&mut buf, 0, 16, schema.batch_header, &hrefs, &[], what)?;
            for (i, r) in records.iter().enumerate() {
                let rv = rec_vals(r)?;
                let Some(Value::Str(opname)) = lookup(&rv, "op") else { return Err(format!("{what}.records[{i}]: missing op")) };
                encode_record(schema, &mut buf, find_op(schema, opname)?, &rv, &format!("{what}.records[{i}]"))?;
            }
            let end = buf.len();
            envelope(schema, &mut buf, k.id, seq, end - 16)?;
        }
        Subject::Status => {
            let st = &schema.status;
            let k = find_kind(schema, "STATUS")?;
            let seq = lookup(&vals, "seq").ok_or(format!("{what}: missing seq"))?;
            let counts: Vec<(&str, u64)> = st
                .sections
                .iter()
                .map(|s| match lookup(&vals, s.name) {
                    Some(Value::Arr(a)) if a.len() as u32 <= s.max => Ok((s.count_field, a.len() as u64)),
                    Some(Value::Arr(_)) => Err(format!("{what}: section {} over its cap {}", s.name, s.max)),
                    _ => Err(format!("{what}: missing section {}", s.name)),
                })
                .collect::<Result<_, _>>()?;
            let mut known: Vec<&str> = st.fields.iter().map(|f| f.name).collect();
            known.retain(|k| !counts.iter().any(|(c, _)| c == k));
            let mut extra: Vec<&str> = st.sections.iter().map(|s| s.name).collect();
            extra.push("seq");
            // Count fields may be stated (the spec lists them); they are recomputed regardless.
            extra.extend(st.sections.iter().map(|s| s.count_field));
            check_unknown(&vals, &known, &extra, what)?;
            encode_fields(&mut buf, 0, 16, st.fields, &vals, &counts, what)?;
            for s in st.sections {
                let Some(Value::Arr(items)) = lookup(&vals, s.name) else { unreachable!() };
                for (i, it) in items.iter().enumerate() {
                    let w = format!("{what}.{}[{i}]", s.name);
                    let cur = buf.len();
                    if s.item.len() == 1 {
                        encode_fields(&mut buf, cur, 0, s.item, &vec![(s.item[0].name, it)], &[], &w)?;
                    } else {
                        let r = rec_vals(it)?;
                        check_unknown(&r, &s.item.iter().map(|f| f.name).collect::<Vec<_>>(), &[], &w)?;
                        encode_fields(&mut buf, cur, 0, s.item, &r, &[], &w)?;
                    }
                }
            }
            let end = buf.len();
            envelope(schema, &mut buf, k.id, seq, end - 16)?;
        }
    }
    Ok(buf)
}

/// Lower-case hex.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
