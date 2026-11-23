use std::collections::BTreeMap;

use mowa_canon::Value;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActorRef {
    #[serde(rename = "type")]
    pub actor_type: String,
    pub id: String,
}

/// Workflow state only. Operational truth lives in host records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSession {
    pub id: String,
    pub case_id: String,
    pub workflow_id: String,
    pub workflow_version: String,
    /// Content hash of the flow this session was started on (`mowa_flow::flow_content_hash`).
    /// Set once by `start`; `advance` refuses any flow whose hash differs.
    pub flow_hash: String,
    pub state: String,
    /// Reserved for declarative mutation expressions in future kernel versions.
    #[serde(default)]
    pub variables: BTreeMap<String, Value>,
    /// Optimistic-concurrency counter. 0 after `start`; +1 per `advance`.
    pub version: u64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Cryptographic audit hash chain pointer: records the `result_hash` of the commit that
    /// produced this session version. Set after computing `audit.result_hash`.
    /// Verifiers must blank both `audit.result_hash` and `session.last_result_hash` before recomputing.
    #[serde(default)]
    pub last_result_hash: Option<String>,
}

/// Canonical event. Times are epoch milliseconds.
/// `event_type` is the transition key looked up in the current node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanonicalEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub source: String,
    pub case_id: String,
    pub timestamp: i64,
    /// Reserved for future business effective-time scheduling.
    #[serde(default)]
    pub effective_at: Option<i64>,
    pub idempotency_key: String,
    pub actor: ActorRef,
    #[serde(default)]
    pub payload: BTreeMap<String, Value>,
}

/// Which snapshots or external versions the decision was based on. `as_of` is the
/// execution time supplied by the host: the kernel never reads a clock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionContext {
    pub as_of: i64,
    #[serde(default)]
    pub context_refs: BTreeMap<String, String>,
}

/// Categorical fact statuses supplied by the host. Keys are flow-declared fact names,
/// and values are allowed categorical status strings (e.g. "entity:status" -> "VERIFIED").
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionFacts {
    #[serde(default)]
    pub facts: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideEffect {
    /// Deterministic id (hash of transition id + index) so the outbox worker can
    /// deduplicate without merging distinct steps.
    pub id: String,
    pub kind: String,
    pub payload: Value,
}

/// Cryptographic audit record, extended with flow hash, kernel version, facts hash and
/// decision hash. Fields that are `None` mark the genesis record written by `start`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionAudit {
    /// `tr_` + hash of `{sessionId, fromVersion, eventHash}`.
    /// Unique per session step, so repeated event content in a loop cannot collide.
    pub transition_id: String,
    pub session_id: String,
    pub case_id: String,
    /// Session version this step was applied to; `None` for the genesis record.
    pub from_version: Option<u64>,
    pub event_id: String,
    pub event_type: String,
    /// Transition key taken; `None` for the genesis record.
    pub resolved_key: Option<String>,
    /// `None` for the genesis record.
    pub from_state: Option<String>,
    pub to_state: String,
    /// True when the guard was false and the flow's `onGuardFail` route was taken.
    pub guard_failed: bool,
    pub workflow_id: String,
    pub workflow_version: String,
    pub flow_hash: String,
    pub kernel_version: String,
    /// What the decision was based on: hash of `{caseId, eventHash, workflowVersion,
    /// flowHash, contextRefs, factsHash}`. Evidence for audit and replay.
    pub decision_hash: String,
    pub context_refs: BTreeMap<String, String>,
    pub facts_hash: String,
    pub actor: ActorRef,
    pub timestamp: i64,
    /// Preceding commit's `result_hash`, establishing an append-only audit hash chain.
    /// `None` for the genesis record written by `start`.
    #[serde(default)]
    pub prev_result_hash: Option<String>,
    /// SHA-256 over canonical JSON of `[newSession, audit-with-empty-resultHash, outbox,
    /// expectedSessionVersion]`. Verifiers blank this field and newSession.lastResultHash, then recompute.
    pub result_hash: String,
}

/// Everything the host must persist, atomically, or not at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub new_session: WorkflowSession,
    /// The host's concurrency predicate.
    /// `Some(v)`: `UPDATE ... WHERE id = $id AND version = v`.
    /// `None` (from `start`): `INSERT`, which must fail if the session id exists.
    pub expected_session_version: Option<u64>,
    pub audit: TransitionAudit,
    /// Deduplication key for the idempotency record. Depends only on the session id
    /// and the event's own `idempotencyKey`, so the host can compute it BEFORE calling
    /// the kernel and it does not change if snapshots or `asOf` change between deliveries.
    pub dedup_key: String,
    pub outbox: Vec<SideEffect>,
}
