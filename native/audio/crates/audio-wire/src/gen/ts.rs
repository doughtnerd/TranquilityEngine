//! TypeScript emitter (lead-owned, A0.2-GEN): writes `wire.generated.ts`.
//!
//! Surface (the contract the round-trip test is written against):
//! * `export const` for every schema constant, bit mask (`<RECORD>_<FIELD>_<BIT>`, ranges as `_SHIFT`
//!   and `_MASK`), `SCHEMA_HASH` (32 hex chars) and `WIRE_GENERATED = true`; const objects `Kind`, `Op`,
//!   one per enum, and `ErrorCode`.
//! * an `interface` per record, body, header and group item, named in PascalCase (`Play`, `SetParams`,
//!   `ClipBegin`, `BusConfig`, `BusConfigBuses`, `BatchHeader`, `RecordHead`, `Envelope`, `HrirHeader`),
//!   fields named as in the schema, groups as arrays; counts are derived on write and not stored.
//! * `write<Name>(view: DataView, off: number, rec): number` returns the bytes written. Opcode records
//!   write their 12-byte head (opcode, words), bodies write only the body at the spec's absolute offsets
//!   (so `off` is the message start); `writeEnvelope` defaults `magic` and `version`.
//! * `read<Name>(view: DataView, off: number): Name`. A record shorter than its head says, or a group
//!   that overruns, throws `WireError` (with an `ErrorCode`); nothing reads outside the view.
//! * `writeStatus(view, off, block, seq): number` and `readStatus(buf): StatusBlock`.
//! * The STATUS header described once (ADR 0177): `StatusHeader` (the scalars; `StatusBlock` extends it),
//!   `newStatusHeader`, `copyStatusHeader`, `newStatusBlock`, `STATUS_HEADER_COLUMNS` (name to `[offset, type]`, the
//!   capture's columns) with `readStatusHeaderField`, `STATUS_SECTION`, and `StatusBlockReader`, the zero-allocation
//!   reader into one preallocated block.

use super::layout::*;
use crate::model::*;

fn dv(t: Ty) -> &'static str {
    match t {
        Ty::U8 => "Uint8",
        Ty::U16 => "Uint16",
        Ty::U32 => "Uint32",
        Ty::I32 => "Int32",
        Ty::F32 => "Float32",
        Ty::F64 => "Float64",
    }
}

fn le(t: Ty) -> &'static str {
    if t == Ty::U8 {
        ""
    } else {
        ", true"
    }
}

fn tsty(f: &Field) -> &'static str {
    if f.count == 1 {
        "number"
    } else {
        "number[]"
    }
}

fn js_doc(o: &mut String, indent: &str, text: &str) {
    if !text.is_empty() {
        o.push_str(&format!("{indent}/** {} */\n", text.replace("*/", "* /")));
    }
}

fn set_line(p: &Placed, access: &str) -> String {
    let f = &p.field;
    if f.count == 1 {
        format!("  view.set{}(off + {}, {access}{});\n", dv(f.ty), p.offset, le(f.ty))
    } else {
        format!(
            "  for (let i = 0; i < {n}; i++) view.set{t}(off + {o} + i * {sz}, {access}[i]{l});\n",
            n = f.count,
            t = dv(f.ty),
            o = p.offset,
            sz = f.ty.bytes(),
            l = le(f.ty)
        )
    }
}

fn get_expr(p: &Placed) -> String {
    let f = &p.field;
    if f.count == 1 {
        format!("view.get{}(off + {}{})", dv(f.ty), p.offset, le(f.ty))
    } else {
        format!(
            "Array.from({{ length: {n} }}, (_, i) => view.get{t}(off + {o} + i * {sz}{l}))",
            n = f.count,
            t = dv(f.ty),
            o = p.offset,
            sz = f.ty.bytes(),
            l = le(f.ty)
        )
    }
}

struct Head {
    id: u16,
    voice_at: u32,
    frame_at: u32,
    opcode_at: u32,
    words_at: u32,
}

/// `env`: Envelope special case (`magic` and `version` optional on write).
fn emit_item(o: &mut String, it: &Item, head: Option<&Head>, text: &str, env: bool) {
    if let Some(g) = &it.group {
        emit_item(o, &g.item, None, "", false);
    }
    let n = &it.name;
    js_doc(o, "", text);
    o.push_str(&format!("export interface {n} {{\n"));
    if head.is_some() {
        o.push_str("  voiceId: number;\n  frameOffset: number;\n");
    }
    for p in it.stored() {
        js_doc(o, "  ", p.field.doc);
        let opt = env && (p.field.name == "magic" || p.field.name == "version");
        let opt = opt || p.field.appended;
        o.push_str(&format!("  {}{}: {};\n", p.field.name, if opt { "?" } else { "" }, tsty(&p.field)));
    }
    if let Some(g) = &it.group {
        o.push_str(&format!("  {}: {}[];\n", g.name, g.item.name));
    }
    for a in &it.arrays {
        js_doc(o, "  ", a.doc);
        o.push_str(&format!("  {}: ArrayLike<number>;\n", a.name));
    }
    o.push_str("}\n\n");
    o.push_str(&format!("export const {}_FIXED_END = {};\n\n", screaming(n), it.fixed_end));

    // write
    o.push_str(&format!("export function write{n}(view: DataView, off: number, rec: {n}): number {{\n"));
    for p in &it.fields {
        let counted = match it.array_of(p.field.name) {
            Some(a) => Some((a.name, a.max)),
            None => it.group.as_ref().filter(|g| g.count_field == p.field.name).map(|g| (g.name, g.max)),
        };
        if let Some((list, max)) = counted {
            if max > 0 {
                o.push_str(&format!("  if (rec.{list}.length > {max}) throw new WireError(ErrorCode.OVERSIZE, \"{n}: {list} over its cap {max}\");\n"));
            }
            o.push_str(&format!("  view.set{}(off + {}, rec.{list}.length{});\n", dv(p.field.ty), p.offset, le(p.field.ty)));
        } else {
            let acc = match (env, p.field.name) {
                (true, "magic") => "(rec.magic ?? MAGIC)".to_string(),
                (true, "version") => "(rec.version ?? ((VERSION_MAJOR << 8) | VERSION_MINOR))".to_string(),
                _ if p.field.appended => format!("(rec.{} ?? 0)", p.field.name),
                _ => format!("rec.{}", p.field.name),
            };
            o.push_str(&set_line(p, &acc));
        }
    }
    o.push_str(&format!("  let cur = off + {};\n", it.fixed_end));
    if let Some(g) = &it.group {
        o.push_str(&format!("  for (const item of rec.{}) cur += write{}(view, cur, item);\n", g.name, g.item.name));
    }
    for a in &it.arrays {
        let sz = a.ty.bytes();
        o.push_str(&format!(
            "  {{\n    const list = rec.{n};\n    for (let i = 0; i < list.length; i++) view.set{t}(cur + i * {sz}, list[i]!{l});\n    const end = cur + Math.ceil((list.length * {sz}) / 4) * 4;\n    for (let b = cur + list.length * {sz}; b < end; b++) view.setUint8(b, 0);\n    cur = end;\n  }}\n",
            n = a.name,
            t = dv(a.ty),
            l = le(a.ty)
        ));
    }
    if let Some(h) = head {
        o.push_str(&format!(
            "  const total = cur - off;\n  if (total % 4 !== 0 || total / 4 > 0xffff) throw new WireError(ErrorCode.OVERSIZE, \"{n}: record too long\");\n  view.setUint16(off + {}, {}, true);\n  view.setUint16(off + {}, total / 4, true);\n  view.setUint32(off + {}, rec.voiceId, true);\n  view.setUint32(off + {}, rec.frameOffset, true);\n",
            h.opcode_at, h.id, h.words_at, h.voice_at, h.frame_at
        ));
    }
    o.push_str("  return cur - off;\n}\n\n");

    // read
    o.push_str(&format!("function _read{n}(view: DataView, off: number, limit: number): [{n}, number] {{\n"));
    o.push_str(&format!(
        "  if (off + {} > limit) throw new WireError(ErrorCode.TRUNCATED, \"{n}: truncated\");\n",
        it.min_end
    ));
    for p in &it.fields {
        if p.field.appended {
            o.push_str(&format!("  const {} = off + {} <= limit ? {} : 0;\n", p.field.name, p.offset + p.field.ty.bytes(), get_expr(p)));
        } else {
            o.push_str(&format!("  const {} = {};\n", p.field.name, get_expr(p)));
        }
    }
    if it.min_end != it.fixed_end {
        o.push_str(&format!("  let cur = Math.min(off + {}, limit);\n", it.fixed_end));
    } else {
        o.push_str(&format!("  let cur = off + {};\n", it.fixed_end));
    }
    if let Some(g) = it.group.as_ref().filter(|g| g.max > 0) {
        o.push_str(&format!("  if ({} > {}) throw new WireError(ErrorCode.MALFORMED, \"{n}: {} over its cap\");\n", g.count_field, g.max, g.name));
    }
    if let Some(g) = &it.group {
        o.push_str(&format!(
            "  if ({} * {} > limit - cur) throw new WireError(ErrorCode.TRUNCATED, \"{n}: {} overrun\");\n  const {}: {}[] = [];\n  for (let i = 0; i < {}; i++) {{\n    const [item, used] = _read{}(view, cur, limit);\n    cur += used;\n    {}.push(item);\n  }}\n",
            g.count_field, g.item.fixed_end, g.name, g.name, g.item.name, g.count_field, g.item.name, g.name
        ));
    }
    for a in &it.arrays {
        let sz = a.ty.bytes();
        if a.max > 0 {
            o.push_str(&format!("  if ({} > {}) throw new WireError(ErrorCode.MALFORMED, \"{n}: {} over its cap\");\n", a.count_field, a.max, a.name));
        }
        o.push_str(&format!(
            "  if (Math.ceil(({c} * {sz}) / 4) * 4 > limit - cur) throw new WireError(ErrorCode.TRUNCATED, \"{n}: {a} overrun\");\n  const {a}: number[] = [];\n  for (let i = 0; i < {c}; i++) {a}.push(view.get{t}(cur + i * {sz}{l}));\n  cur += Math.ceil(({c} * {sz}) / 4) * 4;\n",
            c = a.count_field,
            a = a.name,
            t = dv(a.ty),
            l = le(a.ty)
        ));
    }
    if let Some(h) = head {
        o.push_str(&format!(
            "  if (cur > limit) throw new WireError(ErrorCode.MALFORMED, \"{n}: malformed\");\n  cur = limit;\n  const voiceId = view.getUint32(off + {}, true);\n  const frameOffset = view.getUint32(off + {}, true);\n",
            h.voice_at, h.frame_at
        ));
    }
    o.push_str("  return [{ ");
    let mut parts: Vec<String> = Vec::new();
    if head.is_some() {
        parts.push("voiceId".into());
        parts.push("frameOffset".into());
    }
    for p in it.stored() {
        parts.push(p.field.name.to_string());
    }
    if let Some(g) = &it.group {
        parts.push(g.name.to_string());
    }
    for a in &it.arrays {
        parts.push(a.name.to_string());
    }
    o.push_str(&parts.join(", "));
    o.push_str(" }, cur - off];\n}\n\n");
    o.push_str(&format!("export function read{n}(view: DataView, off: number): {n} {{\n"));
    if let Some(h) = head {
        o.push_str(&format!(
            "  if (off + {} > view.byteLength) throw new WireError(ErrorCode.TRUNCATED, \"{n}: truncated\");\n  if (view.getUint16(off + {}, true) !== {}) throw new WireError(ErrorCode.MALFORMED, \"{n}: wrong opcode\");\n  const limit = off + view.getUint16(off + {}, true) * 4;\n  if (limit > view.byteLength) throw new WireError(ErrorCode.TRUNCATED, \"{n}: truncated\");\n",
            12, h.opcode_at, h.id, h.words_at
        ));
    } else {
        o.push_str("  const limit = view.byteLength;\n");
    }
    o.push_str(&format!("  return _read{n}(view, off, limit)[0];\n}}\n\n"));
}

fn emit_bits(o: &mut String, owner: &str, fields: &[Field]) {
    for f in fields {
        for b in f.bits {
            let name = format!("{}_{}_{}", screaming(owner), screaming(f.name), screaming(b.name));
            js_doc(o, "", b.doc);
            let mask: u64 = ((1u64 << b.width) - 1) << b.lo;
            if b.width == 1 {
                o.push_str(&format!("export const {name} = {mask:#x};\n"));
            } else {
                o.push_str(&format!("export const {name}_SHIFT = {};\nexport const {name}_MASK = {mask:#x};\n", b.lo));
            }
        }
    }
}

/// Packers and readers of the M4 shape word and the PLAY gate (twins of the Rust ones).
const M4_PACKERS: &str = r#"/** The shape word of FADE, SET_PARAMS and STOP: `law` (bits 0-2, `FadeLaw`) and `startPhase` as u0.16 (bits 16-31). */
export function packShape(law: number, startPhase: number): number {
  return (((law & SHAPE_LAW_MASK) | ((startPhase & 0xffff) << SHAPE_PHASE_SHIFT)) >>> 0);
}
/** The law of a shape word (0..7; 4..7 are reserved). */
export function shapeLaw(shape: number): number {
  return shape & SHAPE_LAW_MASK;
}
/** The start phase of a shape word, 0..65535 (value / 65,536). */
export function shapeStartPhase(shape: number): number {
  return shape >>> SHAPE_PHASE_SHIFT;
}
/** The BUS_RAMP `shape`: `law`, `sequenceId` 0..8191 (0 = none, bits 3-15) and `startPhase` as u0.16. */
export function packRampShape(law: number, sequenceId: number, startPhase: number): number {
  return (((law & SHAPE_LAW_MASK) | ((sequenceId & SHAPE_SEQUENCE_MASK) << SHAPE_SEQUENCE_SHIFT) | ((startPhase & 0xffff) << SHAPE_PHASE_SHIFT)) >>> 0);
}
/** The sequence id of a BUS_RAMP shape word, 0..8191. */
export function rampSequenceId(shape: number): number {
  return (shape >>> SHAPE_SEQUENCE_SHIFT) & SHAPE_SEQUENCE_MASK;
}
/** The PLAY `gate`: `groupId` 1..1023 (0 = ungated, which packs to 0) and `groupSize` 1..64 (clamped). */
export function packGate(groupId: number, groupSize: number): number {
  if ((groupId & PLAY_GATE_ID_MASK) === 0) return 0;
  const size = Math.min(PLAY_GATE_MAX_SIZE, Math.max(1, groupSize));
  return (groupId & PLAY_GATE_ID_MASK) | ((size - 1) << PLAY_GATE_SIZE_SHIFT);
}
/** The group id of a gate (0 = ungated). */
export function gateGroupId(gate: number): number {
  return gate & PLAY_GATE_ID_MASK;
}
/** The group size of a gate, 1..64; 0 for an ungated voice. */
export function gateGroupSize(gate: number): number {
  return (gate & PLAY_GATE_ID_MASK) === 0 ? 0 : ((gate >>> PLAY_GATE_SIZE_SHIFT) & PLAY_GATE_SIZE_MASK) + 1;
}

"#;

pub fn emit(schema: &Schema, hash_hex: &str) -> Result<String, String> {
    let mut o = String::new();
    o.push_str("// @generated by `gen_wire` (native/audio/crates/audio-wire, task A0.2, contract K1). Do not edit:\n");
    o.push_str("// change the schema and run `npm run build:audio` (or the gen_wire binary).\n");
    o.push_str("/* eslint-disable */\n\nexport const WIRE_GENERATED = true;\n");
    o.push_str(&format!("/** First 16 bytes of the schema's SHA-256, lower-case hex (32 characters). */\nexport const SCHEMA_HASH = \"{hash_hex}\";\n\n"));
    for c in schema.constants {
        js_doc(&mut o, "", c.doc);
        o.push_str(&format!("export const {} = {:#x};\n", c.name, c.value));
    }
    o.push_str("\n/** Negative i32 results of the C ABI (0 is ok). */\nexport const ErrorCode = {\n");
    for e in schema.errors {
        o.push_str(&format!("  {}: {},\n", e.name, e.value));
    }
    o.push_str("} as const;

/** Thrown by every generated reader and by writer cap checks; never a raw RangeError from a DataView. */
export class WireError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = \"WireError\";
    this.code = code;
  }
}

export const Kind = {
");
    for k in schema.kinds {
        o.push_str(&format!("  {}: {},\n", k.name, k.id));
    }
    o.push_str("} as const;\n\nexport const Op = {\n");
    for p in schema.opcodes {
        o.push_str(&format!("  {}: {:#04x},\n", p.name, p.id));
    }
    o.push_str("} as const;\n\n");
    for e in schema.enums {
        js_doc(&mut o, "", e.doc);
        o.push_str(&format!("export const {} = {{\n", e.name));
        for (n, v, _) in e.variants {
            o.push_str(&format!("  {n}: {v},\n"));
        }
        o.push_str("} as const;\n\n");
    }

    o.push_str(M4_PACKERS);
    let (env, _) = resolve(0, schema.envelope)?;
    emit_item(&mut o, &Item::plain("Envelope", env, 16), None, "The 16-byte envelope of every message (`magic` and `version` default on write).", true);
    let (hd, _) = resolve(0, schema.record_head)?;
    emit_item(&mut o, &Item::plain("RecordHead", hd.clone(), 12), None, "The 12-byte head of every command record.", false);
    let at = |n: &str| hd.iter().find(|p| p.field.name == n).unwrap().offset;
    emit_item(&mut o, &build_item("BatchHeader", 16, schema.batch_header, None)?, None, "Body header of BATCH and REPLAY; records follow.", false);
    emit_bits(&mut o, "BATCH_HEADER", schema.batch_header);
    emit_item(&mut o, &build_item("HrirHeader", 0, schema.hrir_header, None)?, None, "First-chunk header of a format = 2 (HRIR) CLIP_CHUNK payload.", false);
    for b in schema.blob_headers {
        emit_bits(&mut o, &screaming(b.name), b.fields);
        emit_item(&mut o, &build_item(b.name, 0, b.fields, None)?, None, b.doc, false);
    }
    for k in schema.kinds {
        emit_bits(&mut o, k.name, k.body.fields);
        if k.name == "STATUS" || k.body.fields.is_empty() || matches!(k.body.tail, Tail::Records) {
            continue;
        }
        emit_item(&mut o, &kind_item(k)?, None, k.doc, false);
    }
    for p in schema.opcodes {
        emit_bits(&mut o, p.name, p.payload.fields);
        if !p.sent {
            continue;
        }
        let h = Head { id: p.id, voice_at: at("voiceId"), frame_at: at("frameOffset"), opcode_at: at("opcode"), words_at: at("words") };
        emit_item(&mut o, &opcode_item(p)?, Some(&h), p.doc, false);
    }
    emit_status(&mut o, schema)?;
    Ok(o)
}

fn emit_status(o: &mut String, schema: &Schema) -> Result<(), String> {
    let st = &schema.status;
    emit_bits(o, "STATUS", st.fields);
    let (placed, _) = resolve(16, st.fields)?;
    let is_count = |n: &str| st.sections.iter().any(|s| s.count_field == n);
    for s in st.sections {
        if s.item.len() > 1 {
            let it = build_item(&format!("Status{}Item", pascal(s.name)), 0, s.item, None)?;
            emit_item(o, &it, None, s.doc, false);
        }
    }
    let item_ty = |s: &Section| if s.item.len() == 1 { "number".to_string() } else { format!("Status{}Item", pascal(s.name)) };
    o.push_str("/** The STATUS header's scalars, by name (the section counts are left out: they are the sections' lengths). */\nexport interface StatusHeader {\n");
    for p in placed.iter().filter(|p| !is_count(p.field.name)) {
        js_doc(o, "  ", p.field.doc);
        o.push_str(&format!("  {}: {};\n", p.field.name, tsty(&p.field)));
    }
    o.push_str("}\n\n");
    o.push_str("/** A whole STATUS message (kind 9): the header's scalars and the sections; section counts are derived. */\nexport interface StatusBlock extends StatusHeader {\n");
    for s in st.sections {
        js_doc(o, "  ", &format!("{} (at most {} per block)", s.doc, s.max));
        o.push_str(&format!("  {}: {}[];\n", s.name, item_ty(s)));
    }
    o.push_str("}\n\n");
    // write
    o.push_str("/** Write a whole STATUS message at `off` (envelope first); returns the bytes written. */\n");
    o.push_str("export function writeStatus(view: DataView, off: number, rec: StatusBlock, seq: number): number {\n");
    for p in &placed {
        if let Some(s) = st.sections.iter().find(|s| s.count_field == p.field.name) {
            o.push_str(&format!(
                "  if (rec.{n}.length > {m}) throw new WireError(ErrorCode.OVERSIZE, \"STATUS: {n} over its cap {m}\");\n  view.set{t}(off + {off}, rec.{n}.length{l});\n",
                n = s.name,
                m = s.max,
                t = dv(p.field.ty),
                off = p.offset,
                l = le(p.field.ty)
            ));
        } else {
            o.push_str(&set_line(p, &format!("rec.{}", p.field.name)));
        }
    }
    o.push_str(&format!("  let cur = off + {};\n", st.header_bytes));
    for s in st.sections {
        if s.item.len() == 1 {
            let f = &s.item[0];
            o.push_str(&format!("  for (const v of rec.{}) {{\n    view.set{}(cur, v{});\n    cur += {};\n  }}\n", s.name, dv(f.ty), le(f.ty), f.bytes()));
        } else {
            o.push_str(&format!("  for (const v of rec.{}) cur += write{}(view, cur, v);\n", s.name, format!("Status{}Item", pascal(s.name))));
        }
    }
    o.push_str("  writeEnvelope(view, off, { kind: Kind.STATUS, seq, bodyBytes: cur - off - 16 });\n  return cur - off;\n}\n\n");
    // read
    o.push_str("/** Read a whole STATUS message; the buffer's first byte is the envelope. */\n");
    o.push_str("export function readStatus(buf: ArrayBuffer | ArrayBufferView): StatusBlock {\n");
    o.push_str("  const view = buf instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);\n  const off = 0;\n");
    o.push_str(&format!("  if ({} > view.byteLength) throw new WireError(ErrorCode.TRUNCATED, \"STATUS: truncated\");\n", st.header_bytes));
    o.push_str("  const env = readEnvelope(view, 0);\n  if (env.magic !== MAGIC) throw new WireError(ErrorCode.BAD_MAGIC, \"STATUS: bad magic\");\n  if (((env.version ?? 0) >> 8) !== VERSION_MAJOR) throw new WireError(ErrorCode.VERSION_MISMATCH, \"STATUS: version mismatch\");\n  if (env.kind !== Kind.STATUS) throw new WireError(ErrorCode.MALFORMED, \"STATUS: wrong kind\");\n");
    o.push_str(&format!("  const limit = 16 + env.bodyBytes;\n  if (limit > view.byteLength || limit < {}) throw new WireError(ErrorCode.TRUNCATED, \"STATUS: truncated\");\n", st.header_bytes));
    for p in &placed {
        o.push_str(&format!("  const {} = {};\n", p.field.name, get_expr(p)));
    }
    o.push_str(&format!("  let cur = {};\n", st.header_bytes));
    for s in st.sections {
        let isz: u32 = s.item.iter().map(|f| f.bytes()).sum();
        o.push_str(&format!(
            "  if ({c} > {m} || {c} * {isz} > limit - cur) throw new WireError(ErrorCode.OVERSIZE, \"STATUS: {n} overrun\");\n  const {n}: {t}[] = [];\n",
            c = s.count_field,
            m = s.max,
            n = s.name,
            t = item_ty(s)
        ));
        if s.item.len() == 1 {
            let f = &s.item[0];
            o.push_str(&format!("  for (let i = 0; i < {}; i++) {{\n    {}.push(view.get{}(cur{}));\n    cur += {isz};\n  }}\n", s.count_field, s.name, dv(f.ty), le(f.ty)));
        } else {
            o.push_str(&format!("  for (let i = 0; i < {}; i++) {{\n    {}.push(readStatus{}Item(view, cur));\n    cur += {isz};\n  }}\n", s.count_field, s.name, pascal(s.name)));
            // readStatusXItem is the generated item reader
        }
    }
    let mut parts: Vec<String> = placed.iter().filter(|p| !is_count(p.field.name)).map(|p| p.field.name.to_string()).collect();
    parts.extend(st.sections.iter().map(|s| s.name.to_string()));
    o.push_str(&format!("  return {{ {} }};\n}}\n", parts.join(", ")));
    emit_status_extras(o, schema, &placed)
}

fn col_ty(t: Ty) -> &'static str {
    match t {
        Ty::U8 => "u8",
        Ty::U16 => "u16",
        Ty::U32 => "u32",
        Ty::I32 => "i32",
        Ty::F32 => "f32",
        Ty::F64 => "f64",
    }
}

/// `view.get<T>(<at>[, true])` for a scalar of type `t` at the byte expression `at`.
fn get_at(t: Ty, at: &str) -> String {
    format!("view.get{}({at}{})", dv(t), le(t))
}

/// The STATUS pieces built on the header layout (ADR 0177): the `StatusHeader` helpers, the header's column table (what
/// the capture's `range` reads by name) and `StatusBlockReader`, the zero-allocation reader of a whole STATUS into one
/// preallocated block. Hand code adds only what the schema can't say (semantic checks, derived values).
fn emit_status_extras(o: &mut String, schema: &Schema, placed: &[Placed]) -> Result<(), String> {
    let st = &schema.status;
    let is_count = |n: &str| st.sections.iter().any(|s| s.count_field == n);
    let scalars: Vec<&Placed> = placed.iter().filter(|p| !is_count(p.field.name)).collect();
    for p in &scalars {
        if p.field.count != 1 {
            return Err(format!("STATUS header field {} is an array; the column table takes scalars only", p.field.name));
        }
    }
    let (env, _) = resolve(0, schema.envelope)?;
    let env_at = |n: &str| -> Result<(u32, Ty), String> {
        env.iter().find(|p| p.field.name == n).map(|p| (p.offset, p.field.ty)).ok_or_else(|| format!("envelope has no {n}"))
    };
    let count_at = |n: &str| -> Result<&Placed, String> { placed.iter().find(|p| p.field.name == n).ok_or_else(|| format!("STATUS has no {n}")) };
    let item_name = |s: &Section| format!("Status{}Item", pascal(s.name));

    // The header record's helpers.
    o.push_str("\n/** A `StatusHeader` with every field 0. */\nexport function newStatusHeader(): StatusHeader {\n  return {\n");
    for p in &scalars {
        o.push_str(&format!("    {}: 0,\n", p.field.name));
    }
    o.push_str("  };\n}\n\n");
    o.push_str("/** Copies every header scalar of `src` into `dst` (a `StatusBlock` is a `StatusHeader`); allocates nothing. */\nexport function copyStatusHeader(dst: StatusHeader, src: StatusHeader): void {\n");
    for p in &scalars {
        o.push_str(&format!("  dst.{n} = src.{n};\n", n = p.field.name));
    }
    o.push_str("}\n\n");
    o.push_str("/** A `StatusBlock` with every header field 0 and every section empty. */\nexport function newStatusBlock(): StatusBlock {\n  return {\n");
    for p in &scalars {
        o.push_str(&format!("    {}: 0,\n", p.field.name));
    }
    for s in st.sections {
        o.push_str(&format!("    {}: [],\n", s.name));
    }
    o.push_str("  };\n}\n\n");

    // The column table.
    let mut tys: Vec<Ty> = Vec::new();
    for p in &scalars {
        if !tys.contains(&p.field.ty) {
            tys.push(p.field.ty);
        }
    }
    let union: Vec<String> = tys.iter().map(|t| format!("\"{}\"", col_ty(*t))).collect();
    o.push_str("/** The type of a STATUS header column. */\n");
    o.push_str(&format!("export type StatusColumnType = {};\n\n", union.join(" | ")));
    o.push_str("/**\n * Every STATUS header scalar by its `StatusHeader` name: `[byte offset from the envelope's first byte, type]`. The\n * capture format stores raw STATUS blocks, and its `range` reads these columns in place.\n */\nexport const STATUS_HEADER_COLUMNS = {\n");
    for p in &scalars {
        o.push_str(&format!("  {}: [{}, \"{}\"],\n", p.field.name, p.offset, col_ty(p.field.ty)));
    }
    o.push_str("} as const satisfies Record<keyof StatusHeader, readonly [number, StatusColumnType]>;\n");
    o.push_str("/** A STATUS header column's name. */\nexport type StatusHeaderField = keyof typeof STATUS_HEADER_COLUMNS;\n\n");
    o.push_str("/** The STATUS header scalar `field` of the block whose envelope starts at `off`, read in place (no allocation). */\n");
    o.push_str("export function readStatusHeaderField(view: DataView, off: number, field: StatusHeaderField): number {\n");
    o.push_str("  const col: readonly [number, StatusColumnType] = STATUS_HEADER_COLUMNS[field];\n  const at = off + col[0];\n  switch (col[1]) {\n");
    for t in &tys {
        o.push_str(&format!("    case \"{}\": return {};\n", col_ty(*t), get_at(*t, "at")));
    }
    o.push_str("  }\n}\n\n");

    // Each multi-field section item's field offsets, for semantic checks that read the view before the block is written.
    for s in st.sections.iter().filter(|s| s.item.len() > 1) {
        let it = build_item(&item_name(s), 0, s.item, None)?;
        o.push_str(&format!("/** `{}` field offsets, bytes from the item's start (the item is `{}_FIXED_END` bytes). */\n", item_name(s), screaming(&item_name(s))));
        o.push_str(&format!("export const {}_AT = {{ ", screaming(&item_name(s))));
        let parts: Vec<String> = it.fields.iter().map(|p| format!("{}: {}", p.field.name, p.offset)).collect();
        o.push_str(&parts.join(", "));
        o.push_str(" } as const;\n");
    }
    o.push('\n');

    // The section indices.
    o.push_str("/** Each STATUS section's index in `StatusBlockReader`'s `sectionAt` and `sectionCount`, in wire order. */\nexport const STATUS_SECTION = {\n");
    for (i, s) in st.sections.iter().enumerate() {
        o.push_str(&format!("  {}: {i},\n", s.name));
    }
    o.push_str("} as const;\n\n");
    o.push_str("/** Each STATUS section's count field: its byte offset in the header (from the envelope's first byte). */\nexport const STATUS_SECTION_COUNT_AT = {\n");
    for s in st.sections {
        o.push_str(&format!("  {}: {},\n", s.name, count_at(s.count_field)?.offset));
    }
    o.push_str("} as const;\n\n");
    o.push_str("/** Each STATUS section's per-block cap. */\nexport const STATUS_SECTION_MAX = {\n");
    for s in st.sections {
        o.push_str(&format!("  {}: {},\n", s.name, s.max));
    }
    o.push_str("} as const;\n\n");

    // The reader.
    let n_sec = st.sections.len();
    let (magic_at, magic_ty) = env_at("magic")?;
    let (version_at, version_ty) = env_at("version")?;
    let (kind_at, kind_ty) = env_at("kind")?;
    let (body_at, body_ty) = env_at("bodyBytes")?;
    o.push_str("/**\n * Reads a whole STATUS message into one preallocated `block`, so a reader allocates nothing per message (the\n * generated `readStatus` builds a fresh block, arrays and items every call). The same checks, codes and messages as\n * `readStatus`; every section is validated before the block is touched, so a refused message leaves it as it was.\n * Section arrays keep their capacity (warmed to each cap) and multi-field items are pooled objects: the block, its\n * arrays and its items are the reader's own and the next read overwrites them, so use them before reading again.\n * A subclass adds semantic checks in `check`, which runs after the structural ones and before any write.\n */\n");
    o.push_str("export class StatusBlockReader {\n  /** The reused block. */\n  readonly block: StatusBlock = newStatusBlock();\n");
    o.push_str(&format!("  /** The newest validated message's section offsets (bytes from the envelope), by `STATUS_SECTION`. */\n  protected readonly sectionAt = new Uint32Array({n_sec});\n"));
    o.push_str(&format!("  /** The newest validated message's section counts, by `STATUS_SECTION`. */\n  protected readonly sectionCount = new Uint32Array({n_sec});\n"));
    for s in st.sections.iter().filter(|s| s.item.len() > 1) {
        o.push_str(&format!("  private readonly {}Pool: {}[] = [];\n", s.name, item_name(s)));
    }
    o.push_str("\n  constructor() {\n    const b = this.block;\n");
    for s in st.sections {
        if s.item.len() > 1 {
            let zeros: Vec<String> = s.item.iter().map(|f| format!("{}: 0", f.name)).collect();
            o.push_str(&format!(
                "    for (let i = 0; i < {m}; i++) {{\n      const item: {t} = {{ {z} }};\n      this.{n}Pool.push(item);\n      b.{n}.push(item);\n    }}\n    b.{n}.length = 0;\n",
                m = s.max,
                t = item_name(s),
                z = zeros.join(", "),
                n = s.name
            ));
        } else {
            o.push_str(&format!("    for (let i = 0; i < {m}; i++) b.{n}.push(0);\n    b.{n}.length = 0;\n", m = s.max, n = s.name));
        }
    }
    o.push_str("  }\n\n");
    o.push_str("  /** Semantic checks a subclass adds (`sectionAt` and `sectionCount` are set); throw a `WireError` to refuse the message. */\n  protected check(_view: DataView, _limit: number): void {}\n\n");
    o.push_str("  /** Decodes `buf` (envelope first) into `block` and returns it. Builds one `DataView`; `readView` builds none. */\n");
    o.push_str("  read(buf: ArrayBuffer | ArrayBufferView): StatusBlock {\n    return this.readView(buf instanceof ArrayBuffer ? new DataView(buf) : new DataView(buf.buffer, buf.byteOffset, buf.byteLength));\n  }\n\n");
    o.push_str("  /** Decodes the STATUS message starting at `view`'s first byte into `block` and returns it. Allocates nothing. */\n");
    o.push_str("  readView(view: DataView): StatusBlock {\n");
    o.push_str(&format!("    if ({} > view.byteLength) throw new WireError(ErrorCode.TRUNCATED, \"STATUS: truncated\");\n", st.header_bytes));
    o.push_str(&format!("    if ({} !== MAGIC) throw new WireError(ErrorCode.BAD_MAGIC, \"STATUS: bad magic\");\n", get_at(magic_ty, &magic_at.to_string())));
    o.push_str(&format!("    if (({} >> 8) !== VERSION_MAJOR) throw new WireError(ErrorCode.VERSION_MISMATCH, \"STATUS: version mismatch\");\n", get_at(version_ty, &version_at.to_string())));
    o.push_str(&format!("    if ({} !== Kind.STATUS) throw new WireError(ErrorCode.MALFORMED, \"STATUS: wrong kind\");\n", get_at(kind_ty, &kind_at.to_string())));
    o.push_str(&format!(
        "    const limit = 16 + {};\n    if (limit > view.byteLength || limit < {}) throw new WireError(ErrorCode.TRUNCATED, \"STATUS: truncated\");\n",
        get_at(body_ty, &body_at.to_string()),
        st.header_bytes
    ));
    o.push_str(&format!("    const at = this.sectionAt;\n    const count = this.sectionCount;\n    let cur = {};\n    let c = 0;\n", st.header_bytes));
    for (i, s) in st.sections.iter().enumerate() {
        let cp = count_at(s.count_field)?;
        let isz: u32 = s.item.iter().map(|f| f.bytes()).sum();
        o.push_str(&format!(
            "    c = {get};\n    if (c > {m} || c * {isz} > limit - cur) throw new WireError(ErrorCode.OVERSIZE, \"STATUS: {n} overrun\");\n    at[{i}] = cur;\n    count[{i}] = c;\n    cur += c * {isz};\n",
            get = get_at(cp.field.ty, &cp.offset.to_string()),
            m = s.max,
            n = s.name
        ));
    }
    o.push_str("    this.check(view, limit);\n\n    const b = this.block;\n");
    for p in &scalars {
        o.push_str(&format!("    b.{} = {};\n", p.field.name, get_at(p.field.ty, &p.offset.to_string())));
    }
    for (i, s) in st.sections.iter().enumerate() {
        let isz: u32 = s.item.iter().map(|f| f.bytes()).sum();
        o.push_str(&format!("    {{\n      const list = b.{n};\n      const n = count[{i}]!;\n      let p = at[{i}]!;\n", n = s.name));
        if s.item.len() == 1 {
            let f = &s.item[0];
            if f.count != 1 {
                return Err(format!("STATUS section {} has an array item", s.name));
            }
            o.push_str(&format!("      for (let i = 0; i < n; i++, p += {isz}) list[i] = {};\n", get_at(f.ty, "p")));
        } else {
            let it = build_item(&item_name(s), 0, s.item, None)?;
            o.push_str(&format!("      const pool = this.{}Pool;\n      for (let i = 0; i < n; i++, p += {isz}) {{\n        const item = pool[i]!;\n", s.name));
            for f in &it.fields {
                if f.field.count != 1 {
                    return Err(format!("STATUS section {} item field {} is an array", s.name, f.field.name));
                }
                let expr = if f.offset == 0 { "p".to_string() } else { format!("p + {}", f.offset) };
                o.push_str(&format!("        item.{} = {};\n", f.field.name, get_at(f.field.ty, &expr)));
            }
            o.push_str("        list[i] = item;\n      }\n");
        }
        o.push_str("      list.length = n;\n    }\n");
    }
    o.push_str("    return b;\n  }\n}\n");
    Ok(())
}

