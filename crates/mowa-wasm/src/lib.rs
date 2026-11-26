//! WASM boundary: one JSON string in, one JSON string out.
//!
//! Specified in docs/host-contract.md, section 1 (all JSON camelCase, see `mowa-core` types):
//!   startJson     request = { sessionId, event, flow, ctx }
//!   advanceJson   request = { session, event, flow, facts, ctx }
//!   loadFlowJson  request = FlowDefinition JSON
//!                 response = { status: "OK", flowHandle, flowHash } | { status: "FLOW_INVALID", errors }
//!   dedupKeyJson  request = { op: "START" | "ADVANCE", sessionId, event }
//!                 response = { status: "OK", dedupKey } | { status: "BAD_REQUEST", reason }
//!   kernelVersion response = string (e.g. "0.5.2")
//!
//! In `startJson` and `advanceJson`, the `flow` field can be EITHER:
//!   1. A full `FlowDefinition` JSON object, OR
//!   2. A cached `flowHandle` string returned by `loadFlowJson`.
//!
//! Using `flowHandle` avoids re-parsing, re-validating and re-hashing the flow graph on
//! every call. Cached flows are shared, not copied, so a call with a handle costs the
//! same whatever the size of the flow.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use mowa_core::{
    advance, advance_dedup_key, start, start_dedup_key, AdvanceInput, CanonicalEvent, Commit,
    DecisionContext, DecisionFacts, KernelError, StartInput, WorkflowSession,
};
use mowa_flow::{FlowDefinition, FlowError, ValidatedFlow};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

const MAX_CACHE_CAPACITY: usize = 32;

static FLOW_CACHE: Mutex<BTreeMap<String, (u64, Arc<ValidatedFlow>)>> = Mutex::new(BTreeMap::new());
static ACCESS_COUNTER: Mutex<u64> = Mutex::new(0);

fn next_counter() -> u64 {
    if let Ok(mut c) = ACCESS_COUNTER.lock() {
        *c = c.wrapping_add(1);
        *c
    } else {
        0
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum FlowInput {
    Handle(String),
    Def(Box<FlowDefinition>),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdvanceRequest {
    session: WorkflowSession,
    event: CanonicalEvent,
    flow: FlowInput,
    #[serde(default)]
    facts: DecisionFacts,
    ctx: DecisionContext,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartRequest {
    session_id: String,
    event: CanonicalEvent,
    flow: FlowInput,
    ctx: DecisionContext,
}

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum DedupOp {
    Start,
    Advance,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DedupRequest {
    op: DedupOp,
    session_id: String,
    event: CanonicalEvent,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
enum Response {
    Ok { commit: Box<Commit> },
    KernelError { error: KernelError },
    FlowInvalid { errors: Vec<FlowError> },
    FlowHandleNotFound { handle: String },
    BadRequest { reason: String },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
enum LoadFlowResponse {
    #[serde(rename_all = "camelCase")]
    Ok {
        flow_handle: String,
        flow_hash: String,
    },
    FlowInvalid {
        errors: Vec<FlowError>,
    },
    BadRequest {
        reason: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
enum DedupResponse {
    #[serde(rename_all = "camelCase")]
    Ok {
        dedup_key: String,
        intent_hash: String,
    },
    BadRequest {
        reason: String,
    },
}

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| String::from(r#"{"status":"INTERNAL_ERROR"}"#))
}

fn cache_key_for(flow: &ValidatedFlow) -> String {
    let def = flow.definition();
    format!(
        "{}:{:#?}:{}:{}",
        flow.content_hash(),
        def.status,
        def.effective_from,
        def.effective_to.unwrap_or(-1)
    )
}

fn store_in_cache(flow: Arc<ValidatedFlow>) -> String {
    let key = cache_key_for(&flow);
    let counter = next_counter();
    if let Ok(mut cache) = FLOW_CACHE.lock() {
        if cache.len() >= MAX_CACHE_CAPACITY && !cache.contains_key(&key) {
            // Evict least-recently-used key
            if let Some((lru_key, _)) = cache
                .iter()
                .min_by_key(|(_, (c, _))| *c)
                .map(|(k, (c, _))| (k.clone(), *c))
            {
                cache.remove(&lru_key);
            }
        }
        cache.insert(key.clone(), (counter, flow));
    }
    key
}

fn resolve_flow(input: FlowInput) -> Result<Arc<ValidatedFlow>, Response> {
    match input {
        FlowInput::Handle(handle) => {
            if let Ok(mut cache) = FLOW_CACHE.lock() {
                if let Some((counter, flow)) = cache.get_mut(&handle) {
                    *counter = next_counter();
                    return Ok(Arc::clone(flow));
                }
            }
            Err(Response::FlowHandleNotFound { handle })
        }
        FlowInput::Def(def) => match ValidatedFlow::new(*def) {
            Err(errors) => Err(Response::FlowInvalid { errors }),
            Ok(flow) => {
                let flow = Arc::new(flow);
                store_in_cache(Arc::clone(&flow));
                Ok(flow)
            }
        },
    }
}

pub fn load_flow_json_impl(input: &str) -> String {
    let response = match serde_json::from_str::<FlowDefinition>(input) {
        Err(e) => LoadFlowResponse::BadRequest {
            reason: e.to_string(),
        },
        Ok(def) => match ValidatedFlow::new(def) {
            Err(errors) => LoadFlowResponse::FlowInvalid { errors },
            Ok(flow) => {
                let flow_hash = flow.content_hash().to_owned();
                let flow_handle = store_in_cache(Arc::new(flow));
                LoadFlowResponse::Ok {
                    flow_handle,
                    flow_hash,
                }
            }
        },
    };
    to_json(&response)
}

pub fn advance_json_impl(input: &str) -> String {
    let response = match serde_json::from_str::<AdvanceRequest>(input) {
        Err(e) => Response::BadRequest {
            reason: e.to_string(),
        },
        Ok(req) => match resolve_flow(req.flow) {
            Err(resp) => resp,
            Ok(flow) => match advance(AdvanceInput {
                session: &req.session,
                event: &req.event,
                flow: &flow,
                facts: &req.facts,
                ctx: &req.ctx,
            }) {
                Ok(commit) => Response::Ok {
                    commit: Box::new(commit),
                },
                Err(error) => Response::KernelError { error },
            },
        },
    };
    to_json(&response)
}

pub fn start_json_impl(input: &str) -> String {
    let response = match serde_json::from_str::<StartRequest>(input) {
        Err(e) => Response::BadRequest {
            reason: e.to_string(),
        },
        Ok(req) => match resolve_flow(req.flow) {
            Err(resp) => resp,
            Ok(flow) => match start(StartInput {
                session_id: &req.session_id,
                event: &req.event,
                flow: &flow,
                ctx: &req.ctx,
            }) {
                Ok(commit) => Response::Ok {
                    commit: Box::new(commit),
                },
                Err(error) => Response::KernelError { error },
            },
        },
    };
    to_json(&response)
}

pub fn dedup_key_json_impl(input: &str) -> String {
    let response = match serde_json::from_str::<DedupRequest>(input) {
        Err(e) => DedupResponse::BadRequest {
            reason: e.to_string(),
        },
        Ok(req) => {
            let intent_hash = mowa_core::ids::intent_hash(&req.event);
            DedupResponse::Ok {
                dedup_key: match req.op {
                    DedupOp::Start => start_dedup_key(&req.session_id, &req.event),
                    DedupOp::Advance => advance_dedup_key(&req.session_id, &req.event),
                },
                intent_hash,
            }
        }
    };
    to_json(&response)
}

#[wasm_bindgen(js_name = loadFlowJson)]
pub fn load_flow_json(input: &str) -> String {
    load_flow_json_impl(input)
}

#[wasm_bindgen(js_name = advanceJson)]
pub fn advance_json(input: &str) -> String {
    advance_json_impl(input)
}

#[wasm_bindgen(js_name = startJson)]
pub fn start_json(input: &str) -> String {
    start_json_impl(input)
}

#[wasm_bindgen(js_name = dedupKeyJson)]
pub fn dedup_key_json(input: &str) -> String {
    dedup_key_json_impl(input)
}

#[wasm_bindgen(js_name = kernelVersion)]
pub fn kernel_version() -> String {
    mowa_core::KERNEL_VERSION.to_string()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn flow_json() -> Value {
        json!({
            "id": "F", "version": "1", "status": "ACTIVE", "startNode": "A",
            "startActors": ["SYSTEM"], "effectiveFrom": 0,
            "declaredFacts": {
                "doc:invoice": ["VERIFIED", "MISSING"]
            },
            "nodes": {
                "A": {
                    "id": "A", "type": "t", "tier": "T1",
                    "transitions": {
                        "go": {
                            "to": "B", "allowedActors": ["SYSTEM"],
                            "guard": {"op": "status_is", "target": "doc:invoice", "status": "VERIFIED"},
                            "onGuardFail": "B"
                        }
                    }
                },
                "B": {"id": "B", "type": "t", "tier": "T1", "terminal": true}
            }
        })
    }

    fn event_json(event_type: &str) -> Value {
        json!({
            "id": "E", "type": event_type, "source": "t", "caseId": "C", "timestamp": 1,
            "idempotencyKey": "k", "actor": {"type": "SYSTEM", "id": "x"}, "payload": {}
        })
    }

    fn ctx_json() -> Value {
        json!({"asOf": 10, "contextRefs": {"snapshotId": "S1"}})
    }

    fn call(f: fn(&str) -> String, req: &Value) -> Value {
        serde_json::from_str(&f(&req.to_string())).unwrap()
    }

    fn started_session() -> Value {
        let req = json!({
            "sessionId": "S", "event": event_json("OPEN"),
            "flow": flow_json(), "ctx": ctx_json()
        });
        let out = call(start_json_impl, &req);
        assert_eq!(out["status"], "OK");
        out["commit"]["newSession"].clone()
    }

    fn advance_request(session: Value, event_type: &str, facts: Value) -> Value {
        json!({
            "session": session, "event": event_json(event_type), "flow": flow_json(),
            "facts": facts, "ctx": ctx_json()
        })
    }

    #[test]
    fn start_then_advance_round_trip() {
        let session = started_session();
        assert_eq!(session["state"], "A");
        assert_eq!(session["version"], 0);

        let facts = json!({"facts": {"doc:invoice": "VERIFIED"}});
        let out = call(advance_json_impl, &advance_request(session, "go", facts));
        assert_eq!(out["status"], "OK");
        assert_eq!(out["commit"]["newSession"]["state"], "B");
        assert_eq!(out["commit"]["expectedSessionVersion"], 0);
    }

    #[test]
    fn cached_flow_handle_works_for_start_and_advance() {
        let load_out = call(load_flow_json_impl, &flow_json());
        assert_eq!(load_out["status"], "OK");
        let handle = load_out["flowHandle"].as_str().unwrap();

        let start_req = json!({
            "sessionId": "S_CACHED", "event": event_json("OPEN"),
            "flow": handle, "ctx": ctx_json()
        });
        let start_out = call(start_json_impl, &start_req);
        assert_eq!(start_out["status"], "OK");
        let session = start_out["commit"]["newSession"].clone();

        let adv_req = json!({
            "session": session, "event": event_json("go"), "flow": handle,
            "facts": {"facts": {"doc:invoice": "VERIFIED"}}, "ctx": ctx_json()
        });
        let adv_out = call(advance_json_impl, &adv_req);
        assert_eq!(adv_out["status"], "OK");
        assert_eq!(adv_out["commit"]["newSession"]["state"], "B");
    }

    #[test]
    fn missing_flow_handle_returns_bad_request() {
        let adv_req = json!({
            "session": started_session(), "event": event_json("go"), "flow": "nonexistent_handle",
            "facts": {}, "ctx": ctx_json()
        });
        let out = call(advance_json_impl, &adv_req);
        assert_eq!(out["status"], "FLOW_HANDLE_NOT_FOUND");
        assert_eq!(out["handle"], "nonexistent_handle");
    }

    #[test]
    fn start_commit_is_an_insert() {
        let req = json!({
            "sessionId": "S", "event": event_json("OPEN"),
            "flow": flow_json(), "ctx": ctx_json()
        });
        let out = call(start_json_impl, &req);
        assert_eq!(out["commit"]["expectedSessionVersion"], Value::Null);
        assert_eq!(out["commit"]["audit"]["fromState"], Value::Null);
    }

    #[test]
    fn errors_are_structured_not_panics() {
        let out = call(
            advance_json_impl,
            &advance_request(started_session(), "nope", json!({})),
        );
        assert_eq!(out["status"], "KERNEL_ERROR");
        assert_eq!(out["error"]["code"], "NO_TRANSITION");

        let out: Value = serde_json::from_str(&advance_json_impl("{not json")).unwrap();
        assert_eq!(out["status"], "BAD_REQUEST");
    }

    #[test]
    fn dedup_key_matches_the_commit() {
        let session = started_session();
        let facts = json!({"facts": {"doc:invoice": "VERIFIED"}});
        let commit = call(advance_json_impl, &advance_request(session, "go", facts));
        let req = json!({"op": "ADVANCE", "sessionId": "S", "event": event_json("go")});
        let out = call(dedup_key_json_impl, &req);
        assert_eq!(out["status"], "OK");
        assert_eq!(out["dedupKey"], commit["commit"]["dedupKey"]);
        assert!(out["intentHash"].is_string());
    }
}
