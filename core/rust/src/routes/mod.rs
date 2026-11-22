pub mod delete_requests;
pub mod flows;
pub mod objects;
pub mod profiles;
pub mod segments;
pub mod service;
pub mod sources;
pub mod storage;
pub mod webhooks;

use axum::{Router, routing::get};
use service::{MetadataState, root, service, storage_backends, update_service};

pub(super) fn endpoints() -> Router<MetadataState> {
    Router::new()
        .route("/", get(root).head(root))
        .route("/service", get(service).head(service).post(update_service))
        .route(
            "/service/storage-backends",
            get(storage_backends).head(storage_backends),
        )
        .merge(profiles::router())
        .merge(sources::router())
        .merge(flows::router())
        .merge(webhooks::router())
        .merge(segments::router())
        .merge(storage::router())
        .merge(delete_requests::router())
        .merge(objects::router())
}
