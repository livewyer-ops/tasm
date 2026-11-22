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
}
impl Settings {
    pub fn browser() -> Self {
        Self {
            api_version: "8.2".into(),
            service_version: env!("CARGO_PKG_VERSION").into(),
            service_name: "TASM".into(),
            service_description: "Browser-local Time Addressable Media Store".into(),
            min_object_timeout: "86400:0".into(),
            storage_allocation_max_objects: 1000,
            storage_object_id_max_length: 1024,
            worker_id: "tasm".into(),
            worker_max_requests: 20,
            worker_lease_seconds: 60,
            worker_queue_retention_seconds: 86400,
            worker_enable_delete: true,
            worker_enable_webhook: true,
            webhook_allow_private_targets: true,
            webhook_require_https: false,
            webhook_allowed_hosts: vec!["*".into()],
            webhook_max_attempts: 8,
            webhook_timeout_seconds: 10.0,
        }
    }
    /// Advertised allocation lifetime before the transfer grace period.
    pub fn min_object_timeout_seconds(&self) -> u64 {
        tasm_core::domain::timerange::timestamp(&self.min_object_timeout)
            .ok()
            .and_then(|nanos| u64::try_from(nanos.div_euclid(1_000_000_000)).ok())
            .unwrap_or(300)
    }
}

pub const SERVICE_TYPE: &str = "urn:x-tams:service.tasm";

pub const SIGNED_URLS: bool = false;
