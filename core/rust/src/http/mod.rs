pub mod error;
pub mod paging;
pub mod query;
use axum::{
    body::to_bytes,
    extract::Request,
    http::{
        StatusCode,
        header::{ALLOW, CONTENT_TYPE, WWW_AUTHENTICATE},
    },
    middleware::Next,
    response::{IntoResponse, Response},
};
use error::ApiError;
use serde::de::DeserializeOwned;

pub fn path_uuid(value: &str) -> Result<uuid::Uuid, ApiError> {
    crate::domain::model::parse_uuid(value)
        .map_err(|_| ApiError::not_found("The requested resource identifier is invalid."))
}

#[derive(Clone)]
pub struct RawRequestTarget(pub axum::http::Uri);
pub fn lenient_decode_path(path: &str) -> String {
    percent_encoding::percent_decode_str(path)
        .decode_utf8_lossy()
        .into_owned()
}
pub async fn strict_json<T: DeserializeOwned>(
    request: Request,
    limit: usize,
) -> Result<T, ApiError> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if media_type != "application/json"
        && !(media_type.starts_with("application/") && media_type.ends_with("+json"))
    {
        return Err(ApiError::bad_request(
            "Invalid request: Content-Type must be application/json",
        ));
    }
    let bytes = to_bytes(request.into_body(), limit)
        .await
        .map_err(|_| ApiError::bad_request("Invalid request: Request body is too large"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| ApiError::bad_request(format!("Invalid request: {error}")))
}

pub async fn normalize_framework_errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    if !matches!(
        response.status(),
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
    ) || response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return response;
    }
    let status = response.status();
    let kind = if status == StatusCode::NOT_FOUND {
        "not_found"
    } else {
        "method_not_allowed"
    };
    let summary = if status == StatusCode::NOT_FOUND {
        "Not Found"
    } else {
        "Method Not Allowed"
    };
    let mut normalized = ApiError::new(status, kind, summary).into_response();
    for name in [ALLOW, WWW_AUTHENTICATE] {
        if let Some(value) = response.headers().get(&name) {
            normalized.headers_mut().insert(name, value.clone());
        }
    }
    normalized
}

pub async fn not_found() -> ApiError {
    ApiError::not_found("Not Found")
}
