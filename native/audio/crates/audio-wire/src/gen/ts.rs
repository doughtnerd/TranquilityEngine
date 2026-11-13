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
    o.push_str("/** A whole STATUS message (kind 9); section counts are derived. */\nexport interface StatusBlock {\n");
    for p in placed.iter().filter(|p| !is_count(p.field.name)) {
        js_doc(o, "  ", p.field.doc);
        o.push_str(&format!("  {}: {};\n", p.field.name, tsty(&p.field)));
    }
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
    Ok(())
}
