use crate::{domain::timerange, webhook_target::WebhookPolicy};

#[derive(serde::Deserialize)]
#[serde(default)]
pub struct Settings {
    pub api_version: String,
    pub service_version: String,
    pub service_name: String,
    pub service_description: String,
    pub min_object_timeout: String,
    pub storage_allocation_max_objects: u64,
    pub storage_object_id_max_length: u64,
    pub worker_id: String,
    pub worker_max_requests: u64,
    pub worker_lease_seconds: u64,
    pub worker_queue_retention_seconds: u64,
    pub worker_enable_delete: bool,
    pub worker_enable_webhook: bool,
    pub webhook_allow_private_targets: bool,
    pub webhook_allowed_hosts: Vec<String>,
    pub webhook_require_https: bool,
    pub webhook_max_attempts: u64,
    pub webhook_timeout_seconds: f64,
    #[serde(skip)]
    timeout_fallback_seconds: u64,
}
impl Settings {
    pub fn cloudflare() -> Self {
        Self {
            api_version: "8.2".into(),
            service_version: env!("CARGO_PKG_VERSION").into(),
            service_name: "TASM".into(),
            service_description: "Time Addressable Media Store on Cloudflare".into(),
            min_object_timeout: "86400:0".into(),
            storage_allocation_max_objects: 1000,
            storage_object_id_max_length: 1024,
            worker_id: "cf-tams-wasm".into(),
            worker_max_requests: 20,
            worker_lease_seconds: 60,
            worker_queue_retention_seconds: 86400,
            worker_enable_delete: true,
            worker_enable_webhook: true,
            webhook_allow_private_targets: false,
            webhook_require_https: true,
            webhook_allowed_hosts: vec![],
            webhook_max_attempts: 8,
            webhook_timeout_seconds: 10.0,
            timeout_fallback_seconds: 86400,
        }
    }
    pub fn browser() -> Self {
        Self {
            service_description: "Browser-local Time Addressable Media Store".into(),
            worker_id: "tasm".into(),
            webhook_allow_private_targets: true,
            webhook_allowed_hosts: vec!["*".into()],
            webhook_require_https: false,
            timeout_fallback_seconds: 300,
            ..Self::cloudflare()
        }
    }

    pub fn webhook_policy(&self) -> WebhookPolicy<'_> {
        WebhookPolicy {
            allow_private_targets: self.webhook_allow_private_targets,
            allowed_hosts: &self.webhook_allowed_hosts,
            require_https: self.webhook_require_https,
        }
    }

    /// Advertised allocation lifetime before the transfer grace period.
    pub fn min_object_timeout_seconds(&self) -> u64 {
        timerange::timestamp(&self.min_object_timeout)
            .ok()
            .and_then(|nanos| u64::try_from(nanos.div_euclid(1_000_000_000)).ok())
            .unwrap_or(self.timeout_fallback_seconds)
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self::cloudflare()
    }
}

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn browser_uses_its_local_delivery_policy_and_timeout_fallback() {
        let mut settings = Settings::browser();
        assert_eq!(settings.worker_id, "tasm");
        assert_eq!(
            settings.service_description,
            "Browser-local Time Addressable Media Store"
        );
        let policy = settings.webhook_policy();
        assert!(policy.allow_private_targets);
        assert!(!policy.require_https);
        assert_eq!(policy.allowed_hosts, ["*"]);
        assert_eq!(settings.min_object_timeout_seconds(), 86400);
        settings.min_object_timeout = "invalid".into();
        assert_eq!(settings.min_object_timeout_seconds(), 300);
    }

    #[test]
    fn partial_cloudflare_configuration_keeps_host_defaults() {
        let defaults: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(defaults.worker_id, "cf-tams-wasm");
        assert_eq!(
            defaults.service_description,
            "Time Addressable Media Store on Cloudflare"
        );
        assert!(defaults.webhook_allowed_hosts.is_empty());
        assert_eq!(defaults.min_object_timeout_seconds(), 86400);

        let settings: Settings = serde_json::from_str(
            r#"{"webhook_allowed_hosts":["receiver.example"],"min_object_timeout":"invalid"}"#,
        )
        .unwrap();
        let policy = settings.webhook_policy();
        assert!(!policy.allow_private_targets);
        assert!(policy.require_https);
        assert_eq!(policy.allowed_hosts, ["receiver.example"]);
        assert_eq!(settings.min_object_timeout_seconds(), 86400);
    }
}
