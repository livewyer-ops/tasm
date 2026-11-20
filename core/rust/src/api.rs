use crate::http;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::BTreeMap;
use tower::ServiceExt;
use wasm_bindgen::prelude::*;

#[derive(Clone, Deserialize)]
pub struct Actor {
    pub subject: String,
    pub scopes: Vec<String>,
}
impl Actor {
    pub fn has(&self, scope: &str) -> bool {
        self.scopes
            .iter()
            .any(|value| value == "tams-api/admin" || value == scope)
    }
}
pub trait RequestIdentity: DeserializeOwned {
    fn actor(self) -> Actor;
}
#[derive(Deserialize)]
struct WireRequest<Identity> {
    method: String,
    url: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
    #[serde(flatten)]
    identity: Identity,
}
#[derive(Serialize)]
struct WireResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

pub async fn request<Identity: RequestIdentity>(
    router: &Router,
    request_json: String,
) -> Result<String, JsValue> {
    let wire: WireRequest<Identity> = serde_json::from_str(&request_json).map_err(js_error)?;
    let mut builder = Request::builder()
        .method(wire.method.as_str())
        .uri(&wire.url);
    for (name, value) in wire.headers {
        builder = builder.header(name, value);
    }
    let mut request = builder
        .body(Body::from(wire.body.unwrap_or_default()))
        .map_err(js_error)?;
    request.extensions_mut().insert(wire.identity.actor());
    let uri = request.uri().clone();
    request.extensions_mut().insert(http::RawRequestTarget(uri));
    let response = router.clone().oneshot(request).await.map_err(js_error)?;
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, usize::MAX).await.map_err(js_error)?;
    let response = WireResponse {
        status: parts.status.as_u16(),
        headers: parts
            .headers
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_str().unwrap_or("").into()))
            .collect(),
        body: String::from_utf8(bytes.to_vec()).map_err(js_error)?,
    };
    serde_json::to_string(&response).map_err(js_error)
}
pub fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
