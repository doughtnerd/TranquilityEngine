//! The generator: one TypeScript constants file and one vector file per family.
//!
//! - `src/plugins/animation/runtime/wasm/wire/<family>.ts`: the family's id and version, its
//!   constants, and per record its opcode, version, stride and field offsets and types. `core.ts`
//!   also carries the header layout shared by every record.
//! - `native/anim/crates/anim-wire/vectors/<family>.json`: the family's byte vectors.
//! - `src/engine/tween/wasm/wire/{core,tween,sequence}.ts` (ADR 0420): what the engine's tween
//!   backend speaks to the standalone tween module (`native/tween`) with, written the same way: the
//!   header, statuses and passes of `core`, the whole `tween` family, and the sequence records and
//!   constants of `timeline` ([`ENGINE_TWEEN`]).
//!
//! Run by `node native/anim/build.mjs` (`cargo run -p anim-wire --bin gen_wire`); `--check` reports
//! stale files instead of writing them, and `tests/generated.rs` runs the same check.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use crate::record::{FamilyDesc, Value, HEADER_BYTES, HEADER_OPCODE, HEADER_VERSION};

/// Where the TypeScript goes, relative to the repository root.
pub const TS_DIR: &str = "src/plugins/animation/runtime/wasm/wire";
/// Where the vectors go, relative to the repository root.
pub const VECTOR_DIR: &str = "native/anim/crates/anim-wire/vectors";

/// Where the engine's tween backend's copies go (ADR 0420), relative to the repository root.
pub const ENGINE_TWEEN_DIR: &str = "src/engine/tween/wasm/wire";

/// What the engine's tween backend needs of a family: its file name, the family, and which of its
/// constants and records (by name; `None` keeps them all).
pub struct Subset {
    pub file: &'static str,
    pub family: &'static FamilyDesc,
    pub consts: Option<&'static [&'static str]>,
    pub records: Option<&'static [&'static str]>,
}

/// The engine tween backend's files (ADR 0420): the standalone tween module takes these records.
pub const ENGINE_TWEEN: [Subset; 3] = [
    Subset {
        file: "core",
        family: &crate::core::FAMILY,
        consts: Some(&[
            "STATUS_OK",
            "STATUS_BAD_RECORD",
            "STATUS_TOO_LARGE",
            "STATUS_BAD_ASSET",
            "STATUS_FULL",
            "STATUS_STALE_HANDLE",
            "PASS_NORMAL",
            "PASS_FIXED",
        ]),
        records: Some(&[]),
    },
    Subset {
        file: "tween",
        family: &crate::tween::FAMILY,
        consts: None,
        records: None,
    },
    Subset {
        file: "sequence",
        family: &crate::timeline::FAMILY,
        consts: Some(&[
            "NONE",
            "WRAP_ONCE",
            "WRAP_HOLD",
            "WRAP_LOOP",
            "WRAP_PINGPONG",
            "FLAG_PLAY",
            "OP_PLAY",
            "OP_PAUSE",
            "OP_STOP",
            "OP_SEEK",
            "OP_SET_SPEED",
            "OP_KILL",
            "OP_DESTROYED",
            "CHANGE_FINISHED",
            "CHANGE_LOOPED",
            "CHANGE_KILLED",
            "CHANGE_DESTROYED",
            "CHANGE_MEMBER_DONE",
            "BLOCK_MEMBER",
        ]),
        records: Some(&[
            "SeqCreate",
            "SeqMember",
            "TimelineControl",
            "TimelineInfo",
            "TimelineBlock",
            "TimelineChange",
        ]),
    },
];

/// One generated file: its path relative to the repository root and its contents.
pub struct Output {
    pub path: PathBuf,
    pub contents: String,
}

/// Every generated file, for every family in [`crate::FAMILIES`].
pub fn generate_all() -> Result<Vec<Output>, String> {
    let mut out = Vec::new();
    for family in crate::FAMILIES {
        out.push(Output {
            path: Path::new(TS_DIR).join(format!("{}.ts", family.name)),
            contents: typescript(family),
        });
        out.push(Output {
            path: Path::new(VECTOR_DIR).join(format!("{}.json", family.name)),
            contents: vectors_json(family)?,
        });
    }
    for subset in &ENGINE_TWEEN {
        out.push(Output {
            path: Path::new(ENGINE_TWEEN_DIR).join(format!("{}.ts", subset.file)),
            contents: engine_typescript(subset),
        });
    }
    Ok(out)
}

/// Writes the outputs under `root` (or, with `check`, only compares them). Returns the files that
/// were stale.
pub fn write_or_check(
    root: &Path,
    outputs: &[Output],
    check: bool,
) -> Result<Vec<PathBuf>, String> {
    let mut stale = Vec::new();
    for output in outputs {
        let path = root.join(&output.path);
        let current = fs::read_to_string(&path)
            .ok()
            .map(|s| s.replace("\r\n", "\n"));
        if current.as_deref() == Some(output.contents.as_str()) {
            continue;
        }
        stale.push(output.path.clone());
        if !check {
            if let Some(dir) = path.parent() {
                fs::create_dir_all(dir)
                    .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
            }
            fs::write(&path, &output.contents)
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        }
    }
    Ok(stale)
}

/// `MemoryNeeded` → `MEMORY_NEEDED`.
pub fn screaming(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            out.push('_');
        }
        out.push(c.to_ascii_uppercase());
    }
    out
}

/// `arena_initial_bytes` → `arenaInitialBytes`.
pub fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in name.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// A JSDoc block from a doc string (each `///` line keeps one leading space, which is dropped).
fn jsdoc(out: &mut String, indent: &str, doc: &str) {
    let lines: Vec<&str> = doc
        .lines()
        .map(|l| l.strip_prefix(' ').unwrap_or(l).trim_end())
        .collect();
    let lines: Vec<&str> = lines.into_iter().skip_while(|l| l.is_empty()).collect();
    if lines.is_empty() {
        return;
    }
    if lines.len() == 1 {
        let _ = writeln!(out, "{indent}/** {} */", lines[0]);
        return;
    }
    let _ = writeln!(out, "{indent}/**");
    for line in lines {
        if line.is_empty() {
            let _ = writeln!(out, "{indent} *");
        } else {
            let _ = writeln!(out, "{indent} * {line}");
        }
    }
    let _ = writeln!(out, "{indent} */");
}

/// The family's TypeScript constants file.
pub fn typescript(family: &FamilyDesc) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "// Generated by anim-wire's gen_wire (`node native/anim/build.mjs`) from"
    );
    let _ = writeln!(
        out,
        "// native/anim/crates/anim-wire/src/{}.rs. Do not edit: change the Rust and rebuild.",
        family.name
    );
    let _ = writeln!(
        out,
        "// Internal to the animation plugin (ADR 0370): never part of the public API."
    );
    let _ = writeln!(out);
    body(&mut out, family, None, None);
    out
}

/// An engine tween backend file (ADR 0420): the subset's constants and records, written as
/// [`typescript`] writes a family's.
pub fn engine_typescript(subset: &Subset) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "// Generated by anim-wire's gen_wire (`node native/anim/build.mjs`, `npm run build:tween`) from"
    );
    let _ = writeln!(
        out,
        "// the `{}` wire family. Do not edit: change the Rust and rebuild.",
        subset.family.name
    );
    let _ = writeln!(
        out,
        "// Internal to the engine's tween backend (ADR 0420): never part of the public API."
    );
    let _ = writeln!(out);
    body(&mut out, subset.family, subset.consts, subset.records);
    out
}

/// A family's doc, id, constants and records (those named in `consts` and `records`, or all).
fn body(out: &mut String, family: &FamilyDesc, consts: Option<&[&str]>, records: Option<&[&str]>) {
    jsdoc(out, "", family.doc);
    let _ = writeln!(
        out,
        "export const {}_FAMILY = {{ name: \"{}\", id: {}, version: {} }} as const;",
        screaming(family.name),
        family.name,
        family.id,
        family.version
    );
    if family.name == "core" {
        let _ = writeln!(out);
        let _ = writeln!(out, "/**");
        let _ = writeln!(out, " * The header every record of every family starts with: the opcode (`u16`, the family id in the");
        let _ = writeln!(out, " * high byte, the record's kind in the low byte), then the family's version (`u16`). Fields");
        let _ = writeln!(
            out,
            " * follow, little-endian, each aligned to its size; strides are multiples of 4."
        );
        let _ = writeln!(out, " */");
        let _ = writeln!(
            out,
            "export const WIRE_HEADER = {{ bytes: {HEADER_BYTES}, opcode: {HEADER_OPCODE}, version: {HEADER_VERSION} }} as const;"
        );
    }
    for c in family.consts {
        if consts.is_some_and(|keep| !keep.contains(&c.name)) {
            continue;
        }
        let _ = writeln!(out);
        jsdoc(out, "", c.doc);
        let _ = writeln!(out, "export const {} = {};", c.name, c.value);
    }
    for record in family.records {
        if records.is_some_and(|keep| !keep.contains(&record.name)) {
            continue;
        }
        let _ = writeln!(out);
        jsdoc(out, "", record.doc);
        let _ = writeln!(out, "export const {} = {{", screaming(record.name));
        let _ = writeln!(out, "  opcode: 0x{:04x},", record.opcode);
        let _ = writeln!(out, "  version: {},", record.version);
        let _ = writeln!(out, "  stride: {},", record.stride);
        let _ = writeln!(out, "  fields: {{");
        for (i, name) in record.fields.iter().enumerate() {
            jsdoc(out, "    ", record.docs[i]);
            let _ = writeln!(
                out,
                "    {}: {{ offset: {}, type: \"{}\" }},",
                camel(name),
                record.offset(i),
                record.types[i].ts_name()
            );
        }
        let _ = writeln!(out, "  }},");
        let _ = writeln!(out, "}} as const;");
    }
}

/// The family's vectors as JSON.
pub fn vectors_json(family: &FamilyDesc) -> Result<String, String> {
    let mut out = String::new();
    let _ = writeln!(out, "{{");
    let _ = writeln!(out, "  \"family\": \"{}\",", family.name);
    let _ = writeln!(out, "  \"id\": {},", family.id);
    let _ = writeln!(out, "  \"version\": {},", family.version);
    let vectors = (family.vectors)();
    if vectors.is_empty() {
        let _ = writeln!(out, "  \"vectors\": []");
    } else {
        let _ = writeln!(out, "  \"vectors\": [");
        for (i, v) in vectors.iter().enumerate() {
            let mut values = String::new();
            for (j, (name, value)) in v.values.iter().enumerate() {
                let number = match value {
                    Value::Int(n) => n.to_string(),
                    Value::Float(f) if f.is_finite() => format!("{f}"),
                    Value::Float(_) => {
                        return Err(format!(
                            "{}/{}: vector values must be finite",
                            family.name, v.name
                        ))
                    }
                };
                let sep = if j == 0 { "" } else { ", " };
                let _ = write!(values, "{sep}\"{}\": {number}", camel(name));
            }
            let hex: String = v.bytes.iter().map(|b| format!("{b:02x}")).collect();
            let comma = if i + 1 == vectors.len() { "" } else { "," };
            let _ = writeln!(
                out,
                "    {{ \"name\": \"{}\", \"record\": \"{}\", \"values\": {{ {values} }}, \"hex\": \"{hex}\" }}{comma}",
                v.name,
                screaming(v.record)
            );
        }
        let _ = writeln!(out, "  ]");
    }
    let _ = writeln!(out, "}}");
    Ok(out)
}
