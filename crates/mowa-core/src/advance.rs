use std::collections::BTreeMap;

use mowa_canon::{canonical_hash, hash_of, to_value, Value};
use mowa_flow::{FlowDefinition, FlowNode, FlowStatus, ValidatedFlow};

use crate::error::KernelError;
use crate::guard::eval_guard;
use crate::ids;
use crate::types::{
    CanonicalEvent, Commit, DecisionContext, DecisionFacts, SideEffect, TransitionAudit,
    WorkflowSession,
};
use crate::KERNEL_VERSION;

/// Borrowed inputs: the kernel cannot mutate any of them (enforced by `&`).
#[derive(Debug, Clone, Copy)]
pub struct AdvanceInput<'a> {
    pub session: &'a WorkflowSession,
    pub event: &'a CanonicalEvent,
    pub flow: &'a ValidatedFlow,
    pub facts: &'a DecisionFacts,
    pub ctx: &'a DecisionContext,
}

/// Inputs for creating a session. `event` is the cause (e.g. `SESSION_INITIALIZED`), so the
/// genesis record has an actor and an event like every other step.
#[derive(Debug, Clone, Copy)]
pub struct StartInput<'a> {
    pub session_id: &'a str,
    pub event: &'a CanonicalEvent,
    pub flow: &'a ValidatedFlow,
    pub ctx: &'a DecisionContext,
}

/// The only way to create a session. Produces version 0 on the flow's start
/// node, pinned to the flow's content hash, with the start node's `onEnter` effects in
/// the outbox. The host INSERTs it (`expected_session_version == None`).
///
/// Only `ACTIVE` flows within `[effectiveFrom, effectiveTo)` can start sessions;
/// `DEPRECATED` flows keep running existing sessions but accept no new ones.
pub fn start(input: StartInput<'_>) -> Result<Commit, KernelError> {
    let StartInput {
        session_id,
        event,
        flow,
        ctx,
    } = input;
    let def = flow.definition();

    if def.status != FlowStatus::Active {
        return Err(not_active(def));
    }
    let in_window =
        ctx.as_of >= def.effective_from && def.effective_to.is_none_or(|end| ctx.as_of < end);
    if !in_window {
        return Err(KernelError::OutsideEffectiveWindow { as_of: ctx.as_of });
    }
    if !def.start_actors.contains(&event.actor.actor_type) {
        return Err(KernelError::StartUnauthorized {
            actor: event.actor.actor_type.clone(),
        });
    }
    let start_node = def
        .nodes
        .get(&def.start_node)
        .ok_or_else(|| KernelError::UnknownState {
            state: def.start_node.clone(),
        })?;

    let new_session = WorkflowSession {
        id: session_id.to_owned(),
        case_id: event.case_id.clone(),
        workflow_id: def.id.clone(),
        workflow_version: def.version.clone(),
        flow_hash: flow.content_hash().to_owned(),
        state: def.start_node.clone(),
        variables: BTreeMap::new(),
        version: 0,
        created_at: ctx.as_of,
        updated_at: ctx.as_of,
        last_result_hash: None,
    };
    let no_facts = DecisionFacts::default();
    build_commit(Step {
        prev: None,
        new_session,
        target_node: start_node,
        resolved_key: None,
        guard_failed: false,
        event,
        flow,
        facts: &no_facts,
        ctx,
    })
}

/// The single state-transition function. Deterministic in
/// `(flow, session, event, facts, ctx)`; identical inputs give an identical `Commit`.
pub fn advance(input: AdvanceInput<'_>) -> Result<Commit, KernelError> {
    let AdvanceInput {
        session,
        event,
        flow,
        facts,
        ctx,
    } = input;
    let def = flow.definition();

    if def.status == FlowStatus::Draft {
        return Err(not_active(def));
    }
    if session.workflow_id != def.id || session.workflow_version != def.version {
        return Err(KernelError::WorkflowMismatch {
            session: format!("{}@{}", session.workflow_id, session.workflow_version),
            flow: format!("{}@{}", def.id, def.version),
        });
    }
    if session.flow_hash != flow.content_hash() {
        return Err(KernelError::FlowHashMismatch {
            session: session.flow_hash.clone(),
            flow: flow.content_hash().to_owned(),
        });
    }
    if event.case_id != session.case_id {
        return Err(KernelError::CaseMismatch {
            session_case: session.case_id.clone(),
            event_case: event.case_id.clone(),
        });
    }

    if ctx.as_of < session.updated_at {
        return Err(KernelError::TimeRegressed {
            as_of: ctx.as_of,
            session_updated_at: session.updated_at,
        });
    }

    // Validate declared fact statuses for all provided facts
    for (fact_key, status) in &facts.facts {
        if let Some(allowed) = def.declared_facts.get(fact_key) {
            if !allowed.contains(status) {
                return Err(KernelError::InvalidFactStatus {
                    fact: fact_key.clone(),
                    status: status.clone(),
                });
            }
        }
    }

    // Ingest only facts declared in this flow: drop undeclared keys so shared fact pools
    // from other flows do not pollute guard evaluation or factsHash
    let filtered_facts = DecisionFacts {
        facts: facts
            .facts
            .iter()
            .filter(|(k, _)| def.declared_facts.contains_key(*k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    };

    let node = def
        .nodes
        .get(&session.state)
        .ok_or_else(|| KernelError::UnknownState {
            state: session.state.clone(),
        })?;
    if node.terminal {
        return Err(KernelError::SessionTerminal {
            state: session.state.clone(),
        });
    }

    let key = event.event_type.as_str();
    let transition = node
        .transitions
        .get(key)
        .ok_or_else(|| KernelError::NoTransition {
            state: session.state.clone(),
            key: key.to_owned(),
        })?;

    if !transition.allowed_actors.contains(&event.actor.actor_type) {
        return Err(KernelError::Unauthorized {
            state: session.state.clone(),
            key: key.to_owned(),
            actor: event.actor.actor_type.clone(),
        });
    }

    // Verify all facts required by the guard are present before evaluating
    if let Some(g) = &transition.guard {
        check_guard_facts_present(g, &def.declared_facts, &filtered_facts)?;
    }

    let (target, guard_failed): (&String, bool) = match &transition.guard {
        None => (&transition.to, false),
        Some(g) if eval_guard(g, &filtered_facts) => (&transition.to, false),
        Some(_) => match &transition.on_guard_fail {
            Some(fallback) => (fallback, true),
            None => {
                return Err(KernelError::GuardNotSatisfied {
                    state: session.state.clone(),
                    key: key.to_owned(),
                })
            }
        },
    };
    let target_node = def
        .nodes
        .get(target)
        .ok_or_else(|| KernelError::UnknownState {
            state: target.clone(),
        })?;

    let mut new_session = session.clone();
    new_session.state = target.clone();
    new_session.version = session
        .version
        .checked_add(1)
        .ok_or(KernelError::VersionOverflow)?;
    new_session.updated_at = ctx.as_of;

    build_commit(Step {
        prev: Some(session),
        new_session,
        target_node,
        resolved_key: Some(key),
        guard_failed,
        event,
        flow,
        facts: &filtered_facts,
        ctx,
    })
}

/// Everything `start` and `advance` share once the target is decided.
struct Step<'a> {
    /// `None` for `start`.
    prev: Option<&'a WorkflowSession>,
    new_session: WorkflowSession,
    target_node: &'a FlowNode,
    resolved_key: Option<&'a str>,
    guard_failed: bool,
    event: &'a CanonicalEvent,
    flow: &'a ValidatedFlow,
    facts: &'a DecisionFacts,
    ctx: &'a DecisionContext,
}

fn build_commit(step: Step<'_>) -> Result<Commit, KernelError> {
    let Step {
        prev,
        mut new_session,
        target_node,
        resolved_key,
        guard_failed,
        event,
        flow,
        facts,
        ctx,
    } = step;
    let def = flow.definition();

    let event_hash = hash_of(event)?;
    let facts_hash = hash_of(facts)?;
    let context_refs_val = to_value(&ctx.context_refs)?;

    let decision_hash = canonical_hash(&Value::Object(BTreeMap::from([
        ("caseId".to_owned(), Value::Str(new_session.case_id.clone())),
        ("eventHash".to_owned(), Value::Str(event_hash.clone())),
        (
            "workflowVersion".to_owned(),
            Value::Str(def.version.clone()),
        ),
        (
            "flowHash".to_owned(),
            Value::Str(flow.content_hash().to_owned()),
        ),
        ("contextRefs".to_owned(), context_refs_val),
        ("factsHash".to_owned(), Value::Str(facts_hash.clone())),
    ])));

    let from_version = prev.map(|s| s.version);
    let transition_id = ids::transition_id(&new_session.id, from_version, &event_hash);
    let dedup_key = match prev {
        None => ids::start_dedup_key(&new_session.id, event),
        Some(_) => ids::advance_dedup_key(&new_session.id, event),
    };
    let prev_result_hash = prev.and_then(|s| s.last_result_hash.clone());

    let outbox: Vec<SideEffect> = target_node
        .on_enter
        .iter()
        .enumerate()
        .map(|(i, effect)| SideEffect {
            id: ids::effect_id(&transition_id, i),
            kind: effect.kind.clone(),
            payload: effect.payload.clone(),
        })
        .collect();

    let mut audit = TransitionAudit {
        transition_id,
        session_id: new_session.id.clone(),
        case_id: new_session.case_id.clone(),
        from_version,
        event_id: event.id.clone(),
        event_type: event.event_type.clone(),
        resolved_key: resolved_key.map(str::to_owned),
        from_state: prev.map(|s| s.state.clone()),
        to_state: new_session.state.clone(),
        guard_failed,
        workflow_id: def.id.clone(),
        workflow_version: def.version.clone(),
        flow_hash: flow.content_hash().to_owned(),
        kernel_version: KERNEL_VERSION.to_owned(),
        decision_hash,
        context_refs: ctx.context_refs.clone(),
        facts_hash,
        actor: event.actor.clone(),
        timestamp: ctx.as_of,
        prev_result_hash,
        result_hash: String::new(),
    };

    // CRITICAL: Blank both audit.result_hash and new_session.last_result_hash before computing result_hash.
    // Verifiers blank both fields before recomputing to verify audit integrity.
    new_session.last_result_hash = None;
    audit.result_hash = String::new();
    let computed_result_hash = hash_of(&(&new_session, &audit, &outbox, from_version))?;
    audit.result_hash = computed_result_hash.clone();
    new_session.last_result_hash = Some(computed_result_hash);

    Ok(Commit {
        new_session,
        expected_session_version: from_version,
        audit,
        dedup_key,
        outbox,
    })
}

fn check_guard_facts_present(
    guard: &mowa_flow::Guard,
    declared_facts: &BTreeMap<String, Vec<String>>,
    facts: &DecisionFacts,
) -> Result<(), KernelError> {
    match guard {
        mowa_flow::Guard::StatusIs { target, .. } => {
            if !facts.facts.contains_key(target) {
                return Err(KernelError::MissingRequiredFact {
                    fact: target.clone(),
                });
            }
            Ok(())
        }
        mowa_flow::Guard::NoneWithStatus { prefix, .. } => {
            // Every declared fact starting with `prefix` must be present
            for declared_key in declared_facts.keys() {
                if declared_key.starts_with(prefix) && !facts.facts.contains_key(declared_key) {
                    return Err(KernelError::MissingRequiredFact {
                        fact: declared_key.clone(),
                    });
                }
            }
            Ok(())
        }
        mowa_flow::Guard::AllOf { guards } | mowa_flow::Guard::AnyOf { guards } => {
            for g in guards {
                check_guard_facts_present(g, declared_facts, facts)?;
            }
            Ok(())
        }
        mowa_flow::Guard::Not { guard } => check_guard_facts_present(guard, declared_facts, facts),
    }
}

fn not_active(def: &FlowDefinition) -> KernelError {
    KernelError::FlowNotActive {
        flow_id: def.id.clone(),
        version: def.version.clone(),
    }
}
