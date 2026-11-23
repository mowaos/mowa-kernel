//! Deterministic value model, canonical JSON and hashing.
//!
//! Canonical form = RFC 8785 (JCS) restricted to a float-free subset:
//! * numbers are integers within ±(2^53 − 1) (safe for JS hosts); floats are rejected,
//! * object keys are sorted by UTF-16 code units (as JCS requires; this differs from
//!   UTF-8 byte order for supplementary-plane characters),
//! * strings use the JCS escape set, everything else is emitted as literal UTF-8.
//!
//! Every hash in the kernel (idempotency key, result hash, flow hash) is SHA-256 over
//! this form, so external hosts can reproduce it byte-for-byte.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

/// Largest integer magnitude that round-trips through an IEEE-754 double.
pub const MAX_SAFE_INT: i64 = 9_007_199_254_740_991;

/// JSON-like value with no floats and deterministic (sorted) object iteration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonError {
    Float,
    IntOutOfRange,
    Json(String),
}

impl fmt::Display for CanonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CanonError::Float => f.write_str("floating-point numbers are not permitted"),
            CanonError::IntOutOfRange => f.write_str("integer outside +/-(2^53-1)"),
            CanonError::Json(m) => write!(f, "invalid JSON: {m}"),
        }
    }
}

impl std::error::Error for CanonError {}

impl Value {
    /// Convert from `serde_json::Value`, rejecting floats and unsafe integers.
    pub fn from_json(v: serde_json::Value) -> Result<Value, CanonError> {
        use serde_json::Value as J;
        match v {
            J::Null => Ok(Value::Null),
            J::Bool(b) => Ok(Value::Bool(b)),
            J::Number(n) => match n.as_i64() {
                Some(i) if (-MAX_SAFE_INT..=MAX_SAFE_INT).contains(&i) => Ok(Value::Int(i)),
                Some(_) => Err(CanonError::IntOutOfRange),
                None if n.is_f64() => Err(CanonError::Float),
                None => Err(CanonError::IntOutOfRange),
            },
            J::String(s) => Ok(Value::Str(s)),
            J::Array(a) => a
                .into_iter()
                .map(Value::from_json)
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array),
            J::Object(o) => o
                .into_iter()
                .map(|(k, v)| Value::from_json(v).map(|v| (k, v)))
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map(Value::Object),
        }
    }

    /// Parse JSON text. NOTE: duplicate object keys are resolved last-wins by
    /// serde_json; reject them at the ingress boundary if that matters.
    pub fn from_json_str(s: &str) -> Result<Value, CanonError> {
        let j: serde_json::Value =
            serde_json::from_str(s).map_err(|e| CanonError::Json(e.to_string()))?;
        Value::from_json(j)
    }
}

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Null => s.serialize_unit(),
            Value::Bool(b) => s.serialize_bool(*b),
            Value::Int(i) => s.serialize_i64(*i),
            Value::Str(x) => s.serialize_str(x),
            Value::Array(a) => s.collect_seq(a),
            Value::Object(m) => s.collect_map(m),
        }
    }
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let j = serde_json::Value::deserialize(d)?;
        Value::from_json(j).map_err(serde::de::Error::custom)
    }
}

/// Serialize any `Serialize` type into the canonical value model.
pub fn to_value<T: Serialize>(t: &T) -> Result<Value, CanonError> {
    let j = serde_json::to_value(t).map_err(|e| CanonError::Json(e.to_string()))?;
    Value::from_json(j)
}

/// Canonical JSON text of a value.
pub fn canonical_string(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, &mut out);
    out
}

/// SHA-256 (lowercase hex) of the canonical JSON of a value.
pub fn canonical_hash(v: &Value) -> String {
    sha256_hex(canonical_string(v).as_bytes())
}

/// SHA-256 (lowercase hex) of the canonical JSON of any `Serialize` type.
pub fn hash_of<T: Serialize>(t: &T) -> Result<String, CanonError> {
    Ok(canonical_hash(&to_value(t)?))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for &b in digest.iter() {
        s.push(hex_digit(u32::from(b >> 4)));
        s.push(hex_digit(u32::from(b & 0x0f)));
    }
    s
}

fn hex_digit(n: u32) -> char {
    char::from_digit(n, 16).unwrap_or('0')
}

fn write_value(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Int(i) => out.push_str(&i.to_string()),
        Value::Str(s) => write_string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut entries: Vec<(&String, &Value)> = m.iter().collect();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (i, (k, val)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(k, out);
                out.push(':');
                write_value(val, out);
            }
            out.push('}');
        }
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0C}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                let n = c as u32;
                out.push_str("\\u00");
                out.push(hex_digit(n >> 4));
                out.push(hex_digit(n & 0x0f));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn keys_are_sorted_regardless_of_input_order() {
        let v = Value::from_json_str(r#"{"b":1,"a":[true,null],"c":"x"}"#).unwrap();
        assert_eq!(canonical_string(&v), r#"{"a":[true,null],"b":1,"c":"x"}"#);
    }

    #[test]
    fn floats_are_rejected() {
        assert_eq!(Value::from_json_str(r#"{"x":1.5}"#), Err(CanonError::Float));
        assert_eq!(Value::from_json_str("1.0"), Err(CanonError::Float));
        assert_eq!(Value::from_json_str("1e3"), Err(CanonError::Float));
    }

    #[test]
    fn unsafe_integers_are_rejected() {
        assert_eq!(
            Value::from_json_str("9007199254740992"),
            Err(CanonError::IntOutOfRange)
        );
        assert_eq!(
            Value::from_json_str("12345678901234567890"),
            Err(CanonError::IntOutOfRange)
        );
        assert!(Value::from_json_str("9007199254740991").is_ok());
    }

    #[test]
    fn string_escaping_follows_jcs() {
        let v = Value::Str("a\"b\\c\n\t\u{01}\u{7f}é".to_string());
        assert_eq!(canonical_string(&v), "\"a\\\"b\\\\c\\n\\t\\u0001\u{7f}é\"");
    }

    #[test]
    fn keys_sort_by_utf16_not_utf8() {
        let mut m = BTreeMap::new();
        m.insert("\u{FFFF}".to_string(), Value::Int(2));
        m.insert("\u{10000}".to_string(), Value::Int(1));
        let s = canonical_string(&Value::Object(m));
        assert_eq!(s, format!("{{\"{}\":1,\"{}\":2}}", '\u{10000}', '\u{FFFF}'));
    }

    #[test]
    fn sha256_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    fn arb_value() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            (-MAX_SAFE_INT..=MAX_SAFE_INT).prop_map(Value::Int),
            ".{0,8}".prop_map(Value::Str),
        ];
        leaf.prop_recursive(4, 32, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
                prop::collection::btree_map(".{0,4}", inner, 0..4).prop_map(Value::Object),
            ]
        })
    }

    proptest! {
        #[test]
        fn canonical_form_round_trips_and_is_stable(v in arb_value()) {
            let text = canonical_string(&v);
            let parsed = Value::from_json_str(&text).unwrap();
            prop_assert_eq!(&parsed, &v);
            prop_assert_eq!(canonical_string(&parsed), text);
        }
    }
}
