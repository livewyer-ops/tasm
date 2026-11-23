pub mod records;
pub mod transaction;
pub use records::*;

#[derive(Debug, thiserror::Error)]
#[error("invalid page token")]
pub struct InvalidPage;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error(transparent)]
    Sqlx(#[from] crate::host::Error),
    #[error("conflicting Source collection")]
    ConflictingSourceCollection,
    #[error("invalid record: {0}")]
    Record(String),
}
