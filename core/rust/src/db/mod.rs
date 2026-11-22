pub mod records;
pub mod transaction;
pub use records::*;

#[derive(Debug, thiserror::Error)]
#[error("invalid page token")]
pub struct InvalidPage;
