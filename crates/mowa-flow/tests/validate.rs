#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use mowa_flow::{violated_dominators, FlowDefinition, FlowError, ValidatedFlow};
use serde_json::{json, Map, Value};

fn node(id: &str, terminal: bool, edges: &[(&str, &str)]) -> Value {
    let mut tr = Map::new();
    for (event, to) in edges {
        tr.insert(
            (*event).to_string(),
            json!({"to": to, "allowedActors": ["SYSTEM"]}),
        );
    }
    json!({"id": id, "type": "t", "tier": "T1", "terminal": terminal, "transitions": tr})
}

fn flow(start: &str, nodes: Vec<Value>) -> FlowDefinition {
    let map: Map<String, Value> = nodes
        .into_iter()
        .map(|n| (n["id"].as_str().unwrap().to_string(), n))
        .collect();
    serde_json::from_value(json!({
        "id": "F", "version": "1", "status": "ACTIVE",
        "startNode": start, "startActors": ["SYSTEM"], "nodes": map, "effectiveFrom": 0,
        "declaredFacts": {
            "doc:invoice": ["MISSING", "PENDING", "VERIFIED", "CONFLICTED"],
            "policy:clear": ["PASS", "FAIL", "REVIEW"]
        }
    }))
    .unwrap()
}

fn has(errs: &[FlowError], pred: impl Fn(&FlowError) -> bool) -> bool {
    errs.iter().any(pred)
}

#[test]
fn valid_linear_flow_passes_and_hash_is_stable() {
    let mk = || {
        flow(
            "A",
            vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
        )
    };
    let a = ValidatedFlow::new(mk()).unwrap();
    let b = ValidatedFlow::new(mk()).unwrap();
    assert_eq!(a.content_hash(), b.content_hash());
    assert_eq!(a.content_hash().len(), 64);
}

#[test]
fn unknown_target_dead_end_and_unreachable_are_reported() {
    let errs = ValidatedFlow::new(flow(
        "A",
        vec![
            node("A", false, &[("go", "MISSING")]),
            node("B", false, &[]),
            node("C", true, &[]),
        ],
    ))
    .unwrap_err();
    assert!(has(&errs, |e| matches!(e, FlowError::UnknownTarget { .. })));
    assert!(has(&errs, |e| matches!(e, FlowError::DeadEnd { .. })));
    assert!(has(&errs, |e| matches!(e, FlowError::Unreachable { .. })));
}

#[test]
fn empty_allowed_actors_is_rejected() {
    let mut def = flow(
        "A",
        vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
    );
    if let Some(a) = def.nodes.get_mut("A") {
        if let Some(t) = a.transitions.get_mut("go") {
            t.allowed_actors.clear();
        }
    }
    let errs = ValidatedFlow::new(def).unwrap_err();
    assert!(has(&errs, |e| matches!(
        e,
        FlowError::NoAllowedActors { .. }
    )));
}

#[test]
fn dominance_detects_bypass_paths() {
    let with_shortcut = ValidatedFlow::new(flow(
        "A",
        vec![
            node("A", false, &[("go", "B"), ("skip", "D")]),
            node("B", false, &[("go", "C")]),
            node("C", false, &[("go", "D")]),
            node("D", true, &[]),
        ],
    ))
    .unwrap();
    assert_eq!(
        violated_dominators(&with_shortcut, "D", &["B", "C"]),
        vec!["B".to_string(), "C".to_string()]
    );

    let strict = ValidatedFlow::new(flow(
        "A",
        vec![
            node("A", false, &[("go", "B")]),
            node("B", false, &[("go", "C")]),
            node("C", false, &[("go", "D")]),
            node("D", true, &[]),
        ],
    ))
    .unwrap();
    assert!(violated_dominators(&strict, "D", &["B", "C"]).is_empty());
    assert_eq!(
        violated_dominators(&strict, "D", &["NOPE"]),
        vec!["NOPE".to_string()]
    );
}

#[test]
fn empty_start_actors_is_rejected() {
    let mut def = flow(
        "A",
        vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
    );
    def.start_actors.clear();
    let errs = ValidatedFlow::new(def).unwrap_err();
    assert!(has(&errs, |e| matches!(e, FlowError::NoStartActors)));
}

#[test]
fn content_hash_ignores_lifecycle_fields_only() {
    let mk = || {
        flow(
            "A",
            vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
        )
    };
    let base = ValidatedFlow::new(mk()).unwrap();

    let mut lifecycle = mk();
    lifecycle.status = mowa_flow::FlowStatus::Deprecated;
    lifecycle.effective_from = 5;
    lifecycle.effective_to = Some(10);
    let lifecycle = ValidatedFlow::new(lifecycle).unwrap();
    assert_eq!(base.content_hash(), lifecycle.content_hash());

    let mut behaviour = mk();
    behaviour.start_actors.insert("AUDITOR".to_string());
    let behaviour = ValidatedFlow::new(behaviour).unwrap();
    assert_ne!(base.content_hash(), behaviour.content_hash());
}

#[test]
fn guard_referencing_undeclared_fact_is_rejected() {
    let mut def = flow(
        "A",
        vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
    );
    if let Some(a) = def.nodes.get_mut("A") {
        if let Some(t) = a.transitions.get_mut("go") {
            t.guard = Some(mowa_flow::Guard::StatusIs {
                target: "doc:unknown".to_string(),
                status: "VERIFIED".to_string(),
            });
            t.on_guard_fail = Some("B".to_string());
        }
    }
    let errs = ValidatedFlow::new(def).unwrap_err();
    assert!(has(
        &errs,
        |e| matches!(e, FlowError::UndeclaredFact { fact, .. } if fact == "doc:unknown")
    ));
}

#[test]
fn guard_referencing_invalid_status_is_rejected() {
    let mut def = flow(
        "A",
        vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
    );
    if let Some(a) = def.nodes.get_mut("A") {
        if let Some(t) = a.transitions.get_mut("go") {
            t.guard = Some(mowa_flow::Guard::StatusIs {
                target: "doc:invoice".to_string(),
                status: "TYPO_STATUS".to_string(),
            });
            t.on_guard_fail = Some("B".to_string());
        }
    }
    let errs = ValidatedFlow::new(def).unwrap_err();
    assert!(has(
        &errs,
        |e| matches!(e, FlowError::InvalidFactStatus { fact, status, .. } if fact == "doc:invoice" && status == "TYPO_STATUS")
    ));
}

#[test]
fn guard_with_none_with_status_validates_prefix_and_status() {
    let mut def = flow(
        "A",
        vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
    );
    if let Some(a) = def.nodes.get_mut("A") {
        if let Some(t) = a.transitions.get_mut("go") {
            t.guard = Some(mowa_flow::Guard::NoneWithStatus {
                prefix: "doc:".to_string(),
                status: "CONFLICTED".to_string(),
            });
            t.on_guard_fail = Some("B".to_string());
        }
    }
    let validated = ValidatedFlow::new(def);
    assert!(validated.is_ok());

    // Bad prefix
    let mut def_bad_prefix = flow(
        "A",
        vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
    );
    if let Some(a) = def_bad_prefix.nodes.get_mut("A") {
        if let Some(t) = a.transitions.get_mut("go") {
            t.guard = Some(mowa_flow::Guard::NoneWithStatus {
                prefix: "nonexistent:".to_string(),
                status: "CONFLICTED".to_string(),
            });
            t.on_guard_fail = Some("B".to_string());
        }
    }
    let errs = ValidatedFlow::new(def_bad_prefix).unwrap_err();
    assert!(has(
        &errs,
        |e| matches!(e, FlowError::UndeclaredFactPrefix { prefix, .. } if prefix == "nonexistent:")
    ));
}

#[test]
fn terminal_start_node_is_rejected() {
    let def = flow("A", vec![node("A", true, &[])]);
    let errs = ValidatedFlow::new(def).unwrap_err();
    assert!(has(
        &errs,
        |e| matches!(e, FlowError::StartNodeCannotBeTerminal { node } if node == "A")
    ));
}

#[test]
fn empty_or_duplicate_fact_statuses_are_rejected() {
    let mut def = flow(
        "A",
        vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
    );
    def.declared_facts.insert(
        "doc:invoice".to_string(),
        vec!["VERIFIED".to_string(), "VERIFIED".to_string()],
    );
    let errs = ValidatedFlow::new(def).unwrap_err();
    assert!(has(
        &errs,
        |e| matches!(e, FlowError::DuplicateFactStatus { fact, status } if fact == "doc:invoice" && status == "VERIFIED")
    ));

    let mut def2 = flow(
        "A",
        vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
    );
    def2.declared_facts.insert("doc:empty".to_string(), vec![]);
    let errs2 = ValidatedFlow::new(def2).unwrap_err();
    assert!(has(
        &errs2,
        |e| matches!(e, FlowError::EmptyFactStatuses { fact } if fact == "doc:empty")
    ));
}

#[test]
fn violated_dominators_flags_non_existent_target() {
    let valid = ValidatedFlow::new(flow(
        "A",
        vec![node("A", false, &[("go", "B")]), node("B", true, &[])],
    ))
    .unwrap();
    let res = violated_dominators(&valid, "NON_EXISTENT", &["A", "B"]);
    assert_eq!(res, vec!["A".to_string(), "B".to_string()]);
}

#[test]
fn guard_rejects_unknown_fields() {
    let bad: Result<mowa_flow::Guard, _> =
        serde_json::from_str(r#"{"op":"status_is","target":"a","status":"B","extra":1}"#);
    assert!(
        bad.is_err(),
        "unknown guard fields must be rejected, not dropped from the hash"
    );
    let nested: Result<mowa_flow::Guard, _> = serde_json::from_str(
        r#"{"op":"not","guard":{"op":"status_is","target":"a","status":"B"},"onGuardFail":"x"}"#,
    );
    assert!(nested.is_err());
    let ok: Result<mowa_flow::Guard, _> =
        serde_json::from_str(r#"{"op":"status_is","target":"a","status":"B"}"#);
    assert!(ok.is_ok());
}
