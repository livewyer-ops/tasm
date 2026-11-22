pub use tasm_core::http::*;
#[path = "../../../../rust/src/routes/mod.rs"]
pub mod routes;
mod service_endpoints;
pub const MAX_JSON_BODY_BYTES: usize = 4 * 1024 * 1024;
use crate::{config::Settings, sql::Pool, storage::StorageFactory};
use axum::{Extension, Router, middleware::from_fn};
use std::sync::Arc;
pub fn router(pool: Pool, settings: Arc<Settings>) -> Router {
    let storage = StorageFactory::new(pool.clone());
    routes::endpoints()
        .route_layer(from_fn(authorise))
        .with_state(routes::service::MetadataState::new(pool, settings))
        .layer(Extension(storage))
        .fallback(not_found)
        .layer(from_fn(normalize_framework_errors))
}

async fn authorise(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::{http::Method, response::IntoResponse};
    let Some(actor) = request.extensions().get::<crate::Actor>() else {
        return error::ApiError::forbidden("Authentication identity is missing.").into_response();
    };
    let path = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|value| value.as_str())
        .unwrap_or("");
    let method = request.method();
    let read = matches!(*method, Method::GET | Method::HEAD);
    let allowed = if read
        && matches!(
            path,
            "/" | "/service"
                | "/service/storage-backends"
                | "/openapi.json"
                | "/healthz"
                | "/readyz"
        ) {
        ["tams-api/read", "tams-api/write", "tams-api/delete"]
            .iter()
            .any(|scope| actor.has(scope))
    } else {
        let scope = if path == "/flow-delete-requests"
            || path == "/service"
            || (method == Method::PUT && path == "/flows/{flowId}/read_only")
        {
            "tams-api/admin"
        } else if path.starts_with("/flow-delete-requests/")
            || (method == Method::DELETE
                && matches!(path, "/flows/{flowId}" | "/flows/{flowId}/segments"))
        {
            "tams-api/delete"
        } else if read {
            "tams-api/read"
        } else {
            "tams-api/write"
        };
        actor.has(scope)
    };
    if !allowed {
        let mut response = error::ApiError::forbidden("Insufficient API scope.").into_response();
        response.headers_mut().insert(
            axum::http::header::WWW_AUTHENTICATE,
            axum::http::HeaderValue::from_static("Bearer error=\"insufficient_scope\""),
        );
        return response;
    }
    next.run(request).await
}
