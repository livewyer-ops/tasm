// Shared webhook delivery for both hosts, compiled into each adapter crate.
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Clone, Debug, Default)]
pub struct WebhookPolicy {
    pub allow_private_targets: bool,
    pub allowed_hosts: Vec<String>,
    pub require_https: bool,
}
impl WebhookPolicy {
    pub fn from_settings(settings: &crate::config::Settings) -> Self {
        Self {
            allow_private_targets: settings.webhook_allow_private_targets,
            allowed_hosts: settings.webhook_allowed_hosts.clone(),
            require_https: settings.webhook_require_https,
        }
    }
}
#[derive(Debug, thiserror::Error)]
pub enum WebhookError {
    #[error("Webhook target is restricted")]
    Restricted,
    #[error("Webhook redirects are not allowed")]
    Redirect,
    #[error(transparent)]
    Request(#[from] crate::sql::Error),
}
pub struct DeliveryResponse {
    pub status: u16,
    pub reason: String,
}
pub fn destination_changed() -> Value {
    json!({"type":"WebhookReplaced","summary":"Webhook destination changed","time":crate::domain::model::timestamp(crate::now())})
}
pub fn retry_delay(attempt: u64) -> i64 {
    [30, 60, 120, 300][attempt.saturating_sub(1).min(3) as usize]
}
/// Statuses worth retrying. 401 and 403 are included because receivers often
/// return them briefly while rotating credentials.
pub fn retriable_status(status: u16) -> bool {
    [401, 403, 408, 429, 500, 502, 503, 504].contains(&status)
}
pub async fn deliver(
    host: &crate::host::Host,
    id: Uuid,
    webhook: &Value,
    payload: &Value,
    timeout: f64,
    policy: &WebhookPolicy,
) -> Result<DeliveryResponse, WebhookError> {
    // Check the target again at delivery: the policy may have changed since
    // the webhook was registered.
    let map = webhook.as_object().ok_or(WebhookError::Restricted)?;
    crate::webhook_target::validate_target(map, policy).map_err(|_| WebhookError::Restricted)?;
    let result = host
        .call(
            "webhook",
            json!({"id":id,"webhook":webhook,"payload_json":payload.to_string(),"timeout":timeout}),
        )
        .await?;
    let status = result["status"].as_u64().unwrap_or(0) as u16;
    if (300..400).contains(&status) || result["redirected"].as_bool() == Some(true) {
        return Err(WebhookError::Redirect);
    }
    Ok(DeliveryResponse {
        status,
        reason: result["reason"].as_str().unwrap_or("").into(),
    })
}
