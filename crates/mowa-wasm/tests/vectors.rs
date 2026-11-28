//! Runs the spec vectors in `docs/vectors/` against the native build, through the same
//! JSON entry points the WASM build exports. js-smoke runs the same vectors against WASM
//! and also recomputes every hash independently; this test proves that native code
//! reaches the same decisions, so a host that links the crate directly stays conformant.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic
)]

use std::path::PathBuf;

use mowa_wasm::{advance_json_impl, dedup_key_json_impl, load_flow_json_impl, start_json_impl};
use serde_json::{Map, Value};

fn vector(name: &str) -> Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "docs",
        "vectors",
        name,
    ]
    .iter()
    .collect();
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn call(f: fn(&str) -> String, req: &Value) -> Value {
    serde_json::from_str(&f(&req.to_string())).unwrap()
}

/// JSON merge patch (RFC 7386).
fn merge_patch(target: &Value, patch: &Value) -> Value {
    let Value::Object(p) = patch else {
        return patch.clone();
    };
    let mut out = match target {
        Value::Object(t) => t.clone(),
        _ => Map::new(),
    };
    for (k, v) in p {
        if v.is_null() {
            out.remove(k);
        } else {
            let merged = merge_patch(out.get(k).unwrap_or(&Value::Null), v);
            out.insert(k.clone(), merged);
        }
    }
    Value::Object(out)
}

/// Shallow merge: fields in `over` replace those in `base` one by one.
fn with_defaults(base: &Value, over: Option<&Value>) -> Value {
    let mut out = base.as_object().cloned().unwrap_or_default();
    if let Some(Value::Object(o)) = over {
        for (k, v) in o {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

fn step_ref<'a>(results: &'a [Value], expect: &Value, key: &str) -> Option<&'a Value> {
    expect
        .get(key)
        .map(|i| &results[usize::try_from(i.as_u64().unwrap()).unwrap()])
}

#[test]
fn kernel_conformance_vectors() {
    let v = vector("kernel-conformance.json");
    let cases = v["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    let empty = Value::Object(Map::new());
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let mut session: Option<Value> = None;
        let mut results: Vec<Value> = Vec::new();
        for (i, step) in c["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{name} [step {i}]");
            let flow = merge_patch(&v["flow"], step.get("flowPatch").unwrap_or(&empty));
            let event = with_defaults(&v["eventDefaults"], step.get("event"));
            let ctx = with_defaults(&v["ctxDefaults"], step.get("ctx"));
            let facts = step
                .get("facts")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({ "facts": {} }));
            let expect = step.get("expect").unwrap_or(&empty);

            match step["call"].as_str().unwrap() {
                "dedupKey" => {
                    let req = serde_json::json!({
                        "op": step["op"], "sessionId": step["sessionId"], "event": event,
                    });
                    let out = call(dedup_key_json_impl, &req);
                    assert_eq!(out["status"], "OK", "{label}");
                    for (key, field, equal) in [
                        ("dedupKeyEqualsStep", "dedupKey", true),
                        ("dedupKeyDiffersFromStep", "dedupKey", false),
                        ("intentHashEqualsStep", "intentHash", true),
                        ("intentHashDiffersFromStep", "intentHash", false),
                    ] {
                        if let Some(other) = step_ref(&results, expect, key) {
                            assert_eq!(out[field] == other[field], equal, "{label} {key}");
                        }
                    }
                    results.push(out);
                    continue;
                }
                "start" => {
                    let req = serde_json::json!({
                        "sessionId": step["sessionId"], "event": event, "flow": flow, "ctx": ctx,
                    });
                    let out = call(start_json_impl, &req);
                    check_step(&label, &out, expect, None, &results);
                    results.push(result_of(&out));
                    if out["status"] == "OK" {
                        session = Some(out["commit"]["newSession"].clone());
                    }
                }
                "advance" => {
                    let prev = session.clone().expect("advance needs a session");
                    let req = serde_json::json!({
                        "session": prev, "event": event, "flow": flow, "facts": facts, "ctx": ctx,
                    });
                    let out = call(advance_json_impl, &req);
                    check_step(&label, &out, expect, Some(&prev), &results);
                    results.push(result_of(&out));
                    if out["status"] == "OK" {
                        session = Some(out["commit"]["newSession"].clone());
                    }
                }
                other => panic!("{label}: unknown call {other}"),
            }
        }
    }
}

/// What later steps compare against: the audit record of a commit, or the error reply.
fn result_of(out: &Value) -> Value {
    if out["status"] == "OK" {
        out["commit"]["audit"].clone()
    } else {
        out.clone()
    }
}

fn check_step(label: &str, out: &Value, expect: &Value, prev: Option<&Value>, results: &[Value]) {
    assert_eq!(out["status"], expect["status"], "{label} status: {out}");
    if out["status"] == "KERNEL_ERROR" {
        assert_eq!(out["error"]["code"], expect["code"], "{label} error code");
        if let Some(Value::Object(fields)) = expect.get("error") {
            for (k, want) in fields {
                assert_eq!(&out["error"][k], want, "{label} error.{k}");
            }
        }
        return;
    }
    let commit = &out["commit"];
    let audit = &commit["audit"];
    assert_eq!(
        commit["newSession"]["state"], expect["state"],
        "{label} state"
    );
    assert_eq!(
        commit["newSession"]["version"], expect["version"],
        "{label} version"
    );
    for key in ["fromState", "guardFailed"] {
        if let Some(want) = expect.get(key) {
            assert_eq!(&audit[key], want, "{label} {key}");
        }
    }
    if let Some(want) = expect.get("outbox") {
        let kinds: Vec<&Value> = commit["outbox"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| &e["kind"])
            .collect();
        let want: Vec<&Value> = want.as_array().unwrap().iter().collect();
        assert_eq!(kinds, want, "{label} outbox kinds");
    }
    if let Some(other) = step_ref(results, expect, "transitionIdDiffersFromStep") {
        assert_ne!(
            audit["transitionId"], other["transitionId"],
            "{label} transitionId"
        );
    }
    // Chain links: the same checks js-smoke makes, minus the independent hashing.
    assert_eq!(
        commit["newSession"]["lastResultHash"], audit["resultHash"],
        "{label} lastResultHash"
    );
    let (prev_hash, from_version) = match prev {
        Some(s) => (s["lastResultHash"].clone(), s["version"].clone()),
        None => (Value::Null, Value::Null),
    };
    assert_eq!(audit["prevResultHash"], prev_hash, "{label} prevResultHash");
    assert_eq!(
        commit["expectedSessionVersion"], from_version,
        "{label} expectedSessionVersion"
    );
    assert_eq!(
        audit["kernelVersion"],
        mowa_core::KERNEL_VERSION,
        "{label} kernelVersion"
    );
}

#[test]
fn flow_validation_vectors() {
    let v = vector("flow-validation.json");
    let base = call(load_flow_json_impl, &v["flow"]);
    assert_eq!(base["status"], "OK");
    for c in v["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let flow = merge_patch(&v["flow"], &c["patch"]);
        let out = call(load_flow_json_impl, &flow);
        assert_eq!(out["status"], c["expect"]["status"], "{name}: {out}");
        if out["status"] == "FLOW_INVALID" {
            let mut codes: Vec<String> = out["errors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["code"].as_str().unwrap().to_owned())
                .collect();
            codes.sort();
            let want: Vec<String> = serde_json::from_value(c["expect"]["codes"].clone()).unwrap();
            assert_eq!(codes, want, "{name}");
        }
        if out["status"] == "OK" {
            if let Some(same) = c["expect"].get("sameHashAsBase") {
                let equal = out["flowHash"] == base["flowHash"];
                assert_eq!(Value::Bool(equal), *same, "{name}");
            }
        }
    }
}

#[test]
fn basic_approval_vector() {
    let v = vector("basic-approval.json");
    let (inputs, outputs) = (&v["inputs"], &v["outputs"]);
    let mut start_req = inputs["start"].clone();
    start_req["flow"] = inputs["flow"].clone();
    let s = call(start_json_impl, &start_req);
    assert_eq!(s["status"], "OK", "{s}");
    let mut adv_req = inputs["advance"].clone();
    adv_req["session"] = s["commit"]["newSession"].clone();
    adv_req["flow"] = inputs["flow"].clone();
    let a = call(advance_json_impl, &adv_req);
    assert_eq!(a["status"], "OK", "{a}");

    for (step, got, want) in [
        ("start", &s["commit"], &outputs["start"]),
        ("advance", &a["commit"], &outputs["advance"]),
    ] {
        for k in [
            "flowHash",
            "factsHash",
            "decisionHash",
            "transitionId",
            "toState",
        ] {
            assert_eq!(got["audit"][k], want["audit"][k], "{step} {k}");
        }
        assert_eq!(got["dedupKey"], want["dedupKey"], "{step} dedupKey");
        assert_eq!(got["outbox"], want["outbox"], "{step} outbox");
        // When the vector was produced by this kernel version, the whole commit must match.
        if want["audit"]["kernelVersion"] == mowa_core::KERNEL_VERSION {
            assert_eq!(got, want, "{step} commit");
        }
    }
}

#[test]
fn vectors_were_produced_by_the_current_kernel_version() {
    let v = vector("basic-approval.json");
    assert_eq!(
        v["outputs"]["start"]["audit"]["kernelVersion"],
        mowa_core::KERNEL_VERSION,
        "update the version-dependent fields of docs/vectors on a version bump (docs/releasing.md)"
    );
}
