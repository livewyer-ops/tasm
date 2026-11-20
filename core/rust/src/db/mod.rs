pub mod records;
pub use records::*;

#[derive(Debug, thiserror::Error)]
#[error("invalid page token")]
pub struct InvalidPage;
