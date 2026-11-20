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
    pub webhook_delivery_concurrency: u64,
    pub webhook_max_attempts: u64,
    pub webhook_timeout_seconds: f64,
}
impl Settings {
    pub fn cloudflare() -> Self {
        Self {
            api_version: "8.2".into(),
            service_version: env!("CARGO_PKG_VERSION").into(),
            service_name: "CF TAMS Wasm experiment".into(),
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
            webhook_allowed_hosts: vec![],
            webhook_delivery_concurrency: 1,
            webhook_max_attempts: 8,
            webhook_timeout_seconds: 10.0,
        }
    }
    pub fn min_object_timeout_seconds(&self) -> u64 {
        86400
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self::cloudflare()
    }
}

pub const SERVICE_TYPE: &str = "urn:x-tams:service.cf-tams-wasm";

pub const SIGNED_URLS: bool = true;
