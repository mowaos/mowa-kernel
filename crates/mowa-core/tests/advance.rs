#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]

use std::collections::BTreeMap;

use mowa_core::{
    advance, advance_dedup_key, start, start_dedup_key, AdvanceInput, CanonicalEvent, Commit,
    DecisionContext, DecisionFacts, KernelError, StartInput, WorkflowSession,
};
use mowa_flow::{FlowDefinition, FlowStatus, ValidatedFlow};
use proptest::prelude::*;
use serde_json::json;

fn flow_def() -> FlowDefinition {
    serde_json::from_value(json!({
        "id": "TEST_FLOW", "version": "1", "status": "ACTIVE",
        "startNode": "INTAKE", "startActors": ["CLIENT", "SYSTEM"], "effectiveFrom": 0,
        "declaredFacts": {
            "doc:identity": ["UNVERIFIED", "VERIFIED", "CONFLICTED"],
            "doc:income": ["UNVERIFIED", "VERIFIED", "CONFLICTED"]
        },
        "nodes": {
            "INTAKE": {
                "id": "INTAKE", "type": "t", "tier": "T1",
                "onEnter": [{"kind": "WELCOME"}],
                "transitions": {
                    "INTAKE_COMPLETED": {"to": "COLLECTION", "allowedActors": ["CLIENT", "SYSTEM"]}
                }
            },
            "COLLECTION": {
                "id": "COLLECTION", "type": "t", "tier": "T1",
                "transitions": {
                    "COLLECTION_COMPLETED": {
                        "to": "READY", "allowedActors": ["SYSTEM"],
                        "guard": {
                            "op": "all_of",
                            "guards": [
                                {"op": "status_is", "target": "doc:identity", "status": "VERIFIED"},
                                {"op": "none_with_status", "prefix": "doc:", "status": "CONFLICTED"}
                            ]
                        },
                        "onGuardFail": "HUMAN_REVIEW"
                    }
                }
            },
            "HUMAN_REVIEW": {
                "id": "HUMAN_REVIEW", "type": "gate", "tier": "T4",
                "onEnter": [{"kind": "NOTIFY_REVIEWER"}],
                "transitions": {
                    "REVIEW_RESOLVED": {"to": "COLLECTION", "allowedActors": ["AGENT"]}
                }
            },
            "READY": {
                "id": "READY", "type": "t", "tier": "T1", "terminal": true,
                "onEnter": [{"kind": "NOTIFY", "payload": {"template": "ready"}}]
            }
        }
    }))
    .unwrap()
}

fn flow() -> ValidatedFlow {
    ValidatedFlow::new(flow_def()).unwrap()
}

fn session_on(flow: &ValidatedFlow, state: &str) -> WorkflowSession {
    serde_json::from_value(json!({
        "id": "S1", "caseId": "C1", "workflowId": "TEST_FLOW", "workflowVersion": "1",
        "flowHash": flow.content_hash(),
        "state": state, "variables": {}, "version": 7, "createdAt": 0, "updatedAt": 0
    }))
    .unwrap()
}

fn session(state: &str) -> WorkflowSession {
    session_on(&flow(), state)
}

fn event(kind: &str, actor: &str) -> CanonicalEvent {
    serde_json::from_value(json!({
        "id": "E1", "type": kind, "source": "test", "caseId": "C1", "timestamp": 1000,
        "idempotencyKey": "k1", "actor": {"type": actor, "id": "A1"}, "payload": {}
    }))
    .unwrap()
}

fn ctx(as_of: i64) -> DecisionContext {
    let mut refs = BTreeMap::new();
    refs.insert("snapshotId".to_string(), "SNAP1".to_string());
    refs.insert("policyVersion:P".to_string(), "1".to_string());
    DecisionContext {
        as_of,
        context_refs: refs,
    }
}

fn facts(m: BTreeMap<String, String>) -> DecisionFacts {
    DecisionFacts { facts: m }
}

fn conflicted() -> DecisionFacts {
    let mut m = BTreeMap::new();
    m.insert("doc:identity".to_string(), "VERIFIED".to_string());
    m.insert("doc:income".to_string(), "CONFLICTED".to_string());
    facts(m)
}

fn run(
    flow: &ValidatedFlow,
    s: &WorkflowSession,
    e: &CanonicalEvent,
    f: &DecisionFacts,
    c: &DecisionContext,
) -> Result<Commit, KernelError> {
    advance(AdvanceInput {
        session: s,
        event: e,
        flow,
        facts: f,
        ctx: c,
    })
}

fn begin(
    flow: &ValidatedFlow,
    e: &CanonicalEvent,
    c: &DecisionContext,
) -> Result<Commit, KernelError> {
    start(StartInput {
        session_id: "S1",
        event: e,
        flow,
        ctx: c,
    })
}

#[test]
fn happy_path_transitions_and_bumps_version() {
    let commit = run(
        &flow(),
        &session("INTAKE"),
        &event("INTAKE_COMPLETED", "CLIENT"),
        &DecisionFacts::default(),
        &ctx(5000),
    )
    .unwrap();
    assert_eq!(commit.new_session.state, "COLLECTION");
    assert_eq!(commit.new_session.version, 8);
    assert_eq!(commit.expected_session_version, Some(7));
    assert_eq!(commit.new_session.updated_at, 5000);
    assert_eq!(commit.audit.from_state.as_deref(), Some("INTAKE"));
    assert_eq!(commit.audit.from_version, Some(7));
    assert_eq!(commit.audit.to_state, "COLLECTION");
    assert!(!commit.audit.guard_failed);
    assert_eq!(commit.audit.result_hash.len(), 64);
}

#[test]
fn identical_inputs_give_identical_commits() {
    let (fl, s, e, f, c) = (
        flow(),
        session("INTAKE"),
        event("INTAKE_COMPLETED", "SYSTEM"),
        DecisionFacts::default(),
        ctx(1),
    );
    assert_eq!(run(&fl, &s, &e, &f, &c), run(&fl, &s, &e, &f, &c));
}

#[test]
fn unauthorized_actor_is_rejected() {
    let err = run(
        &flow(),
        &session("INTAKE"),
        &event("INTAKE_COMPLETED", "UNAUTHORIZED_ROLE"),
        &DecisionFacts::default(),
        &ctx(1),
    )
    .unwrap_err();
    assert!(matches!(err, KernelError::Unauthorized { .. }));
}

#[test]
fn unknown_event_and_terminal_state_are_errors() {
    let f = DecisionFacts::default();
    let err = run(
        &flow(),
        &session("INTAKE"),
        &event("NOPE", "SYSTEM"),
        &f,
        &ctx(1),
    )
    .unwrap_err();
    assert!(matches!(err, KernelError::NoTransition { .. }));
    let err = run(
        &flow(),
        &session("READY"),
        &event("ANY", "SYSTEM"),
        &f,
        &ctx(1),
    )
    .unwrap_err();
    assert!(matches!(err, KernelError::SessionTerminal { .. }));
}

#[test]
fn guard_pass_reaches_ready_and_emits_outbox() {
    let mut m = BTreeMap::new();
    m.insert("doc:identity".to_string(), "VERIFIED".to_string());
    m.insert("doc:income".to_string(), "VERIFIED".to_string());
    let f = facts(m);

    let commit = run(
        &flow(),
        &session("COLLECTION"),
        &event("COLLECTION_COMPLETED", "SYSTEM"),
        &f,
        &ctx(1),
    )
    .unwrap();
    assert_eq!(commit.new_session.state, "READY");
    assert!(!commit.audit.guard_failed);
    assert_eq!(commit.outbox.len(), 1);
    assert_eq!(commit.outbox[0].kind, "NOTIFY");
}

#[test]
fn conflict_routes_to_human_review_not_an_error() {
    let commit = run(
        &flow(),
        &session("COLLECTION"),
        &event("COLLECTION_COMPLETED", "SYSTEM"),
        &conflicted(),
        &ctx(1),
    )
    .unwrap();
    assert_eq!(commit.new_session.state, "HUMAN_REVIEW");
    assert!(commit.audit.guard_failed);
    assert_eq!(commit.outbox.len(), 1);
    assert_eq!(commit.outbox[0].kind, "NOTIFY_REVIEWER");
}

#[test]
fn dedup_key_is_computable_before_advance() {
    let (fl, s, e) = (
        flow(),
        session("INTAKE"),
        event("INTAKE_COMPLETED", "CLIENT"),
    );
    let commit = run(&fl, &s, &e, &DecisionFacts::default(), &ctx(1)).unwrap();
    assert_eq!(commit.dedup_key, advance_dedup_key(&s.id, &e));
}

#[test]
fn dedup_key_survives_context_changes_but_decision_hash_does_not() {
    let (fl, s, e, f) = (
        flow(),
        session("INTAKE"),
        event("INTAKE_COMPLETED", "CLIENT"),
        DecisionFacts::default(),
    );
    let a = run(&fl, &s, &e, &f, &ctx(1)).unwrap();
    let mut later = ctx(999_999);
    later
        .context_refs
        .insert("snapshotId".to_string(), "SNAP2".to_string());
    let b = run(&fl, &s, &e, &f, &later).unwrap();

    assert_eq!(a.dedup_key, b.dedup_key);
    assert_ne!(a.audit.decision_hash, b.audit.decision_hash);
}

#[test]
fn dedup_key_is_scoped_per_session_and_operation() {
    let e = event("INTAKE_COMPLETED", "CLIENT");
    assert_ne!(advance_dedup_key("S1", &e), advance_dedup_key("S2", &e));
    assert_ne!(advance_dedup_key("S1", &e), start_dedup_key("S1", &e));
}

#[test]
fn loop_steps_get_distinct_transition_and_effect_ids() {
    let fl = flow();
    let f = conflicted();
    let collect = event("COLLECTION_COMPLETED", "SYSTEM");
    let resolve = event("REVIEW_RESOLVED", "AGENT");

    let first = run(&fl, &session("COLLECTION"), &collect, &f, &ctx(1)).unwrap();
    let back = run(&fl, &first.new_session, &resolve, &f, &ctx(2)).unwrap();
    let second = run(&fl, &back.new_session, &collect, &f, &ctx(3)).unwrap();

    assert_eq!(first.new_session.state, "HUMAN_REVIEW");
    assert_eq!(second.new_session.state, "HUMAN_REVIEW");
    assert_ne!(first.audit.transition_id, second.audit.transition_id);
    assert_ne!(first.outbox[0].id, second.outbox[0].id);
}

#[test]
fn edited_flow_under_same_version_is_rejected() {
    let s = session("INTAKE");
    let mut edited = flow_def();
    if let Some(n) = edited.nodes.get_mut("READY") {
        n.on_enter.clear();
    }
    let edited = ValidatedFlow::new(edited).unwrap();
    let err = run(
        &edited,
        &s,
        &event("INTAKE_COMPLETED", "CLIENT"),
        &DecisionFacts::default(),
        &ctx(1),
    )
    .unwrap_err();
    assert!(matches!(err, KernelError::FlowHashMismatch { .. }));
}

#[test]
fn deprecating_a_flow_keeps_its_hash_and_running_sessions() {
    let original = flow();
    let mut def = flow_def();
    def.status = FlowStatus::Deprecated;
    def.effective_to = Some(100);
    let deprecated = ValidatedFlow::new(def).unwrap();
    assert_eq!(original.content_hash(), deprecated.content_hash());

    let s = session_on(&original, "INTAKE");
    let commit = run(
        &deprecated,
        &s,
        &event("INTAKE_COMPLETED", "CLIENT"),
        &DecisionFacts::default(),
        &ctx(500),
    )
    .unwrap();
    assert_eq!(commit.new_session.state, "COLLECTION");
}

#[test]
fn start_creates_a_pinned_genesis_session() {
    let fl = flow();
    let e = event("CASE_OPENED", "CLIENT");
    let commit = begin(&fl, &e, &ctx(42)).unwrap();

    let s = &commit.new_session;
    assert_eq!(s.id, "S1");
    assert_eq!(s.case_id, "C1");
    assert_eq!(s.state, "INTAKE");
    assert_eq!(s.version, 0);
    assert_eq!(s.flow_hash, fl.content_hash());
    assert_eq!((s.created_at, s.updated_at), (42, 42));

    assert_eq!(commit.expected_session_version, None);
    assert_eq!(commit.audit.from_state, None);
    assert_eq!(commit.audit.from_version, None);
    assert_eq!(commit.audit.resolved_key, None);
    assert_eq!(commit.dedup_key, start_dedup_key("S1", &e));
    assert_eq!(commit.outbox.len(), 1);
    assert_eq!(commit.outbox[0].kind, "WELCOME");
}

#[test]
fn start_is_deterministic() {
    let (fl, e) = (flow(), event("CASE_OPENED", "SYSTEM"));
    assert_eq!(begin(&fl, &e, &ctx(1)), begin(&fl, &e, &ctx(1)));
}

#[test]
fn start_rejects_unauthorized_actor() {
    let err = begin(&flow(), &event("CASE_OPENED", "UNAUTHORIZED"), &ctx(1)).unwrap_err();
    assert!(matches!(err, KernelError::StartUnauthorized { .. }));
}

#[test]
fn start_rejects_non_active_flows_and_closed_windows() {
    let e = event("CASE_OPENED", "CLIENT");

    for status in [FlowStatus::Draft, FlowStatus::Deprecated] {
        let mut def = flow_def();
        def.status = status;
        let err = begin(&ValidatedFlow::new(def).unwrap(), &e, &ctx(1)).unwrap_err();
        assert!(matches!(err, KernelError::FlowNotActive { .. }));
    }

    let mut def = flow_def();
    def.effective_from = 100;
    def.effective_to = Some(200);
    let windowed = ValidatedFlow::new(def).unwrap();
    for as_of in [99, 200] {
        let err = begin(&windowed, &e, &ctx(as_of)).unwrap_err();
        assert!(matches!(err, KernelError::OutsideEffectiveWindow { .. }));
    }
    assert!(begin(&windowed, &e, &ctx(100)).is_ok());
}

#[test]
fn replay_from_start_by_folding_events_reproduces_final_state() {
    let fl = flow();
    let mut m = BTreeMap::new();
    m.insert("doc:identity".to_string(), "VERIFIED".to_string());
    m.insert("doc:income".to_string(), "VERIFIED".to_string());
    let f = facts(m);

    let mut s = begin(&fl, &event("CASE_OPENED", "CLIENT"), &ctx(1))
        .unwrap()
        .new_session;
    for (kind, actor) in [
        ("INTAKE_COMPLETED", "CLIENT"),
        ("COLLECTION_COMPLETED", "SYSTEM"),
    ] {
        s = run(&fl, &s, &event(kind, actor), &f, &ctx(1))
            .unwrap()
            .new_session;
    }
    assert_eq!(s.state, "READY");
    assert_eq!(s.version, 2);
}

#[test]
fn missing_required_fact_returns_error_not_onguardfail() {
    let fl = flow();
    // doc:identity is required by status_is, but we supply empty facts
    let f = DecisionFacts::default();
    let err = run(
        &fl,
        &session("COLLECTION"),
        &event("COLLECTION_COMPLETED", "SYSTEM"),
        &f,
        &ctx(1),
    )
    .unwrap_err();
    assert!(matches!(err, KernelError::MissingRequiredFact { fact } if fact == "doc:identity"));

    // Supply doc:identity, but omit doc:income (required by none_with_status doc:)
    let mut m = BTreeMap::new();
    m.insert("doc:identity".to_string(), "VERIFIED".to_string());
    let f2 = facts(m);
    let err2 = run(
        &fl,
        &session("COLLECTION"),
        &event("COLLECTION_COMPLETED", "SYSTEM"),
        &f2,
        &ctx(1),
    )
    .unwrap_err();
    assert!(matches!(err2, KernelError::MissingRequiredFact { fact } if fact == "doc:income"));
}

#[test]
fn invalid_fact_status_on_declared_fact_is_rejected() {
    let fl = flow();
    let mut m = BTreeMap::new();
    m.insert("doc:identity".to_string(), "INVALID_STATUS".to_string());
    m.insert("doc:income".to_string(), "VERIFIED".to_string());
    let f = facts(m);
    let err = run(
        &fl,
        &session("COLLECTION"),
        &event("COLLECTION_COMPLETED", "SYSTEM"),
        &f,
        &ctx(1),
    )
    .unwrap_err();
    assert!(
        matches!(err, KernelError::InvalidFactStatus { fact, status } if fact == "doc:identity" && status == "INVALID_STATUS")
    );
}

#[test]
fn undeclared_fact_keys_are_ignored() {
    let fl = flow();
    let mut m = BTreeMap::new();
    m.insert("doc:identity".to_string(), "VERIFIED".to_string());
    m.insert("doc:income".to_string(), "VERIFIED".to_string());
    m.insert("shared:irrelevant_key".to_string(), "WHATEVER".to_string());
    // An undeclared key under prefix doc: with status CONFLICTED (from another workflow's shared fact pool)
    m.insert(
        "doc:foreign_undeclared_fact".to_string(),
        "CONFLICTED".to_string(),
    );
    let f = facts(m);
    let commit = run(
        &fl,
        &session("COLLECTION"),
        &event("COLLECTION_COMPLETED", "SYSTEM"),
        &f,
        &ctx(1),
    )
    .unwrap();
    // Guard none_with_status(prefix: "doc:", status: "CONFLICTED") must PASS because foreign fact is dropped
    assert_eq!(commit.new_session.state, "READY");
    assert!(!commit.audit.guard_failed);

    // factsHash must be identical to passing without the foreign undeclared facts
    let mut clean_m = BTreeMap::new();
    clean_m.insert("doc:identity".to_string(), "VERIFIED".to_string());
    clean_m.insert("doc:income".to_string(), "VERIFIED".to_string());
    let clean_commit = run(
        &fl,
        &session("COLLECTION"),
        &event("COLLECTION_COMPLETED", "SYSTEM"),
        &facts(clean_m),
        &ctx(1),
    )
    .unwrap();
    assert_eq!(commit.audit.facts_hash, clean_commit.audit.facts_hash);
}

#[test]
fn time_regression_is_rejected() {
    let fl = flow();
    let mut s = session("INTAKE");
    s.updated_at = 1000;
    let err = run(
        &fl,
        &s,
        &event("INTAKE_COMPLETED", "CLIENT"),
        &DecisionFacts::default(),
        &ctx(999),
    )
    .unwrap_err();
    assert!(matches!(
        err,
        KernelError::TimeRegressed {
            as_of: 999,
            session_updated_at: 1000
        }
    ));
}

#[test]
fn audit_chain_links_prev_result_hash_and_blanks_properly() {
    let fl = flow();
    let start_commit = begin(&fl, &event("START", "CLIENT"), &ctx(100)).unwrap();
    assert!(start_commit.audit.prev_result_hash.is_none());
    assert_eq!(
        start_commit.new_session.last_result_hash,
        Some(start_commit.audit.result_hash.clone())
    );

    let advance_commit = run(
        &fl,
        &start_commit.new_session,
        &event("INTAKE_COMPLETED", "CLIENT"),
        &DecisionFacts::default(),
        &ctx(200),
    )
    .unwrap();
    assert_eq!(
        advance_commit.audit.prev_result_hash,
        Some(start_commit.audit.result_hash)
    );
    assert_eq!(
        advance_commit.new_session.last_result_hash,
        Some(advance_commit.audit.result_hash.clone())
    );
}

proptest! {
    #[test]
    fn decision_hash_is_canonical_for_context_refs(
        keys in prop::collection::vec("[a-z]{1,4}", 1..5),
        vals in prop::collection::vec("[0-9]{1,4}", 1..5)
    ) {
        let (fl, s, e, f) = (
            flow(),
            session("INTAKE"),
            event("INTAKE_COMPLETED", "CLIENT"),
            DecisionFacts::default(),
        );
        let mut refs = BTreeMap::new();
        for (k, v) in keys.into_iter().zip(vals) {
            refs.insert(k, v);
        }
        let c = DecisionContext {
            as_of: 1,
            context_refs: refs,
        };
        let a = run(&fl, &s, &e, &f, &c).unwrap();
        let b = run(&fl, &s, &e, &f, &c).unwrap();
        prop_assert_eq!(a.audit.decision_hash, b.audit.decision_hash);
    }
}
