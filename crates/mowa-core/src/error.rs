use std::fmt;

use mowa_canon::CanonError;
use serde::Serialize;

/// Kernel faults. Domain contradictions (e.g. conflicts) are NOT errors:
/// they are routed by the flow (guard + `onGuardFail`) and yield a normal `Commit`.
/// Stale-session detection is the host's compare-and-swap on `expectedSessionVersion`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "code",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase"
)]
pub enum KernelError {
    FlowNotActive {
        flow_id: String,
        version: String,
    },
    /// `start` only: `asOf` is outside `[effectiveFrom, effectiveTo)`.
    OutsideEffectiveWindow {
        as_of: i64,
    },
    /// `start` only: the event's actor is not in the flow's `startActors`.
    StartUnauthorized {
        actor: String,
    },
    WorkflowMismatch {
        session: String,
        flow: String,
    },
    /// The supplied flow is not the exact flow the session is pinned to.
    FlowHashMismatch {
        session: String,
        flow: String,
    },
    CaseMismatch {
        session_case: String,
        event_case: String,
    },
    UnknownState {
        state: String,
    },
    SessionTerminal {
        state: String,
    },
    NoTransition {
        state: String,
        key: String,
    },
    Unauthorized {
        state: String,
        key: String,
        actor: String,
    },
    GuardNotSatisfied {
        state: String,
        key: String,
    },
    TimeRegressed {
        as_of: i64,
        session_updated_at: i64,
    },
    InvalidFactStatus {
        fact: String,
        status: String,
    },
    MissingRequiredFact {
        fact: String,
    },
    VersionOverflow,
    Serialization {
        reason: String,
    },
}

impl fmt::Display for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for KernelError {}

impl From<CanonError> for KernelError {
    fn from(e: CanonError) -> Self {
        KernelError::Serialization {
            reason: e.to_string(),
        }
    }
}
