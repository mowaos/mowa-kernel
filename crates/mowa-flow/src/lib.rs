//! Flow definitions (domain-neutral standard), the guard language, and the
//! activation-time validator.
//!
//! A `FlowDefinition` is pure data. The kernel only accepts a `ValidatedFlow`,
//! which can be constructed solely through `ValidatedFlow::new` (i.e. after
//! structural, dominance and fact-declaration validation) and carries a content hash
//! identifying the flow's behaviour.
//!
//! The content hash deliberately EXCLUDES lifecycle fields (`status`, `effectiveFrom`,
//! `effectiveTo`): deprecating a flow or updating its effective window must not
//! change the hash that running sessions are pinned to.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use mowa_canon::{hash_of, CanonError, Value};
use serde::{Deserialize, Serialize};

/// Maximum nesting of a guard expression (bounds recursion, incl. inside WASM).
pub const MAX_GUARD_DEPTH: usize = 16;

/// Reserved universal actor kinds.
pub const ACTOR_SYSTEM: &str = "SYSTEM";
pub const ACTOR_AI: &str = "AI";

/// Execution tier. Metadata only: the kernel cannot measure time. The host
/// enforces budgets and reports violations as telemetry, never as kernel state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    T0,
    T1,
    T2,
    T3,
    T4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FlowStatus {
    Draft,
    Active,
    Deprecated,
}

/// Small, total, non-Turing-complete predicate language evaluated over
/// categorical fact statuses (statuses only: no personal data enters the kernel).
/// `AllOf([])` is true; `AnyOf([])` is false.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Guard {
    AllOf {
        guards: Vec<Guard>,
    },
    AnyOf {
        guards: Vec<Guard>,
    },
    Not {
        guard: Box<Guard>,
    },
    /// Matches if facts.get(target) == Some(status).
    StatusIs {
        target: String,
        status: String,
    },
    /// Matches if no fact with the given prefix has the specified status.
    /// E.g. prefix "doc:" with status "CONFLICTED".
    NoneWithStatus {
        prefix: String,
        status: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transition {
    pub to: String,
    /// Who may trigger this edge. Strings must be non-empty and declared.
    pub allowed_actors: BTreeSet<String>,
    #[serde(default)]
    pub guard: Option<Guard>,
    /// Deterministic fallback when `guard` is false (e.g. route to human review).
    /// Without it, a false guard is a `GuardNotSatisfied` error.
    #[serde(default)]
    pub on_guard_fail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SideEffectDef {
    pub kind: String,
    #[serde(default = "null_value")]
    pub payload: Value,
}

fn null_value() -> Value {
    Value::Null
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub tier: Tier,
    #[serde(default)]
    pub terminal: bool,
    /// Keyed by event type (the "resolved key"). Handler outcomes re-enter the
    /// kernel as events, so there is exactly one routing mechanism.
    #[serde(default)]
    pub transitions: BTreeMap<String, Transition>,
    /// Outbox entries emitted when a transition lands on this node.
    #[serde(default)]
    pub on_enter: Vec<SideEffectDef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowDefinition {
    pub id: String,
    pub version: String,
    pub status: FlowStatus,
    pub start_node: String,
    /// Who may start a session of this flow. Must be non-empty.
    pub start_actors: BTreeSet<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Declared facts and their permitted categorical status values.
    /// Guarantees that typos in fact names or status values are rejected at validation time.
    #[serde(default)]
    pub declared_facts: BTreeMap<String, Vec<String>>,
    pub nodes: BTreeMap<String, FlowNode>,
    // ---- lifecycle fields: not part of the content hash --------------------------
    pub effective_from: i64,
    #[serde(default)]
    pub effective_to: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum FlowError {
    StartNodeMissing {
        node: String,
    },
    NoStartActors,
    EmptyStartActor,
    NodeIdMismatch {
        key: String,
        id: String,
    },
    UnknownTarget {
        from: String,
        event: String,
        target: String,
    },
    UnknownFallback {
        from: String,
        event: String,
        target: String,
    },
    FallbackWithoutGuard {
        from: String,
        event: String,
    },
    NoAllowedActors {
        from: String,
        event: String,
    },
    EmptyAllowedActor {
        from: String,
        event: String,
    },
    GuardTooDeep {
        from: String,
        event: String,
    },
    UndeclaredFact {
        from: String,
        event: String,
        fact: String,
    },
    InvalidFactStatus {
        from: String,
        event: String,
        fact: String,
        status: String,
    },
    UndeclaredFactPrefix {
        from: String,
        event: String,
        prefix: String,
    },
    InvalidFactStatusForPrefix {
        from: String,
        event: String,
        prefix: String,
        status: String,
    },
    DeadEnd {
        node: String,
    },
    StartNodeCannotBeTerminal {
        node: String,
    },
    EmptyFactKey,
    EmptyFactStatuses {
        fact: String,
    },
    EmptyFactStatus {
        fact: String,
    },
    DuplicateFactStatus {
        fact: String,
        status: String,
    },
    TerminalHasTransitions {
        node: String,
    },
    Unreachable {
        node: String,
    },
    Unhashable {
        reason: String,
    },
}

/// A flow that passed `validate`, together with its content hash.
#[derive(Debug, Clone)]
pub struct ValidatedFlow {
    def: FlowDefinition,
    hash: String,
}

impl ValidatedFlow {
    pub fn new(def: FlowDefinition) -> Result<Self, Vec<FlowError>> {
        let errors = validate(&def);
        if !errors.is_empty() {
            return Err(errors);
        }
        let hash = flow_content_hash(&def).map_err(|e| {
            vec![FlowError::Unhashable {
                reason: e.to_string(),
            }]
        })?;
        Ok(Self { def, hash })
    }

    pub fn definition(&self) -> &FlowDefinition {
        &self.def
    }

    /// See [`flow_content_hash`]. Sessions are pinned to this value.
    pub fn content_hash(&self) -> &str {
        &self.hash
    }
}

/// The behaviour-defining part of a flow: everything except lifecycle fields.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FlowContent<'a> {
    id: &'a str,
    version: &'a str,
    start_node: &'a str,
    start_actors: &'a BTreeSet<String>,
    description: &'a Option<String>,
    declared_facts: &'a BTreeMap<String, Vec<String>>,
    nodes: &'a BTreeMap<String, FlowNode>,
}

/// SHA-256 of the canonical JSON of `{id, version, startNode, startActors,
/// description, declaredFacts, nodes}`. `status`, `effectiveFrom` and `effectiveTo`
/// are excluded so that lifecycle changes do not orphan sessions pinned to the flow.
pub fn flow_content_hash(def: &FlowDefinition) -> Result<String, CanonError> {
    hash_of(&FlowContent {
        id: &def.id,
        version: &def.version,
        start_node: &def.start_node,
        start_actors: &def.start_actors,
        description: &def.description,
        declared_facts: &def.declared_facts,
        nodes: &def.nodes,
    })
}

/// Structural and fact-declaration validation. Returns every problem found (empty = valid).
pub fn validate(flow: &FlowDefinition) -> Vec<FlowError> {
    let mut errs = Vec::new();
    let start_exists = flow.nodes.contains_key(&flow.start_node);
    if !start_exists {
        errs.push(FlowError::StartNodeMissing {
            node: flow.start_node.clone(),
        });
    } else if let Some(start_node) = flow.nodes.get(&flow.start_node) {
        if start_node.terminal {
            errs.push(FlowError::StartNodeCannotBeTerminal {
                node: flow.start_node.clone(),
            });
        }
    }
    if flow.start_actors.is_empty() {
        errs.push(FlowError::NoStartActors);
    }
    for actor in &flow.start_actors {
        if actor.trim().is_empty() {
            errs.push(FlowError::EmptyStartActor);
        }
    }

    for (key, statuses) in &flow.declared_facts {
        if key.trim().is_empty() {
            errs.push(FlowError::EmptyFactKey);
        }
        if statuses.is_empty() {
            errs.push(FlowError::EmptyFactStatuses { fact: key.clone() });
        }
        let mut seen = BTreeSet::new();
        for st in statuses {
            if st.trim().is_empty() {
                errs.push(FlowError::EmptyFactStatus { fact: key.clone() });
            }
            if !seen.insert(st.as_str()) {
                errs.push(FlowError::DuplicateFactStatus {
                    fact: key.clone(),
                    status: st.clone(),
                });
            }
        }
    }

    for (key, node) in &flow.nodes {
        if key != &node.id {
            errs.push(FlowError::NodeIdMismatch {
                key: key.clone(),
                id: node.id.clone(),
            });
        }
        if node.terminal && !node.transitions.is_empty() {
            errs.push(FlowError::TerminalHasTransitions { node: key.clone() });
        }
        if !node.terminal && node.transitions.is_empty() {
            errs.push(FlowError::DeadEnd { node: key.clone() });
        }
        for (event, t) in &node.transitions {
            if !flow.nodes.contains_key(&t.to) {
                errs.push(FlowError::UnknownTarget {
                    from: key.clone(),
                    event: event.clone(),
                    target: t.to.clone(),
                });
            }
            if let Some(fb) = &t.on_guard_fail {
                if !flow.nodes.contains_key(fb) {
                    errs.push(FlowError::UnknownFallback {
                        from: key.clone(),
                        event: event.clone(),
                        target: fb.clone(),
                    });
                }
                if t.guard.is_none() {
                    errs.push(FlowError::FallbackWithoutGuard {
                        from: key.clone(),
                        event: event.clone(),
                    });
                }
            }
            if t.allowed_actors.is_empty() {
                errs.push(FlowError::NoAllowedActors {
                    from: key.clone(),
                    event: event.clone(),
                });
            }
            for actor in &t.allowed_actors {
                if actor.trim().is_empty() {
                    errs.push(FlowError::EmptyAllowedActor {
                        from: key.clone(),
                        event: event.clone(),
                    });
                }
            }
            if let Some(g) = &t.guard {
                if guard_depth(g) > MAX_GUARD_DEPTH {
                    errs.push(FlowError::GuardTooDeep {
                        from: key.clone(),
                        event: event.clone(),
                    });
                }
                validate_guard_facts(g, key, event, &flow.declared_facts, &mut errs);
            }
        }
    }

    if start_exists {
        let seen = reachable(flow, None);
        for key in flow.nodes.keys() {
            if !seen.contains(key.as_str()) {
                errs.push(FlowError::Unreachable { node: key.clone() });
            }
        }
    }
    errs
}

fn validate_guard_facts(
    g: &Guard,
    from: &str,
    event: &str,
    declared: &BTreeMap<String, Vec<String>>,
    errs: &mut Vec<FlowError>,
) {
    match g {
        Guard::AllOf { guards } | Guard::AnyOf { guards } => {
            for sub in guards {
                validate_guard_facts(sub, from, event, declared, errs);
            }
        }
        Guard::Not { guard } => {
            validate_guard_facts(guard, from, event, declared, errs);
        }
        Guard::StatusIs { target, status } => match declared.get(target) {
            None => {
                errs.push(FlowError::UndeclaredFact {
                    from: from.to_string(),
                    event: event.to_string(),
                    fact: target.clone(),
                });
            }
            Some(allowed) => {
                if !allowed.iter().any(|s| s == status) {
                    errs.push(FlowError::InvalidFactStatus {
                        from: from.to_string(),
                        event: event.to_string(),
                        fact: target.clone(),
                        status: status.clone(),
                    });
                }
            }
        },
        Guard::NoneWithStatus { prefix, status } => {
            let matching: Vec<(&String, &Vec<String>)> = declared
                .iter()
                .filter(|(k, _)| k.starts_with(prefix))
                .collect();
            if matching.is_empty() {
                errs.push(FlowError::UndeclaredFactPrefix {
                    from: from.to_string(),
                    event: event.to_string(),
                    prefix: prefix.clone(),
                });
            } else {
                let status_possible = matching
                    .iter()
                    .any(|(_, statuses)| statuses.iter().any(|s| s == status));
                if !status_possible {
                    errs.push(FlowError::InvalidFactStatusForPrefix {
                        from: from.to_string(),
                        event: event.to_string(),
                        prefix: prefix.clone(),
                        status: status.clone(),
                    });
                }
            }
        }
    }
}

/// Returns the members of `required` that do NOT lie on every path from the
/// start node to `target` (empty = all of them dominate `target`).
pub fn violated_dominators(flow: &ValidatedFlow, target: &str, required: &[&str]) -> Vec<String> {
    let def = flow.definition();
    if !def.nodes.contains_key(target) {
        return required.iter().map(|s| s.to_string()).collect();
    }
    let mut out = Vec::new();
    for &r in required {
        if !def.nodes.contains_key(r) {
            out.push(r.to_string());
            continue;
        }
        if r == def.start_node || r == target {
            continue;
        }
        if reachable(def, Some(r)).contains(target) {
            out.push(r.to_string());
        }
    }
    out
}

fn successors(node: &FlowNode) -> impl Iterator<Item = &str> + '_ {
    node.transitions
        .values()
        .flat_map(|t| std::iter::once(t.to.as_str()).chain(t.on_guard_fail.as_deref()))
}

fn reachable<'a>(flow: &'a FlowDefinition, blocked: Option<&str>) -> BTreeSet<&'a str> {
    let mut seen: BTreeSet<&'a str> = BTreeSet::new();
    let mut queue: VecDeque<&'a str> = VecDeque::new();
    let start = flow.start_node.as_str();
    if Some(start) != blocked && flow.nodes.contains_key(start) {
        seen.insert(start);
        queue.push_back(start);
    }
    while let Some(cur) = queue.pop_front() {
        if let Some(node) = flow.nodes.get(cur) {
            for next in successors(node) {
                if Some(next) == blocked {
                    continue;
                }
                if flow.nodes.contains_key(next) && seen.insert(next) {
                    queue.push_back(next);
                }
            }
        }
    }
    seen
}

fn guard_depth(g: &Guard) -> usize {
    match g {
        Guard::AllOf { guards } | Guard::AnyOf { guards } => {
            1 + guards.iter().map(guard_depth).max().unwrap_or(0)
        }
        Guard::Not { guard } => 1 + guard_depth(guard),
        _ => 1,
    }
}
