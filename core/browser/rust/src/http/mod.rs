pub use tasm_core::http::*;
#[path = "../../../../rust/src/routes/mod.rs"]
pub mod routes;
mod service_endpoints;
pub const MAX_JSON_BODY_BYTES: usize = 16 * 1024 * 1024;
use crate::{config::Settings, sql::Pool, storage::StorageFactory};
use axum::{Extension, Router, middleware::from_fn};
use std::sync::Arc;
pub fn router(pool: Pool, settings: Arc<Settings>) -> Router {
    let storage = StorageFactory::new(pool.clone());
    routes::endpoints()
        .with_state(routes::service::MetadataState::new(pool, settings))
        .layer(Extension(storage))
        .fallback(not_found)
        .layer(from_fn(normalize_framework_errors))
}
