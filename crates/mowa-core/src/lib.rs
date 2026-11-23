//! MO·WA kernel core: a pure, deterministic reducer.
//!
//! `start(sessionId, event, flow, ctx) -> Commit` creates a session (version 0).
//! `advance(session, event, flow, facts, ctx) -> Commit` is the only other mutation.
//!
//! * No I/O, no clock, no randomness, no floats, no HashMap (see `clippy.toml`).
//! * Handlers run in the host; their outcomes arrive as `CanonicalEvent`s.
//! * The kernel never persists anything. It returns a `Commit` that the host writes
//!   atomically with compare-and-swap on `expected_session_version`.

mod advance;
mod error;
mod guard;
pub mod ids;
mod types;

pub use advance::{advance, start, AdvanceInput, StartInput};
pub use error::KernelError;
pub use guard::eval_guard;
pub use ids::{advance_dedup_key, start_dedup_key};
pub use types::*;

/// Recorded in every audit record. Bumped whenever any hash or id formula changes.
pub const KERNEL_VERSION: &str = env!("CARGO_PKG_VERSION");
