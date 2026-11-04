//! The WebAssembly boundary of Myco's navigation (ADR 0065). The TypeScript side loads this module
//! on demand (`src/engine/nav/`) and talks to it in bulk through typed-array views of its memory.
use nav_format::file::{read, read_header, SectionKind};
use nav_math::hash::fingerprint_hex;
use wasm_bindgen::prelude::*;

/// The crate's version, for the loader to check against the TypeScript side.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// A summary of a `myco.nav@1` bake file as JSON (for the editor's asset inspector and tests):
/// `{ "packageVersion", "signature", "sections": [{ "kind", "group", "group2", "length", "fingerprint" }] }`,
/// or `{ "error" }`. With `verify`, the whole file is parsed and every section's fingerprint checked.
#[wasm_bindgen(js_name = bakeInfo)]
pub fn bake_info(bytes: &[u8], verify: bool) -> String {
    let header = match read_header(bytes) {
        Ok(h) => h,
        Err(e) => return error_json(&e.to_string()),
    };
    if verify {
        if let Err(e) = read(bytes) {
            return error_json(&e.to_string());
        }
    }
    let [a, b, c] = header.package_version;
    let sections: Vec<String> = header
        .sections
        .iter()
        .map(|s| {
            format!(
                r#"{{"kind":"{}","group":{},"group2":{},"length":{},"fingerprint":"{}"}}"#,
                kind_name(s.kind),
                s.group,
                s.group2,
                s.length,
                fingerprint_hex(s.fingerprint)
            )
        })
        .collect();
    format!(
        r#"{{"packageVersion":"{a}.{b}.{c}","signature":"{}","sections":[{}]}}"#,
        header.signature.to_hex(),
        sections.join(",")
    )
}

fn kind_name(kind: SectionKind) -> &'static str {
    match kind {
        SectionKind::NavMesh => "navmesh",
        SectionKind::Volume => "volume",
        SectionKind::LandingLinks => "landingLinks",
        SectionKind::GateTable => "gateTable",
        SectionKind::ChunkBorder => "chunkBorder",
        SectionKind::Formation => "formation",
        SectionKind::AgentTable => "agentTable",
        SectionKind::ChunkInfo => "chunkInfo",
    }
}

fn error_json(message: &str) -> String {
    let escaped: String = message.chars().flat_map(|c| match c {
        '"' => vec!['\\', '"'],
        '\\' => vec!['\\', '\\'],
        c if c.is_control() => vec![' '],
        c => vec![c],
    }).collect();
    format!(r#"{{"error":"{escaped}"}}"#)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nav_format::file::{write, BakeFile};

    #[test]
    fn summarises_a_bake_and_reports_errors() {
        let bytes = write(&BakeFile::default());
        let info = bake_info(&bytes, true);
        assert!(info.starts_with(r#"{"packageVersion":"#), "{info}");
        assert!(info.contains(r#""sections":[]"#), "{info}");
        assert!(bake_info(b"not a bake", false).starts_with(r#"{"error":"#));
    }
}
