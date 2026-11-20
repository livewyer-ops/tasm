pub use tasm_core::http::*;
#[path = "../../../../rust/src/routes/mod.rs"]
pub mod routes;
mod service_endpoints;
pub const MAX_JSON_BODY_BYTES: usize = 16 * 1024 * 1024;
use crate::{config::Settings, db::Database, storage::StorageFactory};
use axum::{Extension, Router, middleware::from_fn};
use std::sync::Arc;
pub fn router(database: Database, settings: Arc<Settings>) -> Router {
    let storage = StorageFactory::new(database.clone());
    routes::endpoints()
        .with_state(routes::service::MetadataState::new(database, settings))
        .layer(Extension(storage))
        .fallback(not_found)
        .layer(from_fn(normalize_framework_errors))
}
