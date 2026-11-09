//! Emits `vectors/wire.json` from `cases::cases()` (lead-owned, A0.2-GEN): an array of
//! `{ "name", "subject": { "type", "name"? }, "values": {..}, "hex" }` for the TypeScript round-trip
//! test. `Value::U/I/F` become numbers, `Arr` arrays, `Rec` objects (key order kept), `Str` strings.

use crate::model::Value;
use crate::vector::{Subject, VectorCase};

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn json_value(v: &Value) -> Result<String, String> {
    Ok(match v {
        Value::U(x) => {
            if *x > (1u64 << 53) {
                return Err(format!("value {x} is not exact in JSON"));
            }
            x.to_string()
        }
        Value::I(x) => x.to_string(),
        Value::F(x) => {
            if !x.is_finite() {
                return Err("NaN and infinity are not JSON".into());
            }
            format!("{x:?}")
        }
        Value::Str(s) => json_str(s),
        Value::Arr(a) => format!("[{}]", a.iter().map(json_value).collect::<Result<Vec<_>, _>>()?.join(",")),
        Value::Rec(r) => format!(
            "{{{}}}",
            r.iter().map(|(k, v)| Ok(format!("{}:{}", json_str(k), json_value(v)?))).collect::<Result<Vec<_>, String>>()?.join(",")
        ),
    })
}

pub fn emit_json(cases: &[VectorCase]) -> Result<String, String> {
    let mut rows = Vec::new();
    for c in cases {
        let subject = match &c.subject {
            Subject::Envelope => "{\"type\":\"Envelope\"}".to_string(),
            Subject::Status => "{\"type\":\"Status\"}".to_string(),
            Subject::HrirHeader => "{\"type\":\"HrirHeader\"}".to_string(),
            Subject::Kind(n) => format!("{{\"type\":\"Kind\",\"name\":{}}}", json_str(n)),
            Subject::Opcode(n) => format!("{{\"type\":\"Opcode\",\"name\":{}}}", json_str(n)),
            Subject::Batch(n) => format!("{{\"type\":\"Batch\",\"name\":{}}}", json_str(n)),
        };
        let values = json_value(&Value::Rec(c.values.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()))?;
        rows.push(format!("  {{\"name\":{},\"subject\":{},\"values\":{},\"hex\":{}}}", json_str(c.name), subject, values, json_str(c.hex)));
    }
    Ok(if rows.is_empty() { "[]\n".to_string() } else { format!("[\n{}\n]\n", rows.join(",\n")) })
}
