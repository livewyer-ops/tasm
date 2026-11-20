pub mod delete_requests;
pub mod flows;
pub mod objects;
pub mod profiles;
pub mod segments;
pub mod service;
pub mod sources;
pub mod storage;
pub mod webhooks;

use super::service_endpoints;
use axum::Router;
use service::MetadataState;

pub(super) fn endpoints() -> Router<MetadataState> {
    service_endpoints::router()
        .merge(profiles::router())
        .merge(sources::router())
        .merge(flows::router())
        .merge(webhooks::router())
        .merge(segments::router())
        .merge(storage::router())
        .merge(delete_requests::router())
        .merge(objects::router())
}
