// TASM browser adaptation of rust-tams-api (Apache-2.0); see NOTICE for changes.
use std::borrow::Cow;

use axum::{
    Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope {
    #[serde(rename = "type")]
    pub kind: Cow<'static, str>,
    pub summary: String,
    pub time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incident_id: Option<Uuid>,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub kind: Cow<'static, str>,
    pub summary: String,
    pub headers: Box<HeaderMap>,
    pub incident_id: Option<Uuid>,
}

impl ApiError {
    pub fn new(
        status: StatusCode,
        kind: impl Into<Cow<'static, str>>,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            status,
            kind: kind.into(),
            summary: summary.into(),
            headers: Box::new(HeaderMap::new()),
            incident_id: None,
        }
    }

    pub fn bad_request(summary: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", summary)
    }

    pub fn unauthorized(summary: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", summary)
    }

    pub fn forbidden(summary: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", summary)
    }

    pub fn not_found(summary: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", summary)
    }

    pub fn configuration(summary: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "configuration_error",
            summary,
        )
    }

    pub fn internal(cause: &dyn std::fmt::Display) -> Self {
        let incident_id = Uuid::new_v4();
        tracing::error!(%incident_id, error=%cause, "TAMS request failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            kind: "internal_server_error".into(),
            summary: "Internal server error".into(),
            headers: Box::new(HeaderMap::new()),
            incident_id: Some(incident_id),
        }
    }

    pub fn with_headers(mut self, headers: HeaderMap) -> Self {
        self.headers = Box::new(headers);
        self
    }

    pub fn envelope(&self) -> ErrorEnvelope {
        ErrorEnvelope {
            kind: self.kind.clone(),
            summary: self.summary.clone(),
            time: crate::now().format(&Rfc3339).expect("RFC3339 formatting"),
            incident_id: self.incident_id,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status;
        let headers = self.headers.as_ref().clone();
        (status, headers, Json(self.envelope())).into_response()
    }
}
