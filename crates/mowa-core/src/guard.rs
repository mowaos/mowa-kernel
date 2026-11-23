use mowa_flow::Guard;

use crate::types::DecisionFacts;

/// Total, pure evaluation of a guard against the facts. Recursion depth is bounded
/// by `mowa_flow::MAX_GUARD_DEPTH`, enforced when the flow is validated.
pub fn eval_guard(guard: &Guard, facts: &DecisionFacts) -> bool {
    match guard {
        Guard::AllOf { guards } => guards.iter().all(|g| eval_guard(g, facts)),
        Guard::AnyOf { guards } => guards.iter().any(|g| eval_guard(g, facts)),
        Guard::Not { guard } => !eval_guard(guard, facts),
        Guard::StatusIs { target, status } => facts.facts.get(target).is_some_and(|s| s == status),
        Guard::NoneWithStatus { prefix, status } => !facts
            .facts
            .iter()
            .any(|(k, v)| k.starts_with(prefix) && v == status),
    }
}
