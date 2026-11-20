use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Clone, Debug, Default)]
pub struct WebhookPolicy {
    pub allow_private_targets: bool,
    pub allowed_hosts: Vec<String>,
}
#[derive(Debug, thiserror::Error)]
pub enum WebhookError {
    #[error("Webhook URL scheme is invalid")]
    Scheme,
    #[error("Webhook URL host is invalid")]
    Host,
    #[error("Webhook URL credentials are invalid")]
    Credentials,
    #[error("Webhook URL port is invalid")]
    Port,
    #[error("Webhook target is restricted")]
    Restricted,
    #[error("Webhook target resolution is restricted")]
    RestrictedResolution,
    #[error("Webhook redirects are not allowed")]
    Redirect,
    #[error(transparent)]
    Request(#[from] crate::pglite::Error),
}
pub struct DeliveryResponse {
    pub status: u16,
    pub reason: String,
}
pub fn retry_delay(attempt: u64) -> i64 {
    [30, 60, 120, 300][attempt.saturating_sub(1).min(3) as usize]
}
pub fn retriable_status(status: u16) -> bool {
    [408, 429, 500, 502, 503, 504].contains(&status)
}
pub async fn deliver(
    host: &crate::host::Host,
    id: Uuid,
    webhook: &Value,
    payload: &Value,
    timeout: f64,
    _: &WebhookPolicy,
) -> Result<DeliveryResponse, WebhookError> {
    let result = host
        .call(
            "webhook",
            json!({"id":id,"webhook":webhook,"payload_json":payload.to_string(),"timeout":timeout}),
        )
        .await?;
    let status = result["status"].as_u64().unwrap_or(0) as u16;
    if (300..400).contains(&status) {
        return Err(WebhookError::Redirect);
    }
    Ok(DeliveryResponse {
        status,
        reason: result["reason"].as_str().unwrap_or("").into(),
    })
}
