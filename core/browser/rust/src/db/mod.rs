pub mod dialect;
#[path = "../../../../rust/src/db/flows.rs"]
pub mod flows;
#[path = "../../../../rust/src/db/objects.rs"]
pub mod objects;
#[path = "../../../../rust/src/db/profiles.rs"]
pub mod profiles;
#[path = "../../../../rust/src/db/queues.rs"]
pub mod queues;
pub use tasm_core::db::*;
#[path = "../../../../rust/src/db/service.rs"]
pub mod service;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error(transparent)]
    Sqlx(#[from] crate::pglite::Error),
    #[error("invalid record: {0}")]
    Record(String),
    #[error("invalid page token")]
    Page,
}

#[derive(Clone)]
pub struct Database(pub crate::host::Host);
impl Database {
    pub async fn pool(&self) -> Result<crate::pglite::PgPool, DbError> {
        Ok(crate::pglite::PgPool(self.0.clone()))
    }
}

pub(crate) mod statements;
