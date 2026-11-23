//! MO·WA kernel: a single dependency for the deterministic decision kernel.
//!
//! * [`canon`]: canonical JSON (RFC 8785, integers only) and SHA-256 helpers.
//! * [`flow`]: flow definitions, the guard language and the validator.
//! * [`core`]: the pure `start` and `advance` reducers. Its main items are also
//!   re-exported at the crate root.
//!
//! The hashing rules are specified in `docs/hashing-spec.md` in the repository.

pub use mowa_canon as canon;
pub use mowa_core as core;
pub use mowa_flow as flow;

pub use mowa_core::{advance, start, AdvanceInput, KernelError, StartInput, KERNEL_VERSION};
pub use mowa_flow::{FlowDefinition, ValidatedFlow};
