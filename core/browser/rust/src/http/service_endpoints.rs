use super::routes::service::*;
use axum::{Router, routing::get};
pub(super) fn router() -> Router<MetadataState> {
    Router::new()
        .route("/", get(root).head(root))
        .route("/service", get(service).head(service).post(update_service))
        .route(
            "/service/storage-backends",
            get(storage_backends).head(storage_backends),
        )
}
