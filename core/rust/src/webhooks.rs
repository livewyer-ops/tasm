// Shared webhook delivery for both hosts, compiled into each adapter crate.
use serde_json::{Value, json};
use uuid::Uuid;

use tasm_core::webhook_target::{WebhookPolicy, validate_target};

impl crate::config::Settings {
    pub(crate) fn webhook_policy(&self) -> WebhookPolicy<'_> {
        WebhookPolicy {
            allow_private_targets: self.webhook_allow_private_targets,
            allowed_hosts: &self.webhook_allowed_hosts,
            require_https: self.webhook_require_https,
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
#[derive(serde::Deserialize)]
pub struct DeliveryResponse {
    pub status: u16,
    pub reason: String,
    #[serde(default)]
    redirected: bool,
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
    policy: &WebhookPolicy<'_>,
) -> Result<DeliveryResponse, WebhookError> {
    // Check the target again at delivery: the policy may have changed since
    // the webhook was registered.
    let map = webhook.as_object().ok_or(WebhookError::Restricted)?;
    validate_target(map, policy).map_err(|_| WebhookError::Restricted)?;
    let result = host
        .call(
            "webhook",
            json!({"id":id,"webhook":webhook,"payload_json":payload.to_string(),"timeout":timeout}),
        )
        .await?;
    DeliveryResponse::from_host(result)
}

impl DeliveryResponse {
    fn from_host(result: Value) -> Result<Self, WebhookError> {
        let invalid =
            || WebhookError::Request(crate::host::Error("Invalid webhook host reply".into()));
        let reply: Self = serde_json::from_value(result).map_err(|_| invalid())?;
        // Fetch reports an opaque manual redirect with status zero.
        if !(matches!(reply.status, 100..=599) || (reply.status == 0 && reply.redirected)) {
            return Err(invalid());
        }
        if reply.redirected || (300..400).contains(&reply.status) {
            return Err(WebhookError::Redirect);
        }
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_browser_and_cloudflare_replies() {
        for reply in [
            json!({"status": 204, "reason": "", "redirected": false}),
            json!({"status": 204, "reason": ""}),
        ] {
            let response = DeliveryResponse::from_host(reply).unwrap();
            assert_eq!(response.status, 204);
            assert_eq!(response.reason, "");
        }
        let response =
            DeliveryResponse::from_host(json!({"status": 503, "reason": "Busy"})).unwrap();
        assert_eq!(response.status, 503);
        assert_eq!(response.reason, "Busy");
    }

    #[test]
    fn recognises_http_and_opaque_redirects() {
        for reply in [
            json!({"status": 302, "reason": "Found"}),
            json!({"status": 0, "reason": "", "redirected": true}),
        ] {
            assert!(matches!(
                DeliveryResponse::from_host(reply),
                Err(WebhookError::Redirect)
            ));
        }
    }

    #[test]
    fn malformed_replies_follow_the_host_error_path() {
        for reply in [
            json!({"reason": "OK"}),
            json!({"status": 200}),
            json!({"status": "200", "reason": "OK"}),
            json!({"status": 65736, "reason": "OK"}),
            json!({"status": 0, "reason": ""}),
            json!({"status": 600, "reason": ""}),
            json!({"status": 204, "reason": "", "redirected": "false"}),
        ] {
            assert!(matches!(
                DeliveryResponse::from_host(reply),
                Err(WebhookError::Request(_))
            ));
        }
    }
}
