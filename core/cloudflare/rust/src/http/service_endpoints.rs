use super::routes::service::*;
use crate::http::error::ApiError;
use axum::{
    Json,
    body::Body,
    extract::State,
    http::Request,
    response::{IntoResponse, Response},
};
use axum::{Router, routing::get};
use serde_json::Value;
pub(super) fn router() -> Router<MetadataState> {
    Router::new()
        .route("/", get(root).head(root))
        .route("/readyz", get(ready).head(ready))
        .route("/openapi.json", get(openapi).head(openapi))
        .route("/service", get(service).head(service).post(update_service))
        .route(
            "/service/storage-backends",
            get(storage_backends).head(storage_backends),
        )
}

async fn openapi(
    State(state): State<MetadataState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    let document = state
        .pool
        .0
        .call("openapi", Value::Null)
        .await
        .map_err(internal)?;
    Ok(Json(document).into_response())
}

async fn ready(
    State(state): State<MetadataState>,
    request: Request<Body>,
) -> Result<Response, ApiError> {
    query(&request, &[], &[])?;
    state
        .pool
        .0
        .call("ready", Value::Null)
        .await
        .map_err(internal)?;
    Ok("ok".into_response())
}
