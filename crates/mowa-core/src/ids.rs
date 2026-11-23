//! Deterministic identifiers. Every formula is SHA-256 over canonical JSON
//! (`mowa_canon`), so external hosts can reproduce each one byte-for-byte.
//! Version numbers and indices are encoded as decimal strings, never JSON numbers.

use std::collections::BTreeMap;

use mowa_canon::{canonical_hash, to_value, Value};

use crate::types::CanonicalEvent;

/// Semantic intent hash of an event: `hash({actor, caseId, effectiveAt, payload, source, type})`.
/// Excludes ephemeral transport identifiers (`id`, `timestamp`, `idempotencyKey`) so that
/// client retries with newly generated IDs map to the same business intent.
pub fn intent_hash(event: &CanonicalEvent) -> String {
    let actor_val = to_value(&event.actor).unwrap_or(Value::Null);
    let payload_val = to_value(&event.payload).unwrap_or(Value::Null);
    let effective_val = event
        .effective_at
        .map_or(Value::Null, |t| Value::Str(t.to_string()));
    canonical_hash(&obj([
        ("actor", actor_val),
        ("caseId", Value::Str(event.case_id.clone())),
        ("effectiveAt", effective_val),
        ("payload", payload_val),
        ("source", Value::Str(event.source.clone())),
        ("type", Value::Str(event.event_type.clone())),
    ]))
}

/// Dedup key for `start`. Pure in `(session_id, event)`: compute it BEFORE calling the
/// kernel. Choose `session_id` deterministically (e.g. from case + workflow) so that a
/// redelivered start event maps to the same key.
pub fn start_dedup_key(session_id: &str, event: &CanonicalEvent) -> String {
    dedup_key("start", session_id, event)
}

/// Dedup key for `advance`. Pure in `(session_id, event)`: compute it BEFORE calling
/// the kernel. Scoped to the session, so one event delivered to several sessions of
/// the same case is processed once by each.
pub fn advance_dedup_key(session_id: &str, event: &CanonicalEvent) -> String {
    dedup_key("advance", session_id, event)
}

/// `hash({op, sessionId, caseId, idempotencyKey})`.
fn dedup_key(op: &str, session_id: &str, event: &CanonicalEvent) -> String {
    canonical_hash(&obj([
        ("op", Value::Str(op.to_owned())),
        ("sessionId", Value::Str(session_id.to_owned())),
        ("caseId", Value::Str(event.case_id.clone())),
        ("idempotencyKey", Value::Str(event.idempotency_key.clone())),
    ]))
}

/// `"tr_" + first 32 hex of hash({sessionId, fromVersion, eventHash})`.
/// `fromVersion` is `null` for the genesis record. Under CAS at most one step can
/// commit from a given `(session, version)`, so this is unique per committed step.
pub fn transition_id(session_id: &str, from_version: Option<u64>, event_hash: &str) -> String {
    let from = from_version.map_or(Value::Null, |v| Value::Str(v.to_string()));
    let h = canonical_hash(&obj([
        ("sessionId", Value::Str(session_id.to_owned())),
        ("fromVersion", from),
        ("eventHash", Value::Str(event_hash.to_owned())),
    ]));
    format!("tr_{}", short(&h))
}

/// First 32 hex of `hash({transitionId, index})`.
pub fn effect_id(transition_id: &str, index: usize) -> String {
    short(&canonical_hash(&obj([
        ("transitionId", Value::Str(transition_id.to_owned())),
        ("index", Value::Str(index.to_string())),
    ])))
}

fn obj<const N: usize>(entries: [(&str, Value); N]) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect::<BTreeMap<_, _>>(),
    )
}

fn short(hex: &str) -> String {
    hex.chars().take(32).collect()
}
